import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { recordAuditEvent } from '../audit/index.ts';
import type { PlatformConfig } from '../config.ts';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  generateManagedConfig,
  hasCompleteModelSettings,
  readManagedComposition,
  writeManagedConfig,
} from '../managed-config/index.ts';
import type { ManagedConfigInput, ManagedComposition } from '../managed-config/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { ensureUserVolumes } from './volumes.ts';

export interface StartUserContainerInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly config: Pick<
    PlatformConfig,
    'userImage' | 'seccompProfilePath' | 'managedConfigDir' | 'authority'
  >;
  readonly userId: string;
  readonly modelSettings: Omit<ManagedConfigInput['modelSettings'], 'apiKeyConfigured'>;
  readonly modelKey?: string | undefined;
  readonly permission: ManagedConfigInput['permission'];
  readonly signal?: AbortSignal;
}

export type StartResult =
  | { outcome: 'unconfigured' }
  | {
      outcome: 'starting' | 'running';
      containerId: string;
      upstreamHost: '127.0.0.1';
      upstreamPort: number;
    };

// Composition may load the installed Web profile; a hung helper must not retain home access.
const START_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAX_COMPOSITION_BYTES = 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Docker startup response');
  }
  // Boundary JSON is unknown; every field is checked by its consumer below.
  return value as Record<string, unknown>;
}

function containerId(value: unknown): string {
  const id = object(value).Id;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error('Invalid Docker container identity');
  }
  return id;
}

export function resolvedImageId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid Docker image identity');
  }
  return value;
}

function ownedContainer(
  value: unknown,
  name: string,
  userId: string,
  imageId: string,
): Record<string, unknown> {
  const row = object(value);
  const config = object(row.Config);
  if (
    row.Name !== `/${name}` ||
    row.Image !== imageId ||
    object(config.Labels)['dsh-team.user'] !== userId
  ) {
    throw new Error('Docker container ownership mismatch');
  }
  containerId(row);
  return row;
}

async function requireAbsent(client: DockerClient, name: string): Promise<void> {
  try {
    await client.json('GET', `/containers/${name}/json`);
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return;
    throw error;
  }
  throw new Error('Canonical user container already exists');
}

async function composition(
  client: DockerClient,
  cleanupClient: DockerClient,
  userId: string,
  home: string,
  imageId: string,
  seccomp: string,
): Promise<ManagedComposition> {
  const invocation = randomUUID();
  const name = `dsh-team-compose-${userId}-${invocation}`;
  const labels = {
    'dsh-team.user': userId,
    'dsh-team.role': 'managed-composition',
    'dsh-team.invocation': invocation,
  };
  let attempted = false;
  let id: string | undefined;
  let result: ManagedComposition | undefined;
  const failures: Error[] = [];
  try {
    await requireAbsent(client, name);
    attempted = true;
    result = await readManagedComposition(async (script) => {
      id = containerId(
        await client.json('POST', `/containers/create?name=${name}`, {
          Image: imageId,
          User: '1001',
          Env: ['DSH_HOME=/data/home', 'DSH_TELEMETRY_DISABLED=1'],
          Cmd: ['node', '--input-type=module', '-e', script],
          Labels: labels,
          HostConfig: {
            NetworkMode: 'none',
            Privileged: false,
            CapAdd: [],
            SecurityOpt: [`seccomp=${seccomp}`],
            Mounts: [{ Type: 'volume', Source: home, Target: '/data/home' }],
          },
        }),
      );
      const helper = ownedContainer(
        await client.json('GET', `/containers/${id}/json`),
        name,
        userId,
        imageId,
      );
      const helperLabels = object(object(helper.Config).Labels);
      if (
        helper.Id !== id ||
        helperLabels['dsh-team.role'] !== 'managed-composition' ||
        helperLabels['dsh-team.invocation'] !== invocation
      ) {
        throw new Error('Composition helper ownership mismatch');
      }
      await client.json('POST', `/containers/${id}/start`);
      const exit = object(
        await client.json('POST', `/containers/${id}/wait?condition=not-running`),
      );
      if (exit.StatusCode !== 0 || (exit.Error !== undefined && exit.Error !== null)) {
        throw new Error('Composition helper failed');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of client.logs(`/containers/${id}/logs?stdout=1&stderr=1`)) {
        size += chunk.data.length;
        if (size > MAX_COMPOSITION_BYTES) throw new Error('Composition output limit exceeded');
        if (chunk.stream === 'stdout') chunks.push(chunk.data);
      }
      return Buffer.concat(chunks).toString('utf8');
    });
  } catch {
    failures.push(new Error('Managed composition failed'));
  }
  if (attempted) {
    try {
      let found: unknown;
      try {
        found = await cleanupClient.json('GET', `/containers/${name}/json`);
      } catch (error) {
        if (!(error instanceof DockerHttpError && error.statusCode === 404)) throw error;
      }
      if (found !== undefined) {
        const row = ownedContainer(found, name, userId, imageId);
        const actualLabels = object(object(row.Config).Labels);
        const actualId = containerId(row);
        if (
          actualLabels['dsh-team.invocation'] !== invocation ||
          actualLabels['dsh-team.role'] !== 'managed-composition' ||
          (id !== undefined && actualId !== id)
        ) {
          throw new Error('Composition cleanup ownership mismatch');
        }
        await cleanupClient.json('DELETE', `/containers/${actualId}?force=true`);
      }
    } catch {
      failures.push(new Error('Managed composition cleanup failed'));
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  if (result === undefined) throw new Error('Managed composition missing');
  return result;
}

export function inspectUserContainerState(
  document: unknown,
  id: string,
  name: string,
  userId: string,
  imageId: string,
): boolean {
  const row = ownedContainer(document, name, userId, imageId);
  const running = object(row.State).Running;
  if (row.Id !== id || typeof running !== 'boolean')
    throw new Error('Container identity or state mismatch');
  return running;
}
export function inspectUserContainerEndpoint(
  document: unknown,
  id: string,
  name: string,
  userId: string,
  imageId: string,
): number {
  const row = ownedContainer(document, name, userId, imageId);
  if (row.Id !== id || object(row.State).Running !== true)
    throw new Error('Started container identity or state mismatch');
  const ports = object(object(row.NetworkSettings).Ports);
  const bindings: unknown = ports['3080/tcp'];
  if (Object.keys(ports).length !== 1 || !Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error('Invalid Docker loopback publication');
  }
  const binding = object(bindings[0]);
  const port = binding.HostPort;
  if (
    binding.HostIp !== '127.0.0.1' ||
    typeof port !== 'string' ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65535
  ) {
    throw new Error('Invalid Docker loopback endpoint');
  }
  return Number(port);
}

function validateModelEnvironment(name: string, key: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    ['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'NODE_OPTIONS', 'PATH', 'HOME', 'LD_PRELOAD'].includes(
      name,
    ) ||
    key.includes('\0')
  ) {
    throw new Error('Invalid model credential environment');
  }
}

async function readSeccompPolicy(path: string, signal: AbortSignal): Promise<string> {
  const policy = object(JSON.parse(await readFile(path, { encoding: 'utf8', signal })));
  if (
    typeof policy.defaultAction !== 'string' ||
    !/^SCMP_ACT_[A-Z_]+$/.test(policy.defaultAction) ||
    !Array.isArray(policy.syscalls)
  ) {
    throw new Error('Invalid seccomp policy');
  }
  return JSON.stringify(policy);
}

function startupFailure(stage: string, error: unknown): Error {
  // Retain only closed failure categories, never raw credential-bearing messages or causes.
  const cleanupFailed =
    error instanceof AggregateError &&
    error.errors.some(
      (failure: unknown) =>
        failure instanceof Error && failure.message === 'Managed composition cleanup failed',
    );
  return new Error(
    `Container startup failed during ${stage}${cleanupFailed ? '; managed composition cleanup failed' : ''}`,
    {
      cause: {
        stage,
        cleanupFailed,
        dockerStatus: error instanceof DockerHttpError ? error.statusCode : undefined,
      },
    },
  );
}

function currentStartup(
  input: StartUserContainerInput,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (
    !isDeepStrictEqual(
      input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId),
      account,
    ) ||
    !isDeepStrictEqual(
      input.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
      instance,
    )
  )
    throw new Error('Current startup identity changed');
}

async function reuseCurrentContainer(
  input: StartUserContainerInput,
  client: DockerClient,
  account: Record<string, unknown>,
  signal: AbortSignal,
): Promise<StartResult | undefined> {
  const selected: unknown = input.database
    .prepare('SELECT * FROM instances WHERE user_id = ?')
    .get(input.userId);
  if (selected === undefined) return undefined;
  const instance = object(selected);
  if (instance.status === 'stopped' && instance.container_id === null) return undefined;
  const id = containerId({ Id: instance.container_id });
  const image = resolvedImageId(instance.image_id);
  if (typeof instance.image_tag !== 'string' || instance.image_tag.length === 0)
    throw new Error('Invalid indexed image tag');
  let document: unknown;
  try {
    document = await client.json('GET', `/containers/${id}/json`);
  } catch (error) {
    if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
    currentStartup(input, account, instance, signal);
    return undefined;
  }
  if (instance.status !== 'starting' && instance.status !== 'running')
    throw new Error('Current instance is not reusable');
  const port = inspectUserContainerEndpoint(
    document,
    id,
    `dsh-team-u-${input.userId}`,
    input.userId,
    image,
  );
  if (
    instance.upstream_host !== '127.0.0.1' ||
    instance.upstream_port !== port ||
    typeof instance.last_started_at !== 'number' ||
    !Number.isSafeInteger(instance.last_started_at)
  )
    throw new Error('Current instance endpoint mismatch');
  currentStartup(input, account, instance, signal);
  return {
    outcome: instance.status,
    containerId: id,
    upstreamHost: '127.0.0.1',
    upstreamPort: port,
  };
}

function resourceLimit(value: number, unit: number): number {
  const limit = value * unit;
  // Docker interprets zero as unlimited; never round or overflow a persisted limit.
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Resource limit is not representable as a positive integral Docker value');
  return limit;
}

/** Create/start or validate current identity; readiness, cookies and retirement remain separate. */
export async function startUserContainer(input: StartUserContainerInput): Promise<StartResult> {
  let stage = 'account validation';
  try {
    const { database, config, userId } = input;
    if (!/^[a-z0-9]{12}$/.test(userId) || userId.length !== 12) throw new Error();
    const account: unknown = database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const user = object(account);
    if (user.status !== 'active' || typeof user.email !== 'string') throw new Error();
    const email = user.email;
    // Key availability comes only from the exact credential that will enter Env.
    if (input.modelKey === undefined || input.modelKey.trim() === '')
      return { outcome: 'unconfigured' };
    const modelSettings = { ...input.modelSettings, apiKeyConfigured: true };
    if (!hasCompleteModelSettings(modelSettings)) return { outcome: 'unconfigured' };
    stage = 'model environment validation';
    const envName = modelSettings.apiKeyEnv;
    validateModelEnvironment(envName, input.modelKey);
    stage = 'resource limits';
    const { cpuCores, memoryMiB } = readSettings(database);
    const nanoCpus = resourceLimit(cpuCores, 1_000_000_000);
    const memory = resourceLimit(memoryMiB, 1_048_576);
    const deadline = AbortSignal.timeout(START_TIMEOUT_MS);
    const signal =
      input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
    const client: DockerClient = {
      json: (method, path, body) => input.client.json(method, path, body, signal),
      logs: (path) => input.client.logs(path, signal),
    };
    const cleanupClient: DockerClient = {
      ...input.client,
      json: (method, path, body) =>
        input.client.json(method, path, body, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)),
    };
    const name = `dsh-team-u-${userId}`;
    stage = 'current container validation';
    signal.throwIfAborted();
    const reused = await reuseCurrentContainer(input, client, user, signal);
    if (reused !== undefined) return reused;
    stage = 'container conflict check';
    await requireAbsent(client, name);
    stage = 'seccomp policy';
    const seccomp = await readSeccompPolicy(config.seccompProfilePath, signal);
    stage = 'image resolution';
    const image = resolvedImageId(
      object(await client.json('GET', `/images/${encodeURIComponent(config.userImage)}/json`)).Id,
    );
    stage = 'owned volumes';
    const volumes = await ensureUserVolumes(client, userId);
    stage = 'managed composition';
    const observed = await composition(client, cleanupClient, userId, volumes.home, image, seccomp);
    stage = 'managed overlay';
    const generated = generateManagedConfig({
      ...observed,
      permission: input.permission,
      modelSettings,
    });
    if (generated.outcome === 'unconfigured') return generated;
    const overlay = await writeManagedConfig(config.managedConfigDir, userId, generated.content);
    stage = 'container creation';
    const id = containerId(
      await client.json('POST', `/containers/create?name=${name}`, {
        Image: image,
        Hostname: `u-${userId}`,
        User: '1001',
        WorkingDir: '/data/work',
        Env: ['DSH_HOME=/data/home', 'DSH_TELEMETRY_DISABLED=1', `${envName}=${input.modelKey}`],
        Cmd: [
          'dsh',
          '--profile',
          'web',
          '--patch',
          '/managed/patch.yml',
          '--no-open',
          '--trusted-host',
          config.authority,
        ],
        Labels: { 'dsh-team.user': userId },
        ExposedPorts: { '3080/tcp': {} },
        HostConfig: {
          NanoCpus: nanoCpus,
          Memory: memory,
          MemorySwap: memory,
          PidsLimit: 512,
          Privileged: false,
          CapAdd: [],
          SecurityOpt: [`seccomp=${seccomp}`],
          PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
          Mounts: [
            { Type: 'volume', Source: volumes.home, Target: '/data/home' },
            { Type: 'volume', Source: volumes.work, Target: '/data/work' },
            { Type: 'bind', Source: overlay, Target: '/managed/patch.yml', ReadOnly: true },
          ],
        },
      }),
    );
    stage = 'created container inspection';
    const created = ownedContainer(
      await client.json('GET', `/containers/${id}/json`),
      name,
      userId,
      image,
    );
    if (created.Id !== id) throw new Error('Created container identity mismatch');
    stage = 'creation persistence';
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO instances (user_id, status, container_id, image_tag, image_id)
        VALUES (?, 'starting', ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        status = 'starting', container_id = excluded.container_id, image_tag = excluded.image_tag, image_id = excluded.image_id,
        upstream_host = NULL, upstream_port = NULL, dsh_cookie = NULL, last_started_at = NULL, last_error = NULL`,
        )
        .run(userId, id, config.userImage, image);
      recordAuditEvent(database, {
        type: 'instance.created',
        createdAt: Date.now(),
        targetEmail: email,
        target: userId,
      });
    })();
    stage = 'container start';
    await client.json('POST', `/containers/${id}/start`);
    stage = 'started container inspection';
    const port = inspectUserContainerEndpoint(
      await client.json('GET', `/containers/${id}/json`),
      id,
      name,
      userId,
      image,
    );
    stage = 'start persistence';
    database.transaction(() => {
      const changed = database
        .prepare(
          `UPDATE instances SET upstream_host = '127.0.0.1', upstream_port = ?, last_started_at = ?
        WHERE user_id = ? AND container_id = ? AND status = 'starting'`,
        )
        .run(port, Date.now(), userId, id);
      if (changed.changes !== 1) throw new Error();
      recordAuditEvent(database, {
        type: 'instance.started',
        createdAt: Date.now(),
        targetEmail: email,
        target: userId,
      });
    })();
    return { outcome: 'starting', containerId: id, upstreamHost: '127.0.0.1', upstreamPort: port };
  } catch (error) {
    throw startupFailure(stage, error);
  }
}

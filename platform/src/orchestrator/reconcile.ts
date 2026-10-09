import type { DatabaseHandle } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { dshCookieExpiresAt, indexedEndpoint } from './credentials.ts';
import {
  assertCurrentSnapshot,
  inspectUserContainerEndpoint,
  inspectUserContainerState,
} from './start.ts';
import { containerId, isTerminalInstance, object, resolvedImageId } from './identity.ts';
import {
  attachPlatform,
  inspectPlatformAttachment,
  PlatformAttachmentFailedError,
  validateUserNetwork,
} from './networks.ts';
import type { OwnedNetwork } from './networks.ts';
import { stopUserContainer } from './stop.ts';
import { upstreamHost } from './transport.ts';
import type { TransportContext } from './transport.ts';

export interface ReconciliationInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly transport: TransportContext;
  readonly userId: string;
  readonly signal?: AbortSignal;
}

// Bound discovery independently of per-user retirement; no lifetime/global lifecycle lock.
const OPERATION_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;

async function bounded<Result>(
  caller: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, OPERATION_TIMEOUT_MS);
  const signal =
    caller === undefined ? deadline.signal : AbortSignal.any([caller, deadline.signal]);
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

async function discover(
  input: Omit<ReconciliationInput, 'userId'>,
  signal: AbortSignal,
): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: ['dsh-team.user'] }));
  const document = await input.client.json(
    'GET',
    `/containers/json?all=1&filters=${filters}`,
    undefined,
    signal,
    MAX_DISCOVERY_BYTES,
  );
  signal.throwIfAborted();
  if (!Array.isArray(document)) throw new Error();
  const users = new Set<string>();
  for (const candidate of document) {
    const row = object(candidate);
    containerId(row);
    const labels = object(row.Labels);
    const user = labels['dsh-team.user'];
    if (typeof user !== 'string' || !Array.isArray(row.Names)) throw new Error();
    if (!row.Names.every((name: unknown) => typeof name === 'string')) throw new Error();
    if (typeof row.State !== 'string') throw new Error();
    // Helpers and unindexed containers are discoveries, never mutation authority.
    if (labels['dsh-team.role'] === 'managed-composition') continue;
    if (row.Names.includes(`/dsh-team-u-${user}`) && /^[a-z0-9]{12}$/.test(user)) {
      if (input.database.prepare('SELECT 1 FROM instances WHERE user_id = ?').get(user))
        users.add(user);
    }
  }
  for (const row of input.database
    .prepare<[], { user_id: string }>('SELECT user_id FROM instances ORDER BY user_id')
    .all())
    users.add(row.user_id);
  return [...users];
}

export function discoverReconciliationUsers(
  input: Omit<ReconciliationInput, 'userId'>,
): Promise<string[]> {
  return bounded(input.signal, (signal) => discover(input, signal));
}

function validateIndexed(
  instance: Record<string, unknown>,
  transport: TransportContext,
): number | undefined {
  containerId({ Id: instance.container_id });
  resolvedImageId(instance.image_id);
  if (typeof instance.image_tag !== 'string' || instance.image_tag.length === 0) throw new Error();
  indexedEndpoint(instance, instance.status !== 'running', transport.config.upstreamMode);
  if (instance.dsh_cookie === null || instance.dsh_cookie === '') return undefined;
  if (typeof instance.dsh_cookie !== 'string') throw new Error();
  return dshCookieExpiresAt(instance.dsh_cookie);
}

async function restorePlatform(
  input: ReconciliationInput,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
  network: OwnedNetwork,
  client: DockerClient,
): Promise<true | 'retired'> {
  const id = containerId({ Id: instance.container_id });
  const image = resolvedImageId(instance.image_id);
  const name = `dsh-team-u-${input.userId}`;
  const current = () => {
    assertCurrentSnapshot(input, account, instance, signal);
  };
  async function verify(requirePlatform = false): Promise<void> {
    const after = await client.json('GET', `/containers/${id}/json`);
    if (!inspectUserContainerState(after, id, name, input.userId, image)) throw new Error();
    if (
      inspectUserContainerEndpoint(after, id, name, input.userId, image, 'network') !==
        instance.upstream_port ||
      upstreamHost(after, input.userId, 'network') !== instance.upstream_host
    )
      throw new Error('Instance endpoint changed during network recovery');
    const confirmed = await validateUserNetwork(
      client,
      input.userId,
      after,
      input.transport,
      network.id,
      false,
      requirePlatform,
    );
    if (confirmed.subnet !== network.subnet) throw new Error('Captured network subnet changed');
    current();
  }
  current();
  let attachmentFailed = false;
  try {
    await attachPlatform(input.client, input.transport, input.userId, id, network, current, verify);
  } catch (error) {
    if (!(error instanceof PlatformAttachmentFailedError)) throw error;
    attachmentFailed = true;
  }
  // Neither a pre-attach document nor a failed mutation grants authority over a changed survivor.
  await verify(!attachmentFailed);
  if (attachmentFailed) {
    // Retirement authority must still describe missing membership, not a subsequently recovered survivor.
    if (await inspectPlatformAttachment(client, input.transport, input.userId, id, network))
      throw new Error('Platform membership recovered after rejected connection');
    current();
    await stopUserContainer(
      { ...input, reason: 'error', signal },
      current,
      'Platform network recovery failed',
    );
    return 'retired';
  }
  return true;
}

async function healthy(
  input: ReconciliationInput,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
  expiresAt: number | undefined,
): Promise<boolean | 'retired'> {
  const id = containerId({ Id: instance.container_id });
  const image = resolvedImageId(instance.image_id);
  let document: unknown;
  try {
    document = await input.client.json('GET', `/containers/${id}/json`, undefined, signal);
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return false;
    throw error;
  }
  const name = `dsh-team-u-${input.userId}`;
  if (!inspectUserContainerState(document, id, name, input.userId, image)) return false;
  const port = inspectUserContainerEndpoint(
    document,
    id,
    name,
    input.userId,
    image,
    input.transport.config.upstreamMode,
  );
  const client: DockerClient = {
    ...input.client,
    json: (method, path, body, _signal, maxBytes) =>
      input.client.json(method, path, body, signal, maxBytes),
  };
  const network = await validateUserNetwork(
    client,
    input.userId,
    document,
    input.transport,
    undefined,
    false,
    false,
  );
  // Incomplete starting state can be retired, never promoted into a ready survivor.
  if (instance.upstream_port !== null && instance.upstream_port !== port) throw new Error();
  if (
    instance.upstream_host !== null &&
    instance.upstream_host !==
      upstreamHost(document, input.userId, input.transport.config.upstreamMode)
  )
    throw new Error();
  const survivor =
    account.status === 'active' && instance.status === 'running' && (expiresAt ?? 0) > Date.now();
  if (!survivor || input.transport.config.upstreamMode !== 'network') return survivor;
  return restorePlatform(input, account, instance, signal, network, client);
}

/** Called only while the owning per-user queue is held; retirement never re-enqueues itself. */
async function reconcile(input: ReconciliationInput, signal: AbortSignal): Promise<void> {
  const account = object(
    input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId),
  );
  const instance = object(
    input.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
  );
  if (isTerminalInstance(instance.status, instance.container_id)) return;
  const expiresAt = validateIndexed(instance, input.transport);
  const survivor = await healthy(input, account, instance, signal, expiresAt);
  if (survivor === 'retired') return;
  const current = () => {
    assertCurrentSnapshot(input, account, instance, signal);
  };
  current();
  if (survivor) return;
  await stopUserContainer({ ...input, reason: 'error', signal }, current);
}

export function reconcileUser(input: ReconciliationInput): Promise<void> {
  return bounded(input.signal, (signal) => reconcile(input, signal));
}

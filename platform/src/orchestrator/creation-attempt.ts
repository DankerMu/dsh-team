import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { containerId, object, ownedContainer, resolvedImageId } from './identity.ts';
import { captureUserNetwork, removeUserNetwork, validateUserNetwork } from './networks.ts';
import type { OwnedNetwork } from './networks.ts';
import { requireUnpublished, upstreamPort } from './transport.ts';
import type { TransportContext } from './transport.ts';
import { allocateSubnet } from './subnet.ts';

/** Only verified unknown-ID absence is nonfatal during reconciliation; callers still fail closed. */
export class CreationQuarantinedError extends Error {}

interface AttemptInput {
  readonly database: DatabaseHandle;
  readonly userId: string;
}

export interface CreationAttempt {
  readonly user_id: string;
  readonly attempt_id: string;
  readonly account_created_at: number;
  readonly image_id: string;
  readonly image_tag: string;
  readonly network_id: string;
  readonly network_subnet: string;
  readonly overlay_path: string;
  readonly upstream_mode: 'network' | 'published-loopback';
  readonly prior_instance_hash: string;
  readonly container_id: string | null;
  readonly created_at: number;
}

function validateRecoveryAttempt(attempt: CreationAttempt): void {
  containerId({ Id: attempt.network_id });
  resolvedImageId(attempt.image_id);
  if (attempt.container_id !== null) containerId({ Id: attempt.container_id });
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      attempt.attempt_id,
    ) ||
    !Number.isSafeInteger(attempt.account_created_at) ||
    !Number.isSafeInteger(attempt.created_at) ||
    attempt.created_at < 0 ||
    typeof attempt.image_tag !== 'string' ||
    attempt.image_tag.length === 0 ||
    !isAbsolute(attempt.overlay_path) ||
    allocateSubnet(attempt.network_subnet, []) !== attempt.network_subnet
  )
    throw new Error('Invalid durable creation provenance');
}

function instanceHash(input: AttemptInput): string {
  const row: unknown = input.database
    .prepare('SELECT * FROM instances WHERE user_id=?')
    .get(input.userId);
  // Only the digest is durable; the instance's credential never enters the attempt row.
  return createHash('sha256')
    .update(JSON.stringify(row ?? null))
    .digest('hex');
}

export function readCreationAttempt(input: AttemptInput): CreationAttempt | undefined {
  return input.database
    .prepare<[string], CreationAttempt>('SELECT * FROM creation_attempts WHERE user_id=?')
    .get(input.userId);
}

function currentAttempt(input: AttemptInput, attempt: CreationAttempt): void {
  if (
    !isDeepStrictEqual(readCreationAttempt(input), attempt) ||
    instanceHash(input) !== attempt.prior_instance_hash
  )
    throw new Error('Container creation identity changed');
}

export function beginCreationAttempt(
  input: AttemptInput & { readonly transport: TransportContext },
  account: Record<string, unknown>,
  network: OwnedNetwork,
  image: string,
  imageTag: string,
  overlay: string,
): CreationAttempt {
  const attempt: CreationAttempt = {
    user_id: input.userId,
    attempt_id: randomUUID(),
    account_created_at: Number(account.created_at),
    image_id: image,
    image_tag: imageTag,
    network_id: network.id,
    network_subnet: network.subnet,
    overlay_path: overlay,
    upstream_mode: input.transport.config.upstreamMode,
    prior_instance_hash: instanceHash(input),
    container_id: null,
    created_at: Date.now(),
  };
  input.database.transaction(() => {
    if (
      !isDeepStrictEqual(
        input.database.prepare('SELECT * FROM users WHERE id=?').get(input.userId),
        account,
      )
    )
      throw new Error('Current startup account changed');
    input.database
      .prepare(
        `INSERT INTO creation_attempts VALUES
        (@user_id,@attempt_id,@account_created_at,@image_id,@image_tag,@network_id,
         @network_subnet,@overlay_path,@upstream_mode,@prior_instance_hash,@container_id,@created_at)`,
      )
      .run(attempt);
  })();
  return attempt;
}

export function bindCreatedContainer(
  input: AttemptInput,
  attempt: CreationAttempt,
  id: string,
): CreationAttempt {
  containerId({ Id: id });
  currentAttempt(input, attempt);
  if (attempt.container_id !== null && attempt.container_id !== id)
    throw new Error('Created container identity changed');
  const changed = input.database
    .prepare('UPDATE creation_attempts SET container_id=? WHERE user_id=? AND attempt_id=?')
    .run(id, input.userId, attempt.attempt_id);
  if (changed.changes !== 1) throw new Error('Creation attempt missing');
  return { ...attempt, container_id: id };
}

/** Called inside the creation-row/audit transaction, before replacing its prior row. */
export function consumeCreationAttempt(
  input: AttemptInput,
  attempt: CreationAttempt,
  account: Record<string, unknown>,
): void {
  currentAttempt(input, attempt);
  if (
    !isDeepStrictEqual(
      input.database.prepare('SELECT * FROM users WHERE id=?').get(input.userId),
      account,
    )
  )
    throw new Error('Current startup account changed');
  input.database
    .prepare('DELETE FROM creation_attempts WHERE user_id=? AND attempt_id=?')
    .run(input.userId, attempt.attempt_id);
}

function validateMounts(document: Record<string, unknown>, attempt: CreationAttempt): void {
  const mounts = object(document.HostConfig).Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 3) throw new Error('Creation mounts changed');
  const expected = new Map([
    ['/data/home', ['volume', `dsh-team-home-${attempt.user_id}`, false]],
    ['/data/work', ['volume', `dsh-team-work-${attempt.user_id}`, false]],
    ['/managed/patch.yml', ['bind', attempt.overlay_path, true]],
  ]);
  for (const value of mounts) {
    const mount = object(value);
    if (typeof mount.Target !== 'string') throw new Error('Creation mount target changed');
    const selected = expected.get(mount.Target);
    if (
      selected === undefined ||
      mount.Type !== selected[0] ||
      mount.Source !== selected[1] ||
      (mount.ReadOnly ?? false) !== selected[2]
    )
      throw new Error('Creation mount identity changed');
    expected.delete(mount.Target);
  }
}

function validateCreationPublication(row: Record<string, unknown>, attempt: CreationAttempt): void {
  requireUnpublished(row, attempt.upstream_mode);
  if (attempt.upstream_mode !== 'published-loopback') return;
  const bindings = object(object(row.HostConfig).PortBindings);
  const selected = bindings['3080/tcp'];
  if (
    Object.keys(bindings).length !== 1 ||
    !Array.isArray(selected) ||
    selected.length !== 1 ||
    object(selected[0]).HostIp !== '127.0.0.1' ||
    object(selected[0]).HostPort !== ''
  )
    throw new Error('Creation publication changed');
  const ports = object(object(row.NetworkSettings).Ports);
  if (Object.values(ports).some((value) => value !== null)) upstreamPort(row, 'published-loopback');
}

function validateCreated(document: unknown, attempt: CreationAttempt): string {
  const row = ownedContainer(
    document,
    `dsh-team-u-${attempt.user_id}`,
    attempt.user_id,
    resolvedImageId(attempt.image_id),
  );
  const id = containerId(row);
  const config = object(row.Config);
  const state = object(row.State);
  const host = object(row.HostConfig);
  if (
    (attempt.container_id !== null && id !== attempt.container_id) ||
    object(config.Labels)['dsh-team.creation-attempt'] !== attempt.attempt_id ||
    config.User !== '1001' ||
    state.Running !== false ||
    state.Status !== 'created' ||
    state.StartedAt !== '0001-01-01T00:00:00Z' ||
    host.NetworkMode !== attempt.network_id ||
    host.Privileged !== false ||
    host.PublishAllPorts === true
  )
    throw new Error('Creation provenance or never-started state changed');
  validateMounts(row, attempt);
  validateCreationPublication(row, attempt);
  return id;
}

async function inspect(client: DockerClient, identity: string): Promise<unknown> {
  try {
    return await client.json('GET', `/containers/${identity}/json`);
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return undefined;
    throw error;
  }
}

/** A durable receipt, never discovery alone, authorizes recovery of a never-started attempt. */
export async function recoverCreationAttempt(
  input: AttemptInput & {
    readonly client: DockerClient;
    readonly transport: TransportContext;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  const selected = readCreationAttempt(input);
  if (selected === undefined) return false;
  validateRecoveryAttempt(selected);
  let attempt: CreationAttempt = selected;
  const account = object(
    input.database.prepare('SELECT * FROM users WHERE id=?').get(input.userId),
  );
  if (
    account.created_at !== attempt.account_created_at ||
    attempt.upstream_mode !== input.transport.config.upstreamMode
  )
    throw new Error('Creation account or transport changed');
  const settlement = AbortSignal.timeout(10_000);
  const admission =
    input.signal === undefined ? settlement : AbortSignal.any([input.signal, settlement]);
  let submitted = false;
  const current = () => {
    (submitted ? settlement : admission).throwIfAborted();
    currentAttempt(input, attempt);
    if (
      !isDeepStrictEqual(
        input.database.prepare('SELECT * FROM users WHERE id=?').get(input.userId),
        account,
      )
    )
      throw new Error('Current recovery account changed');
  };
  const client: DockerClient = {
    ...input.client,
    json: (method, path, body, _signal, maxBytes) =>
      input.client.json(method, path, body, settlement, maxBytes),
  };
  current();
  const name = `dsh-team-u-${input.userId}`;
  const named = await inspect(client, name);
  current();
  if (named !== undefined) {
    const id = validateCreated(named, attempt);
    const exact = await inspect(client, id);
    if (validateCreated(exact, attempt) !== id) throw new Error('Created identity changed');
    const network = await validateUserNetwork(
      client,
      input.userId,
      exact,
      input.transport,
      attempt.network_id,
      true,
    );
    if (network.subnet !== attempt.network_subnet) throw new Error('Created network changed');
    current();
    attempt = bindCreatedContainer(input, attempt, id);
    const fresh = await inspect(client, id);
    if (validateCreated(fresh, attempt) !== id) throw new Error('Created identity changed');
    await validateUserNetwork(
      client,
      input.userId,
      fresh,
      input.transport,
      attempt.network_id,
      true,
    );
    current();
    submitted = true;
    await client.json('DELETE', `/containers/${id}`);
  } else if (attempt.container_id === null) {
    // A missing response can precede late server-side creation; absence is not settlement proof.
    const network = await captureUserNetwork(
      client,
      input.userId,
      input.transport,
      undefined,
      attempt.network_id,
    );
    if (network !== undefined && network.subnet !== attempt.network_subnet)
      throw new Error('Captured creation network changed');
    current();
    throw new CreationQuarantinedError('Container creation outcome unconfirmed');
  }
  current();
  if (
    attempt.container_id === null ||
    (await inspect(client, attempt.container_id)) !== undefined ||
    (await inspect(client, name)) !== undefined
  )
    throw new Error('Created container removal unconfirmed');
  current();
  await removeUserNetwork(client, input.userId, input.transport, current, undefined, {
    id: attempt.network_id,
    subnet: attempt.network_subnet,
  });
  input.database.transaction(() => {
    current();
    consumeCreationAttempt(input, attempt, account);
    input.database
      .prepare(
        `INSERT INTO instances(user_id,status,last_error)
      VALUES (?, 'error', 'Interrupted container creation recovered') ON CONFLICT(user_id) DO UPDATE SET
      status='error',container_id=NULL,image_id=NULL,image_tag=NULL,upstream_host=NULL,
      upstream_port=NULL,dsh_cookie=NULL,last_error=excluded.last_error`,
      )
      .run(input.userId);
    recordAuditEvent(input.database, {
      type: 'instance.start-failed',
      createdAt: Date.now(),
      targetEmail: String(account.email),
      target: input.userId,
    });
  })();
  return true;
}

import type { DatabaseHandle } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { indexedEndpoint, validateDshCookie } from './credentials.ts';
import {
  assertCurrentSnapshot,
  containerId,
  inspectUserContainerEndpoint,
  inspectUserContainerState,
  object,
  resolvedImageId,
} from './start.ts';
import { stopUserContainer } from './stop.ts';

interface ReconciliationInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
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

function validateIndexed(instance: Record<string, unknown>): void {
  containerId({ Id: instance.container_id });
  resolvedImageId(instance.image_id);
  if (typeof instance.image_tag !== 'string' || instance.image_tag.length === 0) throw new Error();
  indexedEndpoint(instance, instance.status !== 'running');
  if (instance.dsh_cookie !== null && instance.dsh_cookie !== '') {
    if (typeof instance.dsh_cookie !== 'string') throw new Error();
    validateDshCookie(instance.dsh_cookie);
  }
}

async function healthy(
  input: ReconciliationInput,
  account: Record<string, unknown>,
  instance: Record<string, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
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
  const port = inspectUserContainerEndpoint(document, id, name, input.userId, image);
  // Incomplete starting state can be retired, never promoted into a ready survivor.
  if (instance.upstream_port !== null && instance.upstream_port !== port) throw new Error();
  return (
    account.status === 'active' &&
    instance.status === 'running' &&
    typeof instance.dsh_cookie === 'string' &&
    instance.dsh_cookie.length > 0
  );
}

/** Called only while the owning per-user queue is held; retirement never re-enqueues itself. */
async function reconcile(input: ReconciliationInput, signal: AbortSignal): Promise<void> {
  const account = object(
    input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId),
  );
  const instance = object(
    input.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
  );
  if (instance.status === 'stopped' && instance.container_id === null) return;
  validateIndexed(instance);
  const survivor = await healthy(input, account, instance, signal);
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

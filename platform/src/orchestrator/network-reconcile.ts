import { isDeepStrictEqual } from 'node:util';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { object } from './identity.ts';
import { captureUserNetwork, inspectedNetwork, removeUserNetwork } from './networks.ts';
import type { OwnedNetwork } from './networks.ts';
import type { ReconciliationInput } from './reconcile.ts';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
export interface NetworkCandidate extends OwnedNetwork {
  readonly userId: string;
}

export async function discoverReconciliationNetworks(
  input: Omit<ReconciliationInput, 'userId'>,
): Promise<NetworkCandidate[]> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
  const filters = encodeURIComponent(JSON.stringify({ label: ['dsh-team.user'] }));
  const document = await input.client.json(
    'GET',
    `/networks?filters=${filters}`,
    undefined,
    signal,
    MAX_BYTES,
  );
  signal.throwIfAborted();
  if (!Array.isArray(document)) throw new Error('Invalid Docker network inventory');
  const candidates: NetworkCandidate[] = [];
  const users = new Set<string>();
  for (const entry of document) {
    const row = object(entry);
    if (row.Labels === null || row.Labels === undefined) continue;
    const userId = object(row.Labels)['dsh-team.user'];
    if (userId === undefined) continue;
    if (typeof userId !== 'string' || !/^[a-z0-9]{12}$/.test(userId) || users.has(userId))
      throw new Error('Invalid owned network inventory');
    candidates.push({ ...inspectedNetwork(row, userId), userId });
    users.add(userId);
  }
  return candidates;
}

/** Network-only candidates use the owner's existing per-user queue and never manufacture index rows. */
export async function reconcileOrphanNetwork(
  input: ReconciliationInput,
  captured: NetworkCandidate,
): Promise<void> {
  input.signal?.throwIfAborted();
  // Submitted disconnect/delete retain independent bounded settlement ownership after caller cancellation.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const client: DockerClient = {
    ...input.client,
    json: (method, path, body, _signal, maxBytes) =>
      input.client.json(method, path, body, signal, maxBytes),
  };
  const account = input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId);
  const instance = input.database
    .prepare('SELECT * FROM instances WHERE user_id = ?')
    .get(input.userId);
  const current = () => {
    signal.throwIfAborted();
    if (
      !isDeepStrictEqual(
        account,
        input.database.prepare('SELECT * FROM users WHERE id = ?').get(input.userId),
      ) ||
      !isDeepStrictEqual(
        instance,
        input.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(input.userId),
      )
    )
      throw new Error('Current orphan network identity changed');
  };
  const targets = new Set([`dsh-team-u-${input.userId}`]);
  if (instance !== undefined && object(instance).container_id !== null) {
    const id = object(instance).container_id;
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      throw new Error('Invalid indexed container');
    targets.add(id);
  }
  async function containersAbsent(): Promise<boolean> {
    for (const target of targets) {
      try {
        await client.json('GET', `/containers/${target}/json`);
        return false;
      } catch (error) {
        if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
      }
    }
    return true;
  }
  if (!(await containersAbsent())) return;
  if (instance !== undefined && object(instance).status === 'starting')
    throw new Error('Starting instance cannot authorize orphan deletion');
  const validate = async () => {
    current();
    if (!(await containersAbsent())) throw new Error('Corresponding container appeared');
    const network = await captureUserNetwork(
      client,
      input.userId,
      input.transport,
      undefined,
      captured.id,
    );
    if (network !== undefined && network.subnet !== captured.subnet)
      throw new Error('Captured network subnet changed');
    // Canonical observation is not proof that the captured ID has the same identity.
    try {
      const exact = await client.json('GET', `/networks/${captured.id}`);
      if (
        network === undefined ||
        inspectedNetwork(exact, input.userId, captured.id).subnet !== captured.subnet
      )
        throw new Error('Captured network identity changed');
      if (
        !isDeepStrictEqual(
          object(exact).Containers,
          object(await client.json('GET', `/networks/dsh-team-net-${input.userId}`)).Containers,
        )
      )
        throw new Error('Network endpoint views changed');
    } catch (error) {
      if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
      if (network !== undefined)
        throw new Error('Captured network disappeared inconsistently', { cause: error });
    }
    current();
  };
  await validate();
  await removeUserNetwork(
    client,
    input.userId,
    input.transport,
    current,
    undefined,
    captured,
    validate,
  );
  await validate();
  current();
}

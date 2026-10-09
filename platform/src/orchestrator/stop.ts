import { recordAuditEvent, validateStopReason } from '../audit/index.ts';
import type { InstanceStopReason } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { inspectUserContainerEndpoint, inspectUserContainerState } from './start.ts';
import { object, resolvedImageId } from './identity.ts';
import { indexedEndpoint } from './credentials.ts';
import { attachedNetwork, captureUserNetwork, removeUserNetwork } from './networks.ts';
import { requireUnpublished, upstreamHost } from './transport.ts';
import type { TransportContext } from './transport.ts';

export interface StopUserContainerInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly transport: TransportContext;
  readonly userId: string;
  readonly reason: InstanceStopReason;
  readonly signal?: AbortSignal;
}

interface Selection {
  containerId: string;
  imageId: string;
  email: string;
  upstreamHost: string | null;
  upstreamPort: number | null;
  identity: (string | number | null)[];
}

interface RetirementRow {
  status: string;
  container_id: string | null;
  image_id: string | null;
  image_tag: string | null;
  upstream_host: string | null;
  upstream_port: number | null;
  dsh_cookie: string | null;
  last_started_at: number | null;
  email: string;
  account_status: string;
}

interface FencedRetirementInput extends StopUserContainerInput {
  readonly assertCurrent?: () => void;
}

// A hung daemon must not retain retirement indefinitely; grace fits inside the whole operation.
const STOP_TIMEOUT_MS = 10_000;
const CURRENT_RETIREMENT = `user_id = ? AND container_id = ? AND image_id = ?
  AND image_tag IS ? AND status = ? AND upstream_host IS ? AND upstream_port IS ?
  AND dsh_cookie IS ? AND last_started_at IS ?
  AND EXISTS (SELECT 1 FROM users WHERE id = instances.user_id AND email = ? AND status = ?)`;

function select(input: StopUserContainerInput): Selection | undefined {
  if (!/^[a-z0-9]{12}$/.test(input.userId)) throw new Error();
  const row: unknown = input.database
    .prepare(
      `SELECT instances.*, users.email, users.status AS account_status
      FROM instances JOIN users ON users.id = instances.user_id WHERE user_id = ?`,
    )
    .get(input.userId);
  if (typeof row !== 'object' || row === null) throw new Error();
  // The schema constrains nullable endpoint/history fields; validate the mutation identities here.
  const instance = row as RetirementRow;
  if (instance.status === 'stopped' && instance.container_id === null) return undefined;
  const id = instance.container_id;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error();
  const imageId = resolvedImageId(instance.image_id);
  if (typeof instance.email !== 'string') throw new Error();
  const endpoint =
    input.transport.config.upstreamMode === 'network'
      ? indexedEndpoint(object(row), true, 'network')
      : instance;
  return {
    containerId: id,
    imageId,
    email: instance.email,
    upstreamHost: endpoint.upstream_host,
    upstreamPort: endpoint.upstream_port,
    identity: [
      input.userId,
      id,
      imageId,
      instance.image_tag,
      instance.status,
      instance.upstream_host,
      instance.upstream_port,
      instance.dsh_cookie,
      instance.last_started_at,
      instance.email,
      instance.account_status,
    ],
  };
}

function current(input: FencedRetirementInput, selection: Selection, signal: AbortSignal): void {
  signal.throwIfAborted();
  input.assertCurrent?.();
  if (
    input.database
      .prepare(`SELECT 1 FROM instances WHERE ${CURRENT_RETIREMENT}`)
      .get(...selection.identity) === undefined
  )
    throw new Error();
}

async function running(
  input: StopUserContainerInput,
  selection: Selection,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  let document: unknown;
  try {
    document = await input.client.json(
      'GET',
      `/containers/${selection.containerId}/json`,
      undefined,
      signal,
    );
  } catch (error) {
    if (error instanceof DockerHttpError && error.statusCode === 404) return undefined;
    throw error;
  }
  const state = inspectUserContainerState(
    document,
    selection.containerId,
    `dsh-team-u-${input.userId}`,
    input.userId,
    selection.imageId,
  );
  if (input.transport.config.upstreamMode === 'network') {
    if (state) {
      const port = inspectUserContainerEndpoint(
        document,
        selection.containerId,
        `dsh-team-u-${input.userId}`,
        input.userId,
        selection.imageId,
        input.transport.config.upstreamMode,
      );
      const host = upstreamHost(document, input.userId, input.transport.config.upstreamMode);
      if (
        (selection.upstreamPort !== null && selection.upstreamPort !== port) ||
        (selection.upstreamHost !== null && selection.upstreamHost !== host)
      )
        throw new Error('Indexed network endpoint changed before retirement');
    } else {
      requireUnpublished(document, input.transport.config.upstreamMode);
      attachedNetwork(document, input.userId, undefined, true);
    }
  }
  return state;
}

async function remove(
  input: FencedRetirementInput,
  selection: Selection,
  signal: AbortSignal,
): Promise<void> {
  current(input, selection, signal);
  let state = await running(input, selection, signal);
  if (state === true) {
    current(input, selection, signal);
    try {
      await input.client.json(
        'POST',
        `/containers/${selection.containerId}/stop?t=1`,
        undefined,
        signal,
      );
    } catch (error) {
      // A concurrent stop/removal is acceptable only after the exact ID is observed again below.
      if (!(error instanceof DockerHttpError) || ![304, 404].includes(error.statusCode))
        throw error;
    }
    state = await running(input, selection, signal);
  }
  if (state === true) throw new Error();
  current(input, selection, signal);
  if (state === undefined) return;
  try {
    await input.client.json('DELETE', `/containers/${selection.containerId}`, undefined, signal);
  } catch (error) {
    if (!(error instanceof DockerHttpError) || error.statusCode !== 404) throw error;
  }
  // Do not trust a successful but ineffective removal or an ambiguous non-404 response.
  if ((await running(input, selection, signal)) !== undefined) throw new Error();
}

function commit(
  input: FencedRetirementInput,
  selection: Selection,
  reason: InstanceStopReason,
  signal: AbortSignal,
): void {
  input.database.transaction(() => {
    current(input, selection, signal);
    const changed = input.database
      .prepare(
        `UPDATE instances SET status = 'stopped',
      container_id = NULL, image_id = NULL, image_tag = NULL, upstream_host = NULL,
      upstream_port = NULL, dsh_cookie = NULL WHERE ${CURRENT_RETIREMENT}`,
      )
      .run(...selection.identity);
    if (changed.changes !== 1) throw new Error();
    recordAuditEvent(input.database, {
      type: 'instance.stopped',
      createdAt: Date.now(),
      targetEmail: selection.email,
      target: input.userId,
      details: { reason },
    });
  })();
}

/** Verified absence plus stopped/audit commit returns true; no-op returns false; volumes remain. */
export async function stopUserContainer(
  input: StopUserContainerInput,
  assertCurrent?: () => void,
): Promise<boolean> {
  const fenced: FencedRetirementInput =
    assertCurrent === undefined ? input : { ...input, assertCurrent };
  const work = new AbortController();
  const timer = setTimeout(() => {
    work.abort();
  }, STOP_TIMEOUT_MS);
  try {
    const reason = input.reason;
    validateStopReason(reason);
    const signal =
      input.signal === undefined ? work.signal : AbortSignal.any([input.signal, work.signal]);
    signal.throwIfAborted();
    const selection = select(input);
    if (selection === undefined) return false;
    let networkSignal = signal;
    const networkClient: DockerClient = {
      ...input.client,
      json: (method, path, body, _signal, maxBytes) =>
        input.client.json(method, path, body, networkSignal, maxBytes),
    };
    const state = await running(input, selection, signal);
    const network = await captureUserNetwork(
      networkClient,
      input.userId,
      input.transport,
      state === undefined ? undefined : selection.containerId,
    );
    current(fenced, selection, signal);
    await remove(fenced, selection, signal);
    // After exact user removal, platform detach/inspect settlement retains ownership despite caller abort.
    if (input.transport.config.upstreamMode === 'network') networkSignal = work.signal;
    if (network === undefined) {
      if ((await captureUserNetwork(networkClient, input.userId, input.transport)) !== undefined)
        throw new Error();
    } else {
      await removeUserNetwork(
        networkClient,
        input.userId,
        input.transport,
        () => {
          current(fenced, selection, networkSignal);
        },
        undefined,
        network,
      );
    }
    commit(fenced, selection, reason, signal);
    return true;
  } catch {
    // Neither Docker response bodies, database errors nor backend credentials escape this boundary.
    throw new Error('User container retirement failed');
  } finally {
    clearTimeout(timer);
    work.abort();
  }
}

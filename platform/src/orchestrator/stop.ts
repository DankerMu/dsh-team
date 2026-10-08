import { recordAuditEvent, validateStopReason } from '../audit/index.ts';
import type { InstanceStopReason } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { DockerHttpError } from './client.ts';
import type { DockerClient } from './client.ts';
import { inspectUserContainerState, resolvedImageId } from './start.ts';

export interface StopUserContainerInput {
  readonly client: DockerClient;
  readonly database: DatabaseHandle;
  readonly userId: string;
  readonly reason: InstanceStopReason;
  readonly signal?: AbortSignal;
}

interface Selection {
  containerId: string;
  imageId: string;
  email: string;
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
  return {
    containerId: id,
    imageId,
    email: instance.email,
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
  return inspectUserContainerState(
    document,
    selection.containerId,
    `dsh-team-u-${input.userId}`,
    input.userId,
    selection.imageId,
  );
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

/** Retires only the captured current container; persistent user volumes are never removed. */
export async function stopUserContainer(
  input: StopUserContainerInput,
  assertCurrent?: () => void,
): Promise<void> {
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
    if (selection === undefined) return;
    await remove(fenced, selection, signal);
    commit(fenced, selection, reason, signal);
  } catch {
    // Neither Docker response bodies, database errors nor backend credentials escape this boundary.
    throw new Error('User container retirement failed');
  } finally {
    clearTimeout(timer);
    work.abort();
  }
}

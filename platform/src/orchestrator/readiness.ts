import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { recordAuditEvent } from '../audit/index.ts';
import { DockerHttpError } from './client.ts';
import type { AcquireDshCookieInput, IndexedInstance } from './credentials.ts';
import { acquireCurrentDshCookie, CURRENT_INSTANCE, currentInstance } from './credentials.ts';
import { startupLogTail } from './readiness-logs.ts';
import { inspectUserContainerEndpoint, inspectUserContainerState } from './start.ts';

const READINESS_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const LOG_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 250;

interface Selection {
  input: AcquireDshCookieInput;
  instance: IndexedInstance;
  identity: (string | number | null)[];
  cookie: string | null;
  acquired: boolean;
}

function current(
  selection: Selection,
  credential = false,
): { email: string; cookie: string | null } {
  const { input, identity } = selection;
  const row: unknown = input.database
    .prepare(
      `SELECT dsh_cookie, (SELECT email FROM users WHERE id = user_id) AS email
      FROM instances WHERE ${CURRENT_INSTANCE}${credential ? ' AND dsh_cookie IS ?' : ''}`,
    )
    .get(...identity, ...(credential ? [selection.cookie] : []));
  if (
    typeof row !== 'object' ||
    row === null ||
    !('email' in row) ||
    typeof row.email !== 'string' ||
    !('dsh_cookie' in row) ||
    (row.dsh_cookie !== null && typeof row.dsh_cookie !== 'string')
  )
    throw new Error('Current instance changed');
  return { email: row.email, cookie: row.dsh_cookie };
}

async function inspected(selection: Selection, signal: AbortSignal): Promise<unknown> {
  return selection.input.client.json(
    'GET',
    `/containers/${selection.instance.container_id}/json`,
    undefined,
    signal,
  );
}

function running(selection: Selection, document: unknown): boolean {
  return inspectUserContainerState(
    document,
    selection.instance.container_id,
    `dsh-team-u-${selection.input.userId}`,
    selection.input.userId,
    selection.instance.image_id,
  );
}

async function authenticatedHomepage(
  port: number,
  authority: string,
  cookie: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let incoming: IncomingMessage | undefined;
  const outgoing = request(
    {
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/',
      headers: { Host: authority, Cookie: cookie },
      signal,
      maxHeaderSize: 8 * 1024,
    },
    (response) => {
      incoming = response;
      resolve(!signal.aborted && response.statusCode === 200);
      response.destroy();
    },
  );
  // A refused/reset connection is transient only while the shared deadline remains live.
  outgoing.on('error', () => {
    resolve(false);
  });
  try {
    outgoing.end();
    return await promise;
  } finally {
    incoming?.destroy();
    outgoing.destroy();
  }
}

async function observe(selection: Selection, signal: AbortSignal): Promise<void> {
  const { input, instance } = selection;
  if (instance.upstream_port === null || instance.last_started_at === null)
    throw new Error('Started instance endpoint unavailable');
  current(selection);
  selection.cookie = await acquireCurrentDshCookie({ ...input, signal });
  selection.acquired = true;
  current(selection, true);
  for (;;) {
    signal.throwIfAborted();
    current(selection, true);
    const port = inspectUserContainerEndpoint(
      await inspected(selection, signal),
      instance.container_id,
      `dsh-team-u-${input.userId}`,
      input.userId,
      instance.image_id,
    );
    if (port !== instance.upstream_port) throw new Error('Current endpoint changed');
    if (await authenticatedHomepage(port, input.authority, selection.cookie, signal)) break;
    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
  // A 200 response must not race a stopped/replaced instance or a changed backend credential.
  const document = await inspected(selection, signal);
  if (!running(selection, document)) throw new Error('Instance exited before readiness');
  const port = inspectUserContainerEndpoint(
    document,
    instance.container_id,
    `dsh-team-u-${input.userId}`,
    input.userId,
    instance.image_id,
  );
  if (port !== instance.upstream_port) throw new Error('Current endpoint changed');
  signal.throwIfAborted();
  input.database.transaction(() => {
    const { email } = current(selection, true);
    const changed = input.database
      .prepare(
        `UPDATE instances SET status = 'running', last_error = NULL
        WHERE ${CURRENT_INSTANCE} AND dsh_cookie IS ?`,
      )
      .run(...selection.identity, selection.cookie);
    if (changed.changes !== 1) throw new Error('Current instance changed');
    recordAuditEvent(input.database, {
      type: 'instance.ready',
      createdAt: Date.now(),
      targetEmail: email,
      target: input.userId,
    });
  })();
}

async function monitor(selection: Selection, signal: AbortSignal): Promise<void> {
  for (;;) {
    await delay(POLL_INTERVAL_MS, undefined, { signal });
    current(selection, selection.acquired);
    if (!running(selection, await inspected(selection, signal)))
      throw new Error('Owned instance exited during startup');
  }
}

function cleanupCurrent(selection: Selection): boolean {
  const row = current(selection);
  // Acquisition legitimately clears the old credential; an unrelated replacement cookie is not ours.
  return row.cookie === selection.cookie || (!selection.acquired && row.cookie === null);
}

async function fail(selection: Selection, reason: string): Promise<string> {
  const cleanup = new AbortController();
  const timer = setTimeout(() => {
    cleanup.abort();
  }, CLEANUP_TIMEOUT_MS);
  const logDeadline = new AbortController();
  const logTimer = setTimeout(() => {
    logDeadline.abort();
  }, LOG_TIMEOUT_MS);
  const signal = cleanup.signal;
  let stop = 'container already stopped';
  let tail: string[];
  try {
    if (!cleanupCurrent(selection)) return 'newer credential preserved';
    tail = await startupLogTail(
      selection.input.client,
      selection.instance.container_id,
      AbortSignal.any([signal, logDeadline.signal]),
      selection.cookie === null ? [] : [selection.cookie],
    );
    clearTimeout(logTimer);
    if (!cleanupCurrent(selection)) return 'newer credential preserved';
    try {
      if (running(selection, await inspected(selection, signal))) {
        if (!cleanupCurrent(selection)) return 'newer credential preserved';
        try {
          await selection.input.client.json(
            'POST',
            `/containers/${selection.instance.container_id}/stop?t=1`,
            undefined,
            signal,
          );
        } catch (error) {
          if (!(error instanceof DockerHttpError) || error.statusCode !== 304) throw error;
        }
        if (running(selection, await inspected(selection, signal))) throw new Error();
        stop = 'container stopped';
      }
    } catch {
      // A daemon/ownership error is observable without claiming that the container stopped.
      stop = 'container stop failed or unconfirmed';
    }
    if (!cleanupCurrent(selection)) return 'newer credential preserved';
    const lastError = `${reason}; ${stop}\n${tail.join('\n')}`;
    selection.input.database.transaction(() => {
      const { email } = current(selection);
      if (!cleanupCurrent(selection)) throw new Error();
      const changed = selection.input.database
        .prepare(
          `UPDATE instances SET status = 'error', dsh_cookie = NULL, last_error = ?
          WHERE ${CURRENT_INSTANCE} AND (dsh_cookie IS ? OR (? = 0 AND dsh_cookie IS NULL))`,
        )
        .run(lastError, ...selection.identity, selection.cookie, Number(selection.acquired));
      if (changed.changes !== 1) throw new Error();
      recordAuditEvent(selection.input.database, {
        type: 'instance.start-failed',
        createdAt: Date.now(),
        targetEmail: email,
        target: selection.input.userId,
      });
    })();
    return stop;
  } catch {
    return 'cleanup current-instance check or persistence failed';
  } finally {
    clearTimeout(logTimer);
    clearTimeout(timer);
    logDeadline.abort();
    cleanup.abort();
  }
}

/** Readiness is separate from creation/start and credential acquisition; never returns secrets. */
export async function waitForUserContainerReady(input: AcquireDshCookieInput): Promise<void> {
  const work = new AbortController();
  const timer = setTimeout(() => {
    work.abort();
  }, READINESS_TIMEOUT_MS);
  const signal =
    input.signal === undefined ? work.signal : AbortSignal.any([input.signal, work.signal]);
  let selection: Selection | undefined;
  let owned = false;
  let watching: Promise<void> | undefined;
  const observer = { failed: false };
  let reason = 'DSH readiness failed before selecting an owned instance';
  try {
    const instance = currentInstance(input, true);
    selection = {
      input,
      instance,
      cookie: null,
      acquired: false,
      identity: [
        input.userId,
        instance.container_id,
        instance.upstream_host,
        instance.upstream_port,
        instance.image_tag,
        instance.image_id,
        instance.last_started_at,
      ],
    };
    selection.cookie = current(selection).cookie;
    const document = await inspected(selection, signal);
    const live = running(selection, document);
    current(selection);
    owned = true;
    reason = 'DSH readiness failed during startup';
    if (!live) throw new Error();
    watching = monitor(selection, signal).catch(() => {
      if (!signal.aborted) {
        observer.failed = true;
        work.abort();
      }
    });
    reason = 'DSH readiness failed during authentication, observation or persistence';
    await observe(selection, signal);
  } catch {
    if (observer.failed) reason = 'DSH readiness failed: owned instance exited or changed';
    else if (signal.aborted) reason = 'DSH readiness failed: deadline or cancellation';
    // Stop all work before independent cleanup, including a pending log or HTTP observer.
    work.abort();
    await watching;
    const cleanup =
      owned && selection !== undefined ? await fail(selection, reason) : 'not selected';
    throw new Error(`${reason}; ${cleanup}`);
  } finally {
    clearTimeout(timer);
    work.abort();
    await watching;
  }
}

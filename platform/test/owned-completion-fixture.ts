import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { mappedRpc } from '../../scripts/probe-mapped-host.mjs';
import { record } from './docker-cleanup.ts';

// A fresh container network namespace holds only DSH Web's 3080; this port is never contended.
const PORT = 39099;
// Outside any type:module package, so the extension selects ESM (as the idle adapter does).
const RECORDER = '/data/home/owned-completion-recorder.mjs';
export const OWNED_COMPLETION_LEDGER = '/data/home/owned-completion-ledger.json';
export const OWNED_COMPLETION_URL = `http://127.0.0.1:${String(PORT)}/v1`;
const REPLY = 'dsh-team owned completion reply';

/** uid1001 Node script installing the recorder plugin into the mounted home volume. */
export function ownedCompletionInstallScript(): string {
  const source = readFileSync(new URL('./owned-completion-recorder.js', import.meta.url), 'utf8');
  return `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(RECORDER)}, ${JSON.stringify(source)}, { mode: 0o644 });
process.stdout.write(JSON.stringify({ installed: true }));`;
}

/**
 * Overlay rows loading the in-container recorder as the configured provider's endpoint. Title
 * generation is disabled so the one prompt is the only model request the recorder can see.
 */
export function ownedCompletionRows(): readonly unknown[] {
  return [
    { id: 'session-title-llm', disabled: true },
    {
      insert: [
        {
          id: 'owned-completion-recorder',
          name: RECORDER,
          config: { port: PORT, ledger: OWNED_COMPLETION_LEDGER, reply: REPLY },
        },
      ],
    },
  ];
}

/** Native Session RPC returning only a successful result value. */
export type SessionRpc = (method: string, args: unknown) => Promise<Record<string, unknown>>;

export function mappedSessionRpc(origin: string, cookie: string): SessionRpc {
  return async (method, args) => {
    const result = record(await mappedRpc(origin, cookie, method, args));
    if (result.ok !== true || result.status !== 200)
      throw new Error(`Owned Session RPC ${method} failed`);
    return record(result.value);
  };
}

/** The complete event history of a short Session through the released projection/page RPC. */
export async function sessionEvents(
  rpc: SessionRpc,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const projection = await rpc('session/projections', { request: { sessionId } });
  const page = await rpc('session/page', {
    request: {
      address: { kind: 'session', sessionId },
      throughSeq: projection.asOfSeq,
      maxMessages: 100,
    },
  });
  if (!Array.isArray(page.records) || page.hasMore !== false)
    throw new Error('Incomplete owned Session history');
  return page.records.map((row: unknown) => record(record(row).event));
}

/** The prompt, the recorder's reply and a completed turn end are all native history events. */
export function ownedTurnCompleted(events: readonly Record<string, unknown>[], prompt: string) {
  const end = events.find((event) => event.type === 'turn/end');
  if (end === undefined) return false;
  if (record(record(end.data).reason).kind !== 'completed')
    throw new Error('Owned Session turn did not complete');
  const carries = (type: string, text: string) =>
    events.some((event) => event.type === type && JSON.stringify(event.data).includes(text));
  if (!carries('user/message', prompt) || !carries('assistant/message', REPLY))
    throw new Error('Owned Session turn content missing');
  return true;
}

/** Creates one real Session and completes exactly one deterministic prompt within 60s. */
export async function completeOwnedTurn(rpc: SessionRpc, prompt: string): Promise<string> {
  const created = await rpc('session/create', {
    request: { cwd: '/data/work', agentPreset: 'standard' },
  });
  if (typeof created.sessionId !== 'string') throw new Error('Missing owned Session');
  const sessionId = created.sessionId;
  const accepted = await rpc('session/prompt', {
    request: {
      sessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      mode: 'queue',
    },
  });
  if (accepted.accepted !== true) throw new Error('Owned Session prompt not accepted');
  const signal = AbortSignal.timeout(60_000);
  while (!ownedTurnCompleted(await sessionEvents(rpc, sessionId), prompt))
    await delay(250, undefined, { signal });
  return sessionId;
}

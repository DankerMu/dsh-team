import { randomUUID } from 'node:crypto';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';

export type TaskState = 'idle' | 'busy' | 'unknown';

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  // The boundary guard proves a JSON object with unknown-valued fields.
  return value as Record<string, unknown>;
}

/** Only the pinned complete, matching Session-list response is authoritative. */
export function taskStateFromResponse(document: unknown, rpcId: string): TaskState {
  const envelope = object(document);
  const result = object(envelope?.result);
  const value = object(result?.value);
  const items = value?.items;
  if (
    envelope?.type !== 'server-response' ||
    envelope.rpcId !== rpcId ||
    result?.ok !== true ||
    !Array.isArray(items)
  )
    return 'unknown';
  let busy = false;
  for (const item of items) {
    const session = object(item);
    if (typeof session?.running !== 'boolean') return 'unknown';
    busy ||= session.running;
  }
  return busy ? 'busy' : 'idle';
}

/** The rc.2 list is unpaginated. Partial or unbounded observations never establish idle. */
export async function readTaskState(input: {
  readonly host: string;
  readonly port: number;
  readonly cookie: string;
  readonly authority: string;
  readonly publicUrl: string;
  readonly signal: AbortSignal;
}): Promise<TaskState> {
  if (input.signal.aborted) return 'unknown';
  const rpcId = randomUUID();
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'session/list',
    payload: { args: { _request: {} } },
  });
  const work = new AbortController();
  // Covers headers and the entire body; inactivity alone is not a deadline.
  const timer = setTimeout(() => {
    work.abort();
  }, 2_000);
  const signal = AbortSignal.any([input.signal, work.signal]);
  const result = Promise.withResolvers<TaskState>();
  let incoming: IncomingMessage | undefined;
  let outgoing: ClientRequest | undefined;
  try {
    outgoing = request(
      {
        hostname: input.host,
        port: input.port,
        method: 'POST',
        path: '/api/session/list',
        headers: {
          Host: input.authority,
          Origin: input.publicUrl,
          Cookie: input.cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        signal,
        maxHeaderSize: 8 * 1024,
      },
      (response) => {
        incoming = response;
        response.on('error', () => {
          result.resolve('unknown');
        });
        response.on('aborted', () => {
          result.resolve('unknown');
        });
        if (response.statusCode !== 200) {
          result.resolve('unknown');
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          // A complete large list may be unknown; never accept a truncated prefix.
          if (bytes > 1024 * 1024) {
            result.resolve('unknown');
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (signal.aborted || !response.complete) {
            result.resolve('unknown');
            return;
          }
          try {
            const document: unknown = JSON.parse(Buffer.concat(chunks).toString());
            result.resolve(taskStateFromResponse(document, rpcId));
          } catch {
            // JSON/error details can contain private Session content.
            result.resolve('unknown');
          }
        });
        response.on('close', () => {
          result.resolve('unknown');
        });
      },
    );
    outgoing.on('error', () => {
      result.resolve('unknown');
    });
    outgoing.end(body);
    return await result.promise;
  } catch {
    // Invalid endpoint/header construction and transport failures are unavailable observations.
    return 'unknown';
  } finally {
    clearTimeout(timer);
    incoming?.destroy();
    outgoing?.destroy();
  }
}

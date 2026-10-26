import { performance } from 'node:perf_hooks';
import { hasCompleteModelSnapshot } from '../managed-config/index.ts';
import type { ModelSnapshot } from '../managed-config/index.ts';

/** Overall bound through the end of the response body; the route always uses this value. */
export const MODEL_PROBE_DEADLINE_MS = 20_000;
// A completion with max_tokens 1 is far smaller; a larger body is not a model endpoint answer.
const BODY_LIMIT = 65_536;

export const MODEL_PROBE_RESULTS = [
  'ok',
  'unconfigured',
  'unauthorized',
  'not-found',
  'rejected',
  'server-error',
  'bad-response',
  'timeout',
  'unreachable',
  'invalid-address',
  'invalid-key',
] as const;
type ModelProbeResult = (typeof MODEL_PROBE_RESULTS)[number];
export interface ModelProbeOutcome {
  readonly result: ModelProbeResult;
  readonly httpStatus: number | null;
  readonly elapsedMs: number;
}
type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;

function unsent(result: ModelProbeResult): ModelProbeOutcome {
  return { result, httpStatus: null, elapsedMs: 0 };
}

/** DSH's OpenAI client appends the path to the verbatim base URL; nothing is trimmed or resolved. */
function completionUrl(address: string): URL | null {
  let url: URL;
  try {
    url = new URL(
      address.endsWith('/') ? address + 'chat/completions' : address + '/chat/completions',
    );
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/** Returns the body text, or null once it exceeds the limit (the rest is cancelled, not read). */
async function readLimited(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  // Fetch bodies are byte streams; Node's global typing leaves their chunk type as any.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      // Cancellation failure only concerns an already-rejected response.
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}

function hasChoices(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'choices' in value &&
    Array.isArray(value.choices)
  );
}

async function classify(response: Response): Promise<ModelProbeResult> {
  const status = response.status;
  if (status >= 200 && status < 300) {
    const text = await readLimited(response);
    return text !== null && hasChoices(text) ? 'ok' : 'bad-response';
  }
  // Only a 2xx body is inspected; others are released without reading.
  response.body?.cancel().catch(() => undefined);
  if (status < 400) return 'bad-response';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return status < 500 ? 'rejected' : 'server-error';
}

function buildRequest(snapshot: ModelSnapshot): Request | ModelProbeResult {
  const url = completionUrl(snapshot.modelSettings.baseURL);
  if (url === null) return 'invalid-address';
  let headers: Headers;
  try {
    headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${snapshot.modelKey}`,
    });
  } catch {
    // The rejection text quotes the key; only the fixed code leaves this function.
    return 'invalid-key';
  }
  try {
    return new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: snapshot.modelSettings.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      redirect: 'manual',
    });
  } catch {
    // fetch refuses parsed URLs that carry credentials.
    return 'invalid-address';
  }
}

/**
 * Sends one completion request built exactly as a new instance would use the saved settings.
 * External cancellation rejects; every other outcome is a closed-set result without upstream text.
 */
export async function probeModel(
  snapshot: ModelSnapshot,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<ModelProbeOutcome> {
  if (!hasCompleteModelSnapshot(snapshot)) return unsent('unconfigured');
  const request = buildRequest(snapshot);
  if (typeof request === 'string') return unsent(request);
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, deadlineMs);
  const started = performance.now();
  let httpStatus: number | null = null;
  let result: ModelProbeResult;
  try {
    const response = await send(request, { signal: AbortSignal.any([signal, deadline.signal]) });
    httpStatus = response.status;
    result = await classify(response);
  } catch {
    // Cancellation by the route owner is not a probe outcome; transport causes carry host:port.
    signal.throwIfAborted();
    result = deadline.signal.aborted ? 'timeout' : 'unreachable';
  } finally {
    clearTimeout(timer);
  }
  return { result, httpStatus, elapsedMs: Math.max(0, Math.round(performance.now() - started)) };
}

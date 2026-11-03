import { readLimited } from '../bounded-body.ts';

/** Per-request bound through the end of the response body; the route always uses this value. */
export const RAGFLOW_TIMEOUT_MS = 10_000;
// Version and one-row list answers are tiny; a larger body is not a RAGFlow answer.
const BODY_LIMIT = 65_536;
/** Shown on the administrator page; anything else from upstream is not echoed. */
export const RAGFLOW_VERSION_PATTERN = '^[\\x20-\\x7e]{1,64}$';
const VERSION = new RegExp(RAGFLOW_VERSION_PATTERN);

export const RAGFLOW_TEST_RESULTS = [
  'ok',
  'not-configured',
  'unavailable',
  'timeout',
  'upstream-error',
] as const;
type RagflowFailure = Exclude<(typeof RAGFLOW_TEST_RESULTS)[number], 'ok'>;
type RagflowTestOutcome =
  { readonly result: 'ok'; readonly version: string } | { readonly result: RagflowFailure };
interface RagflowConnection {
  readonly baseURL: string;
  readonly apiKey: string;
}
type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
/** The `data` member of a RAGFlow envelope whose `code` is 0. */
interface Answer {
  readonly data: unknown;
}

/** The saved address is `isRagflowBaseUrl`-checked, so the path never lands in a query or fragment. */
function endpoint(baseURL: string, path: string): URL {
  let end = baseURL.length;
  while (end > 0 && baseURL[end - 1] === '/') end -= 1;
  return new URL(baseURL.slice(0, end) + path);
}

function envelope(text: string | null): Answer | RagflowFailure {
  if (text === null) return 'upstream-error';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'upstream-error';
  }
  if (typeof value !== 'object' || value === null || !('code' in value)) return 'upstream-error';
  if (typeof value.code !== 'number') return 'upstream-error';
  // RAGFlow v1.0.0-rc2 reports a rejected key as code 401; other codes are not guessed.
  if (value.code === 401) return 'not-configured';
  return value.code === 0 ? { data: 'data' in value ? value.data : undefined } : 'upstream-error';
}

async function classify(response: Response): Promise<Answer | RagflowFailure> {
  const status = response.status;
  if (status >= 200 && status < 300) return envelope(await readLimited(response, BODY_LIMIT));
  // Only a 2xx body is inspected; others are released without reading.
  response.body?.cancel().catch(() => undefined);
  return status === 401 || status === 403 ? 'not-configured' : 'upstream-error';
}

/** One GET with its own deadline; external cancellation rejects instead of becoming a result. */
async function call(
  request: Request,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send,
): Promise<Answer | RagflowFailure> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, deadlineMs);
  try {
    const response = await send(request, { signal: AbortSignal.any([signal, deadline.signal]) });
    return await classify(response);
  } catch {
    // Cancellation by the route owner is not a test outcome; transport causes carry host:port.
    signal.throwIfAborted();
    return deadline.signal.aborted ? 'timeout' : 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the unauthenticated version, then lists one dataset with the saved key: the version
 * endpoint alone cannot reveal a rejected key. Every outcome is a closed-set result without
 * upstream text; only a valid version string leaves this function.
 */
export async function testRagflowConnection(
  settings: RagflowConnection,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<RagflowTestOutcome> {
  if (settings.baseURL === '' || settings.apiKey === '') return { result: 'not-configured' };
  let headers: Headers;
  try {
    headers = new Headers({ Authorization: `Bearer ${settings.apiKey}` });
  } catch {
    // The rejection text quotes the key; only the fixed result leaves this function.
    return { result: 'not-configured' };
  }
  const version = await call(
    new Request(endpoint(settings.baseURL, '/api/v1/system/version'), { redirect: 'manual' }),
    signal,
    deadlineMs,
    send,
  );
  if (typeof version === 'string') return { result: version };
  if (typeof version.data !== 'string' || !VERSION.test(version.data))
    return { result: 'upstream-error' };
  const list = await call(
    new Request(endpoint(settings.baseURL, '/api/v1/datasets?page=1&page_size=1'), {
      headers,
      redirect: 'manual',
    }),
    signal,
    deadlineMs,
    send,
  );
  return typeof list === 'string' ? { result: list } : { result: 'ok', version: version.data };
}

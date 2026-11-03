import { readLimited } from '../bounded-body.ts';

/** Per-request bound through the end of the response body; the route always uses this value. */
export const RAGFLOW_TIMEOUT_MS = 10_000;
// Version and one-row list answers are tiny; a larger body is not a RAGFlow answer.
const BODY_LIMIT = 65_536;
/**
 * The complete dataset list. Every rc2 row repeats the dataset's and its owner's base64 avatars,
 * so large avatars can exceed this; the list then fails as upstream-error rather than truncating.
 */
const RAGFLOW_LIST_BODY_LIMIT = 8 * 1024 * 1024;
// One unpaged read: paging while a dataset is deleted could skip one that still exists.
const DATASETS_PATH = '/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
/** Upper bound of the complete list; one more row fails instead of being cut off. */
const MAX_DATASETS = 1_000;
// rc2 limits names to 128 bytes; a loose bound keeps one odd valid name from failing the list.
const MAX_NAME_BYTES = 1_024;
/** RAGFlow v1.0.0-rc2 dataset IDs. */
export const RAGFLOW_DATASET_ID_PATTERN = '^[0-9a-f]{32}$';
const DATASET_ID = new RegExp(RAGFLOW_DATASET_ID_PATTERN);
/** Shown on the administrator page; anything else from upstream is not echoed. */
export const RAGFLOW_VERSION_PATTERN = '^[\\x20-\\x7e]{1,64}$';
const VERSION = new RegExp(RAGFLOW_VERSION_PATTERN);

/** Closed result set of every RAGFlow answer the platform reports. */
export const RAGFLOW_RESULTS = [
  'ok',
  'not-configured',
  'unavailable',
  'timeout',
  'upstream-error',
  'invalid-request',
] as const;
type RagflowFailure = Exclude<(typeof RAGFLOW_RESULTS)[number], 'ok'>;
type RagflowVersionOutcome =
  { readonly result: 'ok'; readonly version: string } | { readonly result: RagflowFailure };
interface RagflowDataset {
  readonly id: string;
  readonly name: string;
}
type RagflowDatasetsOutcome =
  | { readonly result: 'ok'; readonly datasets: readonly RagflowDataset[] }
  | { readonly result: RagflowFailure };
interface RagflowConnection {
  readonly baseURL: string;
  readonly apiKey: string;
}
type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
/** The unvalidated members of a RAGFlow envelope whose `code` is 0. */
interface Answer {
  readonly data: unknown;
  /** Only the dataset list carries it; undefined elsewhere. */
  readonly total_datasets: unknown;
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
  if (value.code !== 0) return 'upstream-error';
  return {
    data: 'data' in value ? value.data : undefined,
    total_datasets: 'total_datasets' in value ? value.total_datasets : undefined,
  };
}

async function classify(response: Response, limit: number): Promise<Answer | RagflowFailure> {
  const status = response.status;
  if (status >= 200 && status < 300) return envelope(await readLimited(response, limit));
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
  limit: number,
): Promise<Answer | RagflowFailure> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, deadlineMs);
  try {
    const response = await send(request, { signal: AbortSignal.any([signal, deadline.signal]) });
    return await classify(response, limit);
  } catch {
    // Cancellation by the route owner is not a test outcome; transport causes carry host:port.
    signal.throwIfAborted();
    return deadline.signal.aborted ? 'timeout' : 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/** The bearer header for the saved key, or null when the key cannot form a header. */
function keyHeaders(apiKey: string): Headers | null {
  try {
    return new Headers({ Authorization: `Bearer ${apiKey}` });
  } catch {
    // The rejection text quotes the key; only the fixed result leaves this module.
    return null;
  }
}

/**
 * Reads the unauthenticated version endpoint of a configured RAGFlow; an empty address or key is
 * not configured and sends nothing. Only a valid version string leaves this function.
 */
export async function ragflowVersion(
  settings: RagflowConnection,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<RagflowVersionOutcome> {
  if (settings.baseURL === '' || settings.apiKey === '') return { result: 'not-configured' };
  const version = await call(
    new Request(endpoint(settings.baseURL, '/api/v1/system/version'), { redirect: 'manual' }),
    signal,
    deadlineMs,
    send,
    BODY_LIMIT,
  );
  if (typeof version === 'string') return { result: version };
  if (typeof version.data !== 'string' || !VERSION.test(version.data))
    return { result: 'upstream-error' };
  return { result: 'ok', version: version.data };
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
): Promise<RagflowVersionOutcome> {
  const headers = keyHeaders(settings.apiKey);
  if (headers === null) return { result: 'not-configured' };
  const version = await ragflowVersion(settings, signal, deadlineMs, send);
  if (version.result !== 'ok') return version;
  const list = await call(
    new Request(endpoint(settings.baseURL, '/api/v1/datasets?page=1&page_size=1'), {
      headers,
      redirect: 'manual',
    }),
    signal,
    deadlineMs,
    send,
    BODY_LIMIT,
  );
  return typeof list === 'string' ? { result: list } : version;
}

/** The rows of one complete listing, or null when anything about it is not a valid answer. */
function datasetRows(answer: Answer): RagflowDataset[] | null {
  if (!Array.isArray(answer.data)) return null;
  const rows: readonly unknown[] = answer.data;
  // A count that differs from the rows means the upstream cut the list short.
  if (rows.length > MAX_DATASETS || answer.total_datasets !== rows.length) return null;
  const datasets: RagflowDataset[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('id' in row) || !('name' in row)) return null;
    const { id, name } = row;
    if (typeof id !== 'string' || !DATASET_ID.test(id) || seen.has(id)) return null;
    if (typeof name !== 'string' || name === '' || Buffer.byteLength(name) > MAX_NAME_BYTES)
      return null;
    seen.add(id);
    datasets.push({ id, name });
  }
  return datasets;
}

/**
 * Lists every dataset the saved key can see in one request; an empty address or key is not
 * configured and sends nothing. Only each dataset's ID and name leave this function, in upstream
 * order, and only when the whole listing is valid: a partial list is never returned.
 */
export async function listRagflowDatasets(
  settings: RagflowConnection,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<RagflowDatasetsOutcome> {
  if (settings.baseURL === '' || settings.apiKey === '') return { result: 'not-configured' };
  const headers = keyHeaders(settings.apiKey);
  if (headers === null) return { result: 'not-configured' };
  const answer = await call(
    new Request(endpoint(settings.baseURL, DATASETS_PATH), { headers, redirect: 'manual' }),
    signal,
    deadlineMs,
    send,
    RAGFLOW_LIST_BODY_LIMIT,
  );
  if (typeof answer === 'string') return { result: answer };
  const datasets = datasetRows(answer);
  return datasets === null ? { result: 'upstream-error' } : { result: 'ok', datasets };
}

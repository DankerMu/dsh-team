import { readLimited } from '../bounded-body.ts';

/** Per-request bound through the end of the response body; the route always uses this value. */
export const RAGFLOW_TIMEOUT_MS = 10_000;
// Version and one-row list answers are tiny; a larger body is not a RAGFlow answer.
const BODY_LIMIT = 65_536;
/**
 * The complete dataset list. Every rc2 row repeats the dataset's and its owner's base64 avatars,
 * so large avatars can exceed this; the list then fails as upstream-error rather than truncating.
 * A document page and a retrieval answer, whose chunks carry rc2's token fields, share it.
 */
const RAGFLOW_LIST_BODY_LIMIT = 8 * 1024 * 1024;
// One unpaged read: paging while a dataset is deleted could skip one that still exists.
const DATASETS_PATH = '/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
/** Upper bound of the complete list; one more row fails instead of being cut off. */
export const MAX_DATASETS = 1_000;
// rc2 limits names to 128 bytes; a loose bound keeps one odd valid name from failing the list.
const MAX_NAME_BYTES = 1_024;
const RETRIEVAL_PATH = '/api/v1/retrieval';
/**
 * rc2's default rerank candidate pool. It rejects a page whose number exceeds candidates divided
 * by page size (integer division), so a page size above 64 needs at least that many candidates.
 */
const RERANK_CANDIDATES = 64;
// rc2 positions are five-number tuples whose meaning depends on the file type.
const POSITION_LENGTH = 5;
const MAX_POSITIONS = 1_024;
/** RAGFlow v1.0.0-rc2 dataset IDs; its document IDs share the format. */
export const RAGFLOW_DATASET_ID_PATTERN = '^[0-9a-f]{32}$';
const ENTRY_ID = new RegExp(RAGFLOW_DATASET_ID_PATTERN);
// The requested dataset is outside what the key can see: rc2 answers 404 (absent) or 403 (no access).
const DOCUMENT_CODES: ReadonlyMap<number, RagflowFailure> = new Map([
  [404, 'invalid-request'],
  [403, 'invalid-request'],
]);
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
  'no-results',
] as const;
type RagflowFailure = Exclude<(typeof RAGFLOW_RESULTS)[number], 'ok' | 'no-results'>;
type RagflowVersionOutcome =
  { readonly result: 'ok'; readonly version: string } | { readonly result: RagflowFailure };
/** One listed dataset or document: only these two fields leave the module. */
interface RagflowEntry {
  readonly id: string;
  readonly name: string;
}
type RagflowDatasetsOutcome =
  | { readonly result: 'ok'; readonly datasets: readonly RagflowEntry[] }
  | { readonly result: RagflowFailure };
/** One page of a dataset's documents; the route has already validated every field. */
export interface RagflowDocumentsQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly keywords?: string;
}
type RagflowDocumentsOutcome =
  | {
      readonly result: 'ok';
      /** Documents matching the filter across all pages, as RAGFlow counts them. */
      readonly total: number;
      readonly documents: readonly RagflowEntry[];
    }
  | { readonly result: RagflowFailure };
interface RagflowConnection {
  readonly baseURL: string;
  readonly apiKey: string;
}
/** The saved connection and retrieval parameters, all from one settings read. */
export interface RagflowSettings extends RagflowConnection {
  readonly retrievalTopK: number;
  readonly retrievalSimilarityThreshold: number;
  readonly retrievalKeywordsWeight: number;
  /** Empty for no reranking. */
  readonly retrievalRerankId: string;
}
/** A retrieval the route has validated: a non-blank question and 1..1000 distinct dataset IDs. */
export interface RagflowRetrievalRequest {
  readonly question: string;
  readonly datasetIds: readonly string[];
}
/** One retrieved chunk: only these fields leave the module. */
interface RagflowChunk {
  readonly content: string;
  readonly documentName: string;
  readonly datasetName: string;
  /** rc2's tuples as sent, only when it has any; no page number is derived from them. */
  readonly positions?: readonly (readonly number[])[];
}
type RagflowRetrievalOutcome =
  | {
      readonly result: 'ok';
      /** Requested IDs absent from the current dataset list, in request order. */
      readonly excluded: readonly string[];
      readonly chunks: readonly RagflowChunk[];
    }
  | { readonly result: 'no-results'; readonly excluded: readonly string[] }
  | { readonly result: RagflowFailure };
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

/** `codes` maps a non-zero RAGFlow code to its result; any other non-zero code is upstream-error. */
function envelope(
  text: string | null,
  codes: ReadonlyMap<number, RagflowFailure>,
): Answer | RagflowFailure {
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
  if (value.code !== 0) return codes.get(value.code) ?? 'upstream-error';
  return {
    data: 'data' in value ? value.data : undefined,
    total_datasets: 'total_datasets' in value ? value.total_datasets : undefined,
  };
}

async function classify(
  response: Response,
  limit: number,
  codes: ReadonlyMap<number, RagflowFailure>,
): Promise<Answer | RagflowFailure> {
  const status = response.status;
  if (status >= 200 && status < 300) return envelope(await readLimited(response, limit), codes);
  // Only a 2xx body is inspected; others are released without reading.
  response.body?.cancel().catch(() => undefined);
  return status === 401 || status === 403 ? 'not-configured' : 'upstream-error';
}

/** One request with its own deadline; external cancellation rejects instead of becoming a result. */
async function call(
  request: Request,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send,
  limit: number,
  codes: ReadonlyMap<number, RagflowFailure> = new Map(),
): Promise<Answer | RagflowFailure> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, deadlineMs);
  try {
    const response = await send(request, { signal: AbortSignal.any([signal, deadline.signal]) });
    return await classify(response, limit, codes);
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

/**
 * The ID and name of every row that `admits`, in order, or null when any row is not an object
 * with a valid ID and name, repeats an ID or is not admitted: a partial list is never returned.
 */
function entries(
  rows: readonly unknown[],
  admits: (row: object) => boolean = () => true,
): RagflowEntry[] | null {
  const valid: RagflowEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('id' in row) || !('name' in row)) return null;
    const { id, name } = row;
    if (typeof id !== 'string' || !ENTRY_ID.test(id) || seen.has(id)) return null;
    if (typeof name !== 'string' || name === '' || Buffer.byteLength(name) > MAX_NAME_BYTES)
      return null;
    if (!admits(row)) return null;
    seen.add(id);
    valid.push({ id, name });
  }
  return valid;
}

/** The rows of one complete listing, or null when anything about it is not a valid answer. */
function datasetRows(answer: Answer): RagflowEntry[] | null {
  if (!Array.isArray(answer.data)) return null;
  const rows: readonly unknown[] = answer.data;
  // A count that differs from the rows means the upstream cut the list short.
  if (rows.length > MAX_DATASETS || answer.total_datasets !== rows.length) return null;
  return entries(rows);
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

/** The total and rows of one document page, or null when anything about it is not valid. */
function documentPage(
  answer: Answer,
  datasetId: string,
  pageSize: number,
): { total: number; documents: RagflowEntry[] } | null {
  const data = answer.data;
  if (typeof data !== 'object' || data === null || !('total' in data) || !('docs' in data))
    return null;
  const { total, docs } = data;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return null;
  if (!Array.isArray(docs)) return null;
  const rows: readonly unknown[] = docs;
  if (rows.length > pageSize || rows.length > total) return null;
  const documents = entries(rows, (row) => 'dataset_id' in row && row.dataset_id === datasetId);
  return documents === null ? null : { total, documents };
}

/**
 * Reads one page of a dataset's documents, oldest first, optionally filtered by file name, in a
 * single request; an empty address or key is not configured and sends nothing. The dataset ID and
 * page come validated from the route. Only each document's ID and name leave this function, in
 * upstream order, and only when the whole page is valid. A dataset that the key cannot see
 * answers invalid-request.
 */
export async function listRagflowDocuments(
  settings: RagflowConnection,
  datasetId: string,
  query: RagflowDocumentsQuery,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<RagflowDocumentsOutcome> {
  if (settings.baseURL === '' || settings.apiKey === '') return { result: 'not-configured' };
  const headers = keyHeaders(settings.apiKey);
  if (headers === null) return { result: 'not-configured' };
  // encodeURIComponent keeps a decoded space as %20; URLSearchParams would send "+".
  const filter =
    query.keywords === undefined ? '' : `&keywords=${encodeURIComponent(query.keywords)}`;
  const path =
    `/api/v1/datasets/${datasetId}/documents?page=${String(query.page)}` +
    `&page_size=${String(query.pageSize)}&orderby=create_time&desc=false${filter}`;
  const answer = await call(
    new Request(endpoint(settings.baseURL, path), { headers, redirect: 'manual' }),
    signal,
    deadlineMs,
    send,
    RAGFLOW_LIST_BODY_LIMIT,
    DOCUMENT_CODES,
  );
  if (typeof answer === 'string') return { result: answer };
  const documents = documentPage(answer, datasetId, query.pageSize);
  return documents === null ? { result: 'upstream-error' } : { result: 'ok', ...documents };
}

/** The upstream body: the saved parameters only, never anything the instance supplied. */
function retrievalBody(
  settings: RagflowSettings,
  question: string,
  datasetIds: readonly string[],
): string {
  return JSON.stringify({
    question,
    dataset_ids: datasetIds,
    page: 1,
    page_size: settings.retrievalTopK,
    similarity_threshold: settings.retrievalSimilarityThreshold,
    // rc2 derives the vector weight as 1 minus this one; sending both can contradict it.
    keywords_similarity_weight: settings.retrievalKeywordsWeight,
    ...(settings.retrievalRerankId === '' ? {} : { rerank_id: settings.retrievalRerankId }),
    rerank_candidates_count: Math.max(RERANK_CANDIDATES, settings.retrievalTopK),
    // Compiled knowledge rows have no source file, so they cannot become chunks.
    include_knowledge_compilation: false,
  });
}

function isPosition(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === POSITION_LENGTH &&
    value.every((item: unknown) => typeof item === 'number' && Number.isFinite(item))
  );
}

/** A chunk's positions when it has any, undefined when absent, null or empty, null when invalid. */
function positionsOf(row: object): readonly number[][] | undefined | null {
  const value = 'positions' in row ? row.positions : undefined;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_POSITIONS) return null;
  const tuples: readonly unknown[] = value;
  if (tuples.length === 0) return undefined;
  return tuples.every(isPosition) ? tuples : null;
}

/** The source file name of a chunk, or null when it is not a usable name. */
function documentName(row: object): string | null {
  const name = 'document_keyword' in row ? row.document_keyword : undefined;
  if (typeof name !== 'string' || name === '' || Buffer.byteLength(name) > MAX_NAME_BYTES)
    return null;
  return name;
}

/** One chunk as returned, or null unless it is valid and belongs to a retrieved dataset. */
function chunkOf(row: unknown, scope: ReadonlyMap<string, string>): RagflowChunk | null {
  if (typeof row !== 'object' || row === null) return null;
  const content = 'content' in row ? row.content : undefined;
  const name = documentName(row);
  const datasetId = 'dataset_id' in row ? row.dataset_id : undefined;
  // A chunk outside the retrieved datasets is out of scope, not merely unnamed.
  const datasetName = typeof datasetId === 'string' ? scope.get(datasetId) : undefined;
  const positions = positionsOf(row);
  if (typeof content !== 'string' || name === null || datasetName === undefined) return null;
  if (positions === null) return null;
  const chunk = { content, documentName: name, datasetName };
  return positions === undefined ? chunk : { ...chunk, positions };
}

/** Every chunk of one retrieval answer, or null when any part of it is not valid. */
function retrievedChunks(
  answer: Answer,
  scope: ReadonlyMap<string, string>,
  topK: number,
): RagflowChunk[] | null {
  const data = answer.data;
  if (typeof data !== 'object' || data === null || !('chunks' in data)) return null;
  if (!Array.isArray(data.chunks) || data.chunks.length > topK) return null;
  const rows: readonly unknown[] = data.chunks;
  const chunks: RagflowChunk[] = [];
  for (const row of rows) {
    const chunk = chunkOf(row, scope);
    if (chunk === null) return null;
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Lists the current datasets, drops requested IDs that no longer exist, and retrieves from the
 * rest in one request with the saved parameters; an empty address or key is not configured and
 * sends nothing. An empty remaining scope is never retrieved. Only each chunk's text, file name,
 * dataset name and any positions leave this function, and only when every chunk is valid and
 * belongs to a retrieved dataset. The list and the retrieval each have their own deadline.
 */
export async function retrieveRagflow(
  settings: RagflowSettings,
  request: RagflowRetrievalRequest,
  signal: AbortSignal,
  deadlineMs: number,
  send: Send = fetch,
): Promise<RagflowRetrievalOutcome> {
  if (settings.baseURL === '' || settings.apiKey === '') return { result: 'not-configured' };
  const headers = keyHeaders(settings.apiKey);
  if (headers === null) return { result: 'not-configured' };
  const listed = await listRagflowDatasets(settings, signal, deadlineMs, send);
  if (listed.result !== 'ok') return listed;
  const names = new Map(listed.datasets.map(({ id, name }) => [id, name]));
  // Insertion order keeps the request order; the list also names each retrieved dataset.
  const scope = new Map<string, string>();
  const excluded: string[] = [];
  for (const id of request.datasetIds) {
    const name = names.get(id);
    if (name === undefined) excluded.push(id);
    else scope.set(id, name);
  }
  // Never fall back to an empty or omitted scope.
  if (scope.size === 0) return { result: 'no-results', excluded };
  headers.set('Content-Type', 'application/json');
  const answer = await call(
    new Request(endpoint(settings.baseURL, RETRIEVAL_PATH), {
      method: 'POST',
      headers,
      body: retrievalBody(settings, request.question, [...scope.keys()]),
      redirect: 'manual',
    }),
    signal,
    deadlineMs,
    send,
    RAGFLOW_LIST_BODY_LIMIT,
  );
  if (typeof answer === 'string') return { result: answer };
  const chunks = retrievedChunks(answer, scope, settings.retrievalTopK);
  if (chunks === null) return { result: 'upstream-error' };
  return chunks.length === 0
    ? { result: 'no-results', excluded }
    : { result: 'ok', excluded, chunks };
}

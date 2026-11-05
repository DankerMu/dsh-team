// @ts-check
/**
 * Host half of the knowledge-base plugin. It validates the platform address the managed overlay
 * may give it, publishes whether the plugin is usable on this instance, and registers the browser
 * routes that forward the sidebar panel's reads to the platform's instance RAGFlow proxy.
 */
export const name = 'dsh-team-knowledge-base';
export const inject = ['connection'];

// Fixed text: a rejected config is never echoed (it is overlay-written, but may be tampered with).
const REJECTED =
  'knowledge-base config must be absent or exactly { platformUrl: "http://<instance +3 IPv4>:<port>" }';
const ADDRESS = /^http:\/\/([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3}):([0-9]{1,5})$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const GLOBAL = '__DSH_TEAM_KNOWLEDGE_BASE__';
const TOKEN = /^[0-9a-f]{64}$/;
const PROXY = '/_platform/instance-api/ragflow';
/** One platform answer through the end of its body; the proxy bounds each RAGFlow call at 10s. */
const DEADLINE_MS = 25_000;
/** 1000 datasets with 1024-byte names are about 1.07 MB; rc2 itself caps names at 128 bytes. */
const LIST_LIMIT = 2 * 1024 * 1024;
const FAILURES = new Set([
  'not-configured',
  'unavailable',
  'timeout',
  'upstream-error',
  'invalid-request',
]);
const ENTRY_ID = /^[0-9a-f]{32}$/;
const PAGE = /^[1-9][0-9]{0,5}$/;
// rc2 silently replaces a page size outside 1..100 with 10 instead of rejecting it.
const PAGE_SIZE = /^(100|[1-9][0-9]?)$/;
const MAX_KEYWORDS_BYTES = 256;

/**
 * `http://<canonical dotted IPv4>:<port>` with the instance bridge's +3 last octet (the same
 * modulo-16 rule the generator applies to +2), a canonical port 1..65535 and nothing else.
 * @param {unknown} value
 */
function platformAddress(value) {
  const match = typeof value === 'string' ? ADDRESS.exec(value) : null;
  if (match === null) return false;
  const [octets, port] = [match.slice(1, 5), match[5] ?? ''];
  if (!octets.every((octet) => DECIMAL.test(octet) && Number(octet) <= 255)) return false;
  if (Number(octets[3]) % 16 !== 3) return false;
  return DECIMAL.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/**
 * The overlay row's config: absent (no address, the designed published-loopback state) or exactly
 * `{ platformUrl }`. Anything else fails the plugin loudly.
 * @param {unknown} config
 * @returns {import('./types.js').KnowledgeBaseConfig | undefined}
 */
function platformConfig(config) {
  if (config === undefined || config === null) return undefined;
  const prototype = typeof config === 'object' ? Object.getPrototypeOf(config) : undefined;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(REJECTED);
  const keys = Reflect.ownKeys(/** @type {object} */ (config));
  if (keys.length === 0) return undefined;
  // A data property only: an accessor would run code while being validated.
  const platformUrl = Object.getOwnPropertyDescriptor(config, 'platformUrl')?.value;
  if (keys.length !== 1 || !platformAddress(platformUrl)) throw new TypeError(REJECTED);
  return { platformUrl: /** @type {string} */ (platformUrl) };
}

/**
 * Empty or only whitespace as rc2 trims it: Go's TrimSpace also strips U+0085, which JS `trim`
 * keeps, so a text that looks non-blank here would reach rc2 empty.
 * @param {string} text
 */
function isBlank(text) {
  return /^[\s\u0085]*$/u.test(text);
}

/**
 * The decoded name/value pairs of a request URL's query, or null when any item is malformed,
 * repeated or the URL carries a fragment; the platform proxy parses its own query the same way.
 * @param {string} url
 * @returns {Map<string, string> | null}
 */
function queryFields(url) {
  if (url.includes('#')) return null;
  const start = url.indexOf('?');
  /** @type {Map<string, string>} */
  const fields = new Map();
  if (start === -1) return fields;
  // URLSearchParams never rejects: it keeps "%zz" and turns "%ff" into U+FFFD.
  /** @param {string} text */
  const decode = (text) => decodeURIComponent(text.replaceAll('+', ' '));
  for (const item of url.slice(start + 1).split('&')) {
    const split = item.indexOf('=');
    if (split === -1) return null;
    let key;
    let value;
    try {
      key = decode(item.slice(0, split));
      value = decode(item.slice(split + 1));
    } catch {
      // URIError: an escape that is not percent-encoded UTF-8.
      return null;
    }
    if (fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

/**
 * The proxy documents path for a valid browser query, or null for anything else.
 * @param {string} url
 */
function documentsPath(url) {
  const fields = queryFields(url);
  if (fields === null) return null;
  const datasetId = fields.get('datasetId');
  const page = fields.get('page');
  const pageSize = fields.get('pageSize');
  const keywords = fields.get('keywords');
  if (fields.size !== (keywords === undefined ? 3 : 4)) return null;
  if (datasetId === undefined || !ENTRY_ID.test(datasetId)) return null;
  if (page === undefined || !PAGE.test(page)) return null;
  if (pageSize === undefined || !PAGE_SIZE.test(pageSize)) return null;
  const query = `page=${page}&page_size=${pageSize}`;
  const path = `${PROXY}/datasets/${datasetId}/documents?${query}`;
  if (keywords === undefined) return path;
  // A blank filter would silently list every document.
  if (isBlank(keywords) || Buffer.byteLength(keywords) > MAX_KEYWORDS_BYTES) return null;
  return `${path}&keywords=${encodeURIComponent(keywords)}`;
}

/**
 * The listed entries' IDs and names only, or undefined when any entry is malformed.
 * @param {unknown} value
 * @returns {{ id: string; name: string }[] | undefined}
 */
function entries(value) {
  if (!Array.isArray(value)) return undefined;
  const listed = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { id, name: entryName } = entry;
    if (typeof id !== 'string' || !ENTRY_ID.test(id)) return undefined;
    if (typeof entryName !== 'string' || entryName === '') return undefined;
    listed.push({ id, name: entryName });
  }
  return listed;
}

/**
 * A proxy answer reduced to the closed set this plugin forwards, or undefined when its shape is
 * not one the proxy declares for the route.
 * @param {unknown} body
 * @param {'datasets' | 'documents'} kind
 * @returns {import('./types.js').KnowledgeBaseAnswer | undefined}
 */
function answerOf(body, kind) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (body);
  const result = record.result;
  if (typeof result === 'string' && FAILURES.has(result))
    return /** @type {import('./types.js').KnowledgeBaseAnswer} */ ({ result });
  if (result !== 'ok') return undefined;
  if (kind === 'datasets') {
    const datasets = entries(record.datasets);
    return datasets && { result: 'ok', datasets };
  }
  const total = record.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return undefined;
  const documents = entries(record.documents);
  return documents && { result: 'ok', total, documents };
}

/**
 * The whole body as bytes, or null once it exceeds `limit`. An abort cancels the read and throws.
 * @param {Response} response
 * @param {number} limit
 * @param {AbortSignal} signal
 */
async function readBody(response, limit, signal) {
  if (response.body === null) return Buffer.alloc(0);
  // Fetch bodies are byte streams; Node's global typing leaves their chunk type as any.
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (response.body.getReader());
  const cancel = () => {
    // Cancellation failure only concerns an already-failed body.
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > limit) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * One GET to the platform's instance proxy with the instance token, mapped onto the closed set.
 * Every failure becomes a result; nothing here throws.
 * @param {import('./types.js').PlatformRequest} request
 * @returns {Promise<import('./types.js').KnowledgeBaseAnswer>}
 */
async function platformRequest({ url, token, kind, limit, signal, logger }) {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, DEADLINE_MS);
  const combined = AbortSignal.any([signal, deadline.signal]);
  /** @param {'upstream-error' | 'unavailable' | 'timeout'} result */
  const failed = (result) => {
    // A cancelled request has no reader; only its own failures are worth a line.
    if (!signal.aborted) logger.warn('knowledge-base: platform request failed: %s', result);
    return /** @type {const} */ ({ result });
  };
  try {
    let bytes;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: combined,
      });
      if (response.status !== 200) {
        response.body?.cancel().catch(() => undefined);
        if (response.status === 401)
          logger.warn('knowledge-base: the platform rejected the instance token');
        return failed('upstream-error');
      }
      bytes = await readBody(response, limit, combined);
    } catch {
      return failed(deadline.signal.aborted ? 'timeout' : 'unavailable');
    }
    if (bytes === null) return failed('upstream-error');
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return failed('upstream-error');
    }
    return answerOf(body, kind) ?? failed('upstream-error');
  } finally {
    clearTimeout(timer);
  }
}

/** @param {import('./types.js').KnowledgeBaseAnswer} answer */
function answered(answer) {
  return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
}

/**
 * @param {import('./types.js').KnowledgeBaseHostContext} ctx
 * @param {unknown} config managed overlay row config
 */
export function apply(ctx, config) {
  const platform = platformConfig(config);
  const token = process.env.DSH_TEAM_INSTANCE_TOKEN;
  const available = platform !== undefined && token !== undefined && TOKEN.test(token);
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: GLOBAL, value: { available } });
  });
  if (!available) return;
  const lifetime = new AbortController();
  /** @type {Set<Promise<Response>>} */
  const pending = new Set();
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled(pending);
  });
  /**
   * @param {Request} request
   * @param {'datasets' | 'documents'} kind
   * @param {string | null} path
   */
  const forward = (request, kind, path) => {
    if (path === null) return Promise.resolve(answered({ result: 'invalid-request' }));
    const task = platformRequest({
      url: `${platform.platformUrl}${path}`,
      token,
      kind,
      limit: LIST_LIMIT,
      signal: AbortSignal.any([request.signal, lifetime.signal]),
      logger: ctx.logger,
    }).then(answered);
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  ctx.connection.fetch.register({
    path: '/api/knowledge-base.datasets',
    methods: ['GET'],
    requestBody: 'buffered',
    // No query at all, not even a bare "?", and no fragment.
    fetch: (request) =>
      forward(request, 'datasets', /[?#]/.test(request.url) ? null : `${PROXY}/datasets`),
  });
  ctx.connection.fetch.register({
    path: '/api/knowledge-base.documents',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => forward(request, 'documents', documentsPath(request.url)),
  });
}

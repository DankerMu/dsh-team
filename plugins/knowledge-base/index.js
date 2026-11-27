// @ts-check
/**
 * Host half of the knowledge-base plugin. It validates the platform address the managed overlay
 * may give it, publishes whether the plugin is usable on this instance, and registers the browser
 * routes that forward the sidebar panel's reads (libraries, files and a file's parsed content) to
 * the platform's instance RAGFlow proxy, the `/kb-scope` command and the `kbScope` projection that
 * keep each Session's retrieval scope, and the `knowledge_base_search` and `knowledge_base_list`
 * tools, which retrieve within and list the root Session's turn snapshot.
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
/** 1000 IDs serialize to about 35 KB; anything longer is not a scope argument. */
const MAX_SCOPE_BYTES = 40_000;
const MAX_SCOPE_IDS = 1000;
const SCOPE_INVALID = '知识库范围参数无效';
/** The retrieval answer: up to 100 chunks of RAGFlow text, the proxy's own 8 MiB cap. */
const RETRIEVAL_LIMIT = 8 * 1024 * 1024;
const MAX_QUESTION_BYTES = 4096;
/** The fixed Chinese text of every search outcome but `ok`, whose title counts its chunks. */
const OUTCOME_TEXTS = {
  'no-results': '知识库中没有找到相关内容',
  'no-scope': '本轮没有选择知识库，未检索',
  'no-datasets': '平台上还没有任何知识库，未检索',
  'scope-unavailable': '无法确定本轮的检索范围，未检索',
  'invalid-question': '检索问题为空或过长，未检索',
  'invalid-request': '检索请求无效',
  'not-configured': '知识库未配置，请联系管理员',
  timeout: '知识库检索超时，请稍后重试',
  unavailable: '知识库暂时不可用，请稍后重试',
  'upstream-error': '知识库返回了异常结果，请稍后重试',
};
const RESULTS = ['ok', ...Object.keys(OUTCOME_TEXTS)];
/** The fixed Chinese text of every list outcome but `ok`, whose text names what was listed. */
const LIST_TEXTS = {
  'no-scope': '本轮没有选择知识库，未列出',
  'scope-unavailable': '无法确定本轮可以查看哪些知识库，未列出',
  'no-datasets': '本轮没有可以查看的知识库',
  'unknown-library': '本轮可查看的知识库中没有这个名称，请先不带库名调用以列出知识库名称',
  'invalid-request':
    '列出请求无效：库名和关键字不能为空、最多 256 字节，页码为 1 到 999999，关键字和页码只能与库名一起使用',
  'not-configured': '知识库未配置，无法列出，请联系管理员',
  timeout: '列出知识库超时，请稍后重试',
  unavailable: '知识库暂时不可用，未能列出，请稍后重试',
  'upstream-error': '知识库返回了异常的列表，请稍后重试',
};
const LIST_RESULTS = ['ok', ...Object.keys(LIST_TEXTS)];
const LIST_PAGE_SIZE = 20;

/**
 * A stored selection: null (every library, later ones included) or 0..1000 distinct IDs.
 * @param {unknown} value
 * @returns {value is import('./types.js').ScopeSelection}
 */
function isSelection(value) {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length > MAX_SCOPE_IDS) return false;
  const valid = value.every((id) => typeof id === 'string' && ENTRY_ID.test(id));
  return valid && new Set(value).size === value.length;
}

/**
 * The selection a `/kb-scope` argument line sets, or undefined for anything but exactly
 * `{"datasetIds": null | [...]}`. The handler and the fold share this one parser.
 * @param {unknown} args the command's raw input after its name
 * @returns {{ selection: import('./types.js').ScopeSelection } | undefined}
 */
function scopeArgument(args) {
  if (typeof args !== 'string' || Buffer.byteLength(args) > MAX_SCOPE_BYTES) return undefined;
  let value;
  try {
    value = JSON.parse(args.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'datasetIds') return undefined;
  const selection = /** @type {{ datasetIds: unknown }} */ (value).datasetIds;
  return isSelection(selection) ? { selection } : undefined;
}

/**
 * Checks that `value` is a plain object with exactly `keys`, then returns it as a record.
 * @param {unknown} value
 * @param {string[]} keys
 */
function exactRecord(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('kbScope value malformed');
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key)))
    throw new TypeError('kbScope value malformed');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function checkSelection(value) {
  if (!isSelection(value)) throw new TypeError('kbScope value malformed');
}

/** @param {unknown} value */
function checkTurn(value) {
  if (value === null) return;
  const turn = exactRecord(value, ['turn', 'scope']);
  if (!Number.isSafeInteger(turn.turn) || Number(turn.turn) < 0)
    throw new TypeError('kbScope value malformed');
  checkSelection(turn.scope);
}

/** The released projection layer only calls `parse` and uses its result. */
const stateSchema = {
  /** @param {unknown} value */
  parse(value) {
    const state = exactRecord(value, ['child', 'selection', 'running', 'turn']);
    if (typeof state.child !== 'boolean') throw new TypeError('kbScope value malformed');
    checkSelection(state.selection);
    if (state.running !== null) {
      const running = exactRecord(state.running, ['commandId', 'selection']);
      if (typeof running.commandId !== 'string') throw new TypeError('kbScope value malformed');
      checkSelection(running.selection);
    }
    checkTurn(state.turn);
    return /** @type {import('./types.js').ScopeState} */ (value);
  },
};

const viewSchema = {
  /** @param {unknown} value */
  parse(value) {
    const view = exactRecord(value, ['child', 'selection', 'turn']);
    if (typeof view.child !== 'boolean') throw new TypeError('kbScope value malformed');
    checkSelection(view.selection);
    checkTurn(view.turn);
    return /** @type {import('./types.js').ScopeView} */ (value);
  },
};

/**
 * The `kbScope` fold over the Session log: a `/kb-scope` command takes effect only when its
 * `command/run` arguments parse and its paired `command/done` succeeded; `turn/start` snapshots
 * the selection at that moment. A Session without records reads as every library.
 * @type {import('./types.js').ScopeProjection}
 */
export const scopeProjection = {
  key: 'kbScope',
  stateVersion: 1,
  stateSchema,
  init: (header) => ({
    child: header.origin === 'subagent',
    selection: null,
    running: null,
    turn: null,
  }),
  apply(state, event) {
    const { type, data } = event;
    if (type === 'command/run' && data.name === 'kb-scope') {
      const parsed = scopeArgument(data.args);
      if (parsed === undefined) return state.running === null ? state : { ...state, running: null };
      const commandId = /** @type {string} */ (data.commandId);
      return { ...state, running: { commandId, selection: parsed.selection } };
    }
    const { running } = state;
    if (type === 'command/done' && running !== null && data.commandId === running.commandId) {
      const selection = data.kind === 'success' ? running.selection : state.selection;
      return { ...state, selection, running: null };
    }
    if (type === 'turn/start')
      return {
        ...state,
        turn: { turn: /** @type {number} */ (data.turn), scope: state.selection },
      };
    return state;
  },
  wire: {
    viewSchema,
    view: ({ child, selection, turn }) => ({ child, selection, turn }),
  },
};

/** @param {import('./types.js').ScopeSelection} selection */
function scopeSummary(selection) {
  if (selection === null) return '全部';
  return selection.length === 0 ? '不检索' : `${String(selection.length)} 个`;
}

/**
 * `/kb-scope {"datasetIds": ...}`, sent by the composer control; the arguments are logged by the
 * released command runtime and folded by `scopeProjection`. A rejected input is never echoed.
 * @type {import('./types.js').ScopeCommand}
 */
export const scopeCommand = {
  definitionId: '@dsh-team/knowledge-base',
  name: 'kb-scope',
  description: '设置本 Session 的知识库检索范围（由输入区控件调用）',
  input: { hint: '<json>' },
  handler: ({ rawInput }) => {
    const parsed = scopeArgument(rawInput);
    if (parsed === undefined) return { kind: 'error', text: SCOPE_INVALID };
    return { kind: 'success', text: `知识库范围：${scopeSummary(parsed.selection)}` };
  },
};

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
 * A file-name filter or library name as the proxy accepts `keywords`: a string, non-blank, at most
 * 256 UTF-8 bytes. A blank filter would silently list every document.
 * @param {unknown} text
 * @returns {text is string}
 */
function isFilter(text) {
  return (
    typeof text === 'string' && !isBlank(text) && Buffer.byteLength(text) <= MAX_KEYWORDS_BYTES
  );
}

/**
 * The proxy documents path of one checked page request.
 * @param {string} datasetId
 * @param {string} page
 * @param {string} pageSize
 * @param {string | undefined} keywords
 */
function documentsRoute(datasetId, page, pageSize, keywords) {
  const path = `${PROXY}/datasets/${datasetId}/documents?page=${page}&page_size=${pageSize}`;
  return keywords === undefined ? path : `${path}&keywords=${encodeURIComponent(keywords)}`;
}

/**
 * The library and page every paged browser query names, or null unless all three are valid.
 * @param {Map<string, string>} fields
 */
function pagedFields(fields) {
  const datasetId = fields.get('datasetId');
  const page = fields.get('page');
  const pageSize = fields.get('pageSize');
  if (datasetId === undefined || !ENTRY_ID.test(datasetId)) return null;
  if (page === undefined || !PAGE.test(page)) return null;
  if (pageSize === undefined || !PAGE_SIZE.test(pageSize)) return null;
  return { datasetId, page, pageSize };
}

/**
 * The proxy documents path for a valid browser query, or null for anything else.
 * @param {string} url
 */
function documentsPath(url) {
  const fields = queryFields(url);
  if (fields === null) return null;
  const keywords = fields.get('keywords');
  if (fields.size !== (keywords === undefined ? 3 : 4)) return null;
  const paged = pagedFields(fields);
  if (paged === null || (keywords !== undefined && !isFilter(keywords))) return null;
  return documentsRoute(paged.datasetId, paged.page, paged.pageSize, keywords);
}

/**
 * The proxy chunks path for a valid preview query (exactly the library, the document and the
 * page), or null for anything else.
 * @param {string} url
 */
function chunksPath(url) {
  const fields = queryFields(url);
  const documentId = fields?.get('documentId');
  if (fields?.size !== 4 || documentId === undefined || !ENTRY_ID.test(documentId)) return null;
  const paged = pagedFields(fields);
  if (paged === null) return null;
  const { datasetId, page, pageSize } = paged;
  return `${PROXY}/datasets/${datasetId}/documents/${documentId}/chunks?page=${page}&page_size=${pageSize}`;
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

/** @param {unknown} value */
const isPosition = (value) =>
  Array.isArray(value) &&
  value.length === 5 &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item));

/**
 * Retrieved chunks with only their declared fields, or undefined when any is malformed:
 * string `content`, `documentName` and `datasetName`, and `positions` absent or a non-empty list
 * of 5-number tuples, kept verbatim.
 * @param {unknown} value
 * @returns {import('./types.js').SearchChunk[] | undefined}
 */
function chunksOf(value) {
  if (!Array.isArray(value)) return undefined;
  const chunks = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { content, documentName, datasetName, positions } = entry;
    if (typeof content !== 'string' || typeof documentName !== 'string') return undefined;
    if (typeof datasetName !== 'string') return undefined;
    const chunk = { content, documentName, datasetName };
    if (positions === undefined) chunks.push(chunk);
    else if (Array.isArray(positions) && positions.length > 0 && positions.every(isPosition))
      chunks.push({ ...chunk, positions });
    else return undefined;
  }
  return chunks;
}

/**
 * A document's preview chunks with only their text, or undefined when any is malformed.
 * @param {unknown} value
 * @returns {{ content: string }[] | undefined}
 */
function previewChunks(value) {
  if (!Array.isArray(value)) return undefined;
  const chunks = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || typeof entry.content !== 'string')
      return undefined;
    chunks.push({ content: entry.content });
  }
  return chunks;
}

/**
 * A paged `ok` answer: the count and one page of documents or of preview chunks.
 * @param {Record<string, unknown>} record
 * @param {'documents' | 'chunks'} kind
 * @returns {import('./types.js').KnowledgeBaseAnswer | undefined}
 */
function pagedAnswer(record, kind) {
  const total = record.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return undefined;
  if (kind === 'chunks') {
    const chunks = previewChunks(record.chunks);
    return chunks && { result: 'ok', total, chunks };
  }
  const documents = entries(record.documents);
  return documents && { result: 'ok', total, documents };
}

/**
 * The proxy retrieval answer: `ok` with chunks or `no-results`, both with the excluded IDs.
 * @param {Record<string, unknown>} record
 * @returns {import('./types.js').KnowledgeBaseAnswer | undefined}
 */
function retrievalAnswer(record) {
  const { excluded } = record;
  if (!Array.isArray(excluded) || !excluded.every((id) => typeof id === 'string')) return undefined;
  if (record.result === 'no-results') return { result: 'no-results', excluded };
  const chunks = record.result === 'ok' ? chunksOf(record.chunks) : undefined;
  return chunks && { result: 'ok', excluded, chunks };
}

/**
 * A proxy answer reduced to the closed set this plugin forwards, or undefined when its shape is
 * not one the proxy declares for the route.
 * @param {unknown} body
 * @param {import('./types.js').PlatformRequest['kind']} kind
 * @returns {import('./types.js').KnowledgeBaseAnswer | undefined}
 */
function answerOf(body, kind) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (body);
  const result = record.result;
  if (typeof result === 'string' && FAILURES.has(result))
    return /** @type {import('./types.js').KnowledgeBaseAnswer} */ ({ result });
  if (kind === 'retrieval') return retrievalAnswer(record);
  if (result !== 'ok') return undefined;
  if (kind !== 'datasets') return pagedAnswer(record, kind);
  const datasets = entries(record.datasets);
  return datasets && { result: 'ok', datasets };
}

/**
 * A list or documents answer without its payload: answerOf gives such a route nothing else.
 * @param {import('./types.js').KnowledgeBaseAnswer} answer
 */
const failure = (answer) => ({
  result: /** @type {import('./types.js').ProxyFailure} */ (answer.result),
});

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
 * One request to the platform's instance proxy with the instance token, mapped onto the closed
 * set: a GET, or a JSON POST when `body` is given. Every failure becomes a result; nothing here
 * throws.
 * @param {import('./types.js').PlatformRequest} request
 * @returns {Promise<import('./types.js').KnowledgeBaseAnswer>}
 */
async function platformRequest({ url, token, kind, limit, signal, logger, body: payload }) {
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
      const authorization = `Bearer ${token}`;
      const init =
        payload === undefined
          ? { method: 'GET', headers: { authorization } }
          : {
              method: 'POST',
              headers: { authorization, 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            };
      const response = await fetch(url, { ...init, redirect: 'manual', signal: combined });
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

/**
 * The search question as the proxy accepts it (non-blank, at most 4096 UTF-8 bytes), forwarded
 * untrimmed; undefined for anything but exactly `{ question }`.
 * @param {unknown} args
 */
function questionOf(args) {
  if (typeof args !== 'object' || args === null || Object.keys(args).length !== 1) return undefined;
  const { question } = /** @type {{ question?: unknown }} */ (args);
  if (typeof question !== 'string' || isBlank(question)) return undefined;
  return Buffer.byteLength(question) > MAX_QUESTION_BYTES ? undefined : question;
}

/**
 * The `tool/result` meta of one outcome; like the value it names libraries only, never their IDs.
 * @param {import('./types.js').SearchValue} value
 * @returns {import('./types.js').SearchMeta}
 */
function metaOf(value) {
  const chunks = value.chunks ?? [];
  const title =
    value.result === 'ok'
      ? `知识库检索：${String(chunks.length)} 条结果`
      : OUTCOME_TEXTS[value.result];
  return { result: value.result, title, excluded: value.excluded ?? 0, chunks };
}

// A name keeps to its own entry line: CR, LF, VT, FF, NEL, LS and PS each become a space.
/** @param {string} name */
const flat = (name) => name.replace(/[\n\r\v\f\u0085\u2028\u2029]/g, ' ');

/**
 * The one text the model gets and the employee sees when expanding the native tool row: the
 * title, the exclusion count, then every chunk with its file, its library and, only when present,
 * its verbatim positions.
 * @param {import('./types.js').SearchMeta} meta
 */
function describe({ title, excluded, chunks }) {
  const lines = [title];
  if (excluded > 0) lines.push(`有 ${String(excluded)} 个已选知识库已不可用，已跳过`);
  chunks.forEach((chunk, index) => {
    const file = flat(chunk.documentName);
    lines.push('', `[${String(index + 1)}] 文件：${file}；所属知识库：${flat(chunk.datasetName)}`);
    if (chunk.positions !== undefined) lines.push(`位置：${JSON.stringify(chunk.positions)}`);
    lines.push(chunk.content);
  });
  return lines.join('\n');
}

const CHUNK_SCHEMA = {
  type: 'object',
  required: ['content', 'documentName', 'datasetName'],
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
    documentName: { type: 'string' },
    datasetName: { type: 'string' },
    positions: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
  },
};

/**
 * The scope record of a root Session's current turn: `{ scope }`, or undefined without a turn.
 * @param {import('./types.js').SearchServices['sessionProjections']} projections
 * @param {import('./types.js').SearchSession} session
 * @returns {{ scope: import('./types.js').ScopeSelection } | undefined}
 */
function turnScope(projections, session) {
  const turn = projections.stateOf(session, 'kbScope')?.turn;
  return turn === null || turn === undefined ? undefined : { scope: turn.scope };
}

/**
 * The one scope resolver both tools share. A root Session uses its own turn snapshot; a child
 * Agent uses the record taken when it was created or resumed, never its own projection, so a
 * delegation cannot widen the scope. It registers the only `agent/created` and `agent/disposed`
 * listeners and returns the calling Agent's record, or undefined when the scope is unknown.
 * @param {import('./types.js').SearchServices} scoped
 * @returns {(agent: import('./types.js').SearchExecution['agent']) => { scope: import('./types.js').ScopeSelection } | undefined}
 */
function scopeResolver(scoped) {
  /** @type {Map<string, { scope: import('./types.js').ScopeSelection }>} */
  const records = new Map();
  const unrecorded = () => {
    scoped.logger.warn('knowledge-base: no retrieval scope recorded for a child Agent');
  };
  scoped.on('agent/created', ({ agent, source }) => {
    try {
      const { id, header } = agent.session;
      if (header.origin !== 'subagent' || (source !== 'startup' && source !== 'resume')) return;
      const parentId = header.parentSession;
      const parent = parentId === undefined ? undefined : scoped.agents.get(parentId)?.session;
      // A grandchild, created or resumed, copies its parent's record; only a child of the root
      // snapshots the root's current turn, so a delegation never widens its scope.
      const record =
        parent === undefined
          ? undefined
          : parent.header.origin === 'subagent'
            ? records.get(parent.id)
            : turnScope(scoped.sessionProjections, parent);
      if (record !== undefined) records.set(id, record);
      else {
        records.delete(id);
        unrecorded();
      }
    } catch {
      // A malformed Agent only leaves no record; delegation itself must never fail here.
      unrecorded();
    }
  });
  scoped.on('agent/disposed', ({ agent }) => {
    records.delete(agent.session.id);
  });
  /** @param {import('./types.js').SearchSession} session */
  const scopeOf = (session) =>
    session.header.origin === 'subagent'
      ? records.get(session.id)
      : turnScope(scoped.sessionProjections, session);
  return (agent) => {
    try {
      return agent === undefined ? undefined : scopeOf(agent.session);
    } catch {
      // A broken projection or Session leaves the scope unknown; never search or list wider.
      return undefined;
    }
  };
}

/** @typedef {ReturnType<typeof scopeResolver>} ScopeResolver */

/**
 * The calling Agent's scope, or the result that ends the call before any request: no record, a
 * cancelled call, or an empty selection.
 * @param {ScopeResolver} resolve
 * @param {import('./types.js').SearchExecution} exec
 * @returns {{ scope: import('./types.js').ScopeSelection } | { result: 'scope-unavailable' | 'unavailable' | 'no-scope' }}
 */
function callScope(resolve, exec) {
  const record = resolve(exec.agent);
  if (record === undefined) return { result: 'scope-unavailable' };
  if (exec.signal.aborted) return { result: 'unavailable' };
  if (record.scope?.length === 0) return { result: 'no-scope' };
  return { scope: record.scope };
}

/**
 * `knowledge_base_search`, registered globally so every child Agent sees it; it searches the
 * calling Agent's scope as `scopeResolver` gives it.
 * @param {ScopeResolver} resolve
 * @param {(question: string, scope: import('./types.js').ScopeSelection, signal: AbortSignal) => Promise<import('./types.js').SearchValue>} retrieve
 */
function searchTool(resolve, retrieve) {
  return {
    name: 'knowledge_base_search',
    description:
      '在员工为本轮选定的知识库中检索与问题相关的原文片段，返回片段内容、文件名和所属知识库名称。没有选定知识库、没有结果或知识库不可用时返回中文说明，对话可以继续。',
    parameters: {
      type: 'object',
      required: ['question'],
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: '要检索的问题，用自然语言描述；不能为空，最多 4096 字节（UTF-8）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['result'],
        additionalProperties: false,
        properties: {
          result: { type: 'string', enum: RESULTS },
          chunks: { type: 'array', items: CHUNK_SCHEMA },
          excluded: { type: 'integer' },
        },
      },
      /** @param {unknown} _args @param {import('./types.js').SearchValue} value */
      render: (_args, value) => [{ type: 'text', text: describe(metaOf(value)) }],
      /** @param {unknown} _args @param {import('./types.js').SearchValue} value */
      presentationMeta: (_args, value) => metaOf(value),
    },
    // A list and a retrieval call of 25 seconds each; the Web composition may not enforce it.
    timeoutMs: 60_000,
    /** @param {unknown} args @param {import('./types.js').SearchExecution} exec */
    async execute(args, exec) {
      const question = questionOf(args);
      if (question === undefined) return { result: 'invalid-question' };
      const called = callScope(resolve, exec);
      return 'scope' in called ? retrieve(question, called.scope, exec.signal) : called;
    },
  };
}

const LIST_KEYS = ['library', 'keywords', 'page'];

/**
 * The list arguments: `{}`, or a `library` name with optional `keywords` and a `page` from 1 to
 * 999999 (default 1); undefined for anything else.
 * @param {unknown} args
 * @returns {import('./types.js').ListArgs | undefined}
 */
function listArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  if (!Object.keys(args).every((key) => LIST_KEYS.includes(key))) return undefined;
  const { library, keywords, page } = /** @type {Record<string, unknown>} */ (args);
  if (library === undefined)
    return keywords === undefined && page === undefined ? { page: 1 } : undefined;
  if (!isFilter(library) || (keywords !== undefined && !isFilter(keywords))) return undefined;
  if (page === undefined) return { library, keywords, page: 1 };
  return Number.isSafeInteger(page) && PAGE.test(String(page))
    ? { library, keywords, page: Number(page) }
    : undefined;
}

/**
 * The call's file-name filter, for the text only; undefined unless the arguments carry a valid one.
 * @param {unknown} args
 */
function keywordsOf(args) {
  if (typeof args !== 'object' || args === null) return undefined;
  const { keywords } = /** @type {{ keywords?: unknown }} */ (args);
  return isFilter(keywords) ? keywords : undefined;
}

/**
 * The opening line of one list outcome; names only, never an ID.
 * @param {import('./types.js').ListValue} value
 * @param {string | undefined} keywords the call's filter
 */
function listTitle(value, keywords) {
  if (value.result !== 'ok') return LIST_TEXTS[value.result];
  if (value.libraries !== undefined)
    return `本轮可查看的知识库：${String(value.libraries.length)} 个`;
  const library = `知识库「${flat(value.library ?? '')}」`;
  const matching = keywords === undefined ? '' : `文件名包含「${flat(keywords)}」的`;
  const { total = 0, page = 1, pages = 0 } = value;
  if (total === 0) return `${library}中没有${matching}文件`;
  if (value.files?.length === 0)
    return `${library}第 ${String(page)} 页没有${matching}文件（共 ${String(total)} 个，${String(pages)} 页）`;
  return `${library}中${matching}文件：共 ${String(total)} 个，第 ${String(page)}/${String(pages)} 页`;
}

/**
 * The text the model gets and the expanded tool row shows: the title, one `- ` line per name
 * (line breaks flattened, so a name cannot forge a line) and a hint while later pages remain.
 * @param {import('./types.js').ListValue} value
 * @param {string | undefined} keywords the call's filter
 */
function listText(value, keywords) {
  const lines = [listTitle(value, keywords)];
  for (const name of value.libraries ?? value.files ?? []) lines.push(`- ${flat(name)}`);
  const { page = 1, pages = 0 } = value;
  if ((value.files?.length ?? 0) > 0 && page < pages)
    lines.push(`还有更多文件，可用 page=${String(page + 1)} 查看下一页`);
  return lines.join('\n');
}

/**
 * `knowledge_base_list`, registered globally after `knowledge_base_search`; it lists only the
 * libraries in the calling Agent's scope, so an out-of-scope library reads as a missing one.
 * @param {ScopeResolver} resolve
 * @param {(args: import('./types.js').ListArgs, scope: import('./types.js').ScopeSelection, signal: AbortSignal) => Promise<import('./types.js').ListValue>} list
 */
function listTool(resolve, list) {
  return {
    name: 'knowledge_base_list',
    description:
      '列出员工为本轮选定的知识库名称；指定 library 时列出该知识库中的文件名（每页 20 个，可按文件名关键字筛选）。员工问知识库里有什么、有哪些文件时先用本工具；要查找文件里的具体内容时用 knowledge_base_search。只返回名称，不返回文件内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        library: {
          type: 'string',
          description:
            '知识库名称，须与不带参数调用时列出的名称完全一致；不填时列出本轮可查看的知识库。',
        },
        keywords: {
          type: 'string',
          description:
            '只列出文件名包含该关键字的文件；仅在指定 library 时可用，最多 256 字节（UTF-8）。',
        },
        page: {
          type: 'integer',
          minimum: 1,
          maximum: 999_999,
          description: '文件列表的页码，从 1 开始，默认 1；仅在指定 library 时可用。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['result'],
        additionalProperties: false,
        properties: {
          result: { type: 'string', enum: LIST_RESULTS },
          libraries: { type: 'array', items: { type: 'string' } },
          library: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          pages: { type: 'integer' },
        },
      },
      /** @param {unknown} args @param {import('./types.js').ListValue} value */
      render: (args, value) => [{ type: 'text', text: listText(value, keywordsOf(args)) }],
      /** @param {unknown} args @param {import('./types.js').ListValue} value */
      presentationMeta: (args, value) => ({ ...value, title: listTitle(value, keywordsOf(args)) }),
    },
    // A list and a documents call of 25 seconds each; the Web composition may not enforce it.
    timeoutMs: 60_000,
    /** @param {unknown} args @param {import('./types.js').SearchExecution} exec */
    async execute(args, exec) {
      const parsed = listArgs(args);
      if (parsed === undefined) return { result: 'invalid-request' };
      const called = callScope(resolve, exec);
      return 'scope' in called ? list(parsed, called.scope, exec.signal) : called;
    },
  };
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
  // Without these services the panel still works; the scope control then has no projection.
  ctx.inject(['sessionProjections', 'commands'], (scoped) => {
    scoped.sessionProjections.register(scopeProjection);
    scoped.commands.register(scopeCommand);
  });
  const lifetime = new AbortController();
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled(pending);
  });
  /**
   * One platform request, aborted with `signal` or the plugin's disposal, which awaits it.
   * @param {string} path
   * @param {import('./types.js').PlatformRequest['kind']} kind
   * @param {AbortSignal} signal
   * @param {{ limit?: number; body?: unknown }} [options]
   */
  const request = (path, kind, signal, { limit = LIST_LIMIT, body } = {}) => {
    const task = platformRequest({
      url: `${platform.platformUrl}${path}`,
      token,
      kind,
      limit,
      signal: AbortSignal.any([signal, lifetime.signal]),
      logger: ctx.logger,
      body,
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  /**
   * @param {Request} browser
   * @param {'datasets' | 'documents' | 'chunks'} kind
   * @param {string | null} path
   */
  const forward = (browser, kind, path) =>
    path === null
      ? Promise.resolve(answered({ result: 'invalid-request' }))
      : request(path, kind, browser.signal).then(answered);
  /**
   * The whole scope lists every library first: an empty list retrieves nothing.
   * @type {Parameters<typeof searchTool>[1]}
   */
  const retrieve = async (question, scope, signal) => {
    let datasetIds = scope;
    if (datasetIds === null) {
      const listed = await request(`${PROXY}/datasets`, 'datasets', signal);
      if (!('datasets' in listed)) return { result: listed.result };
      if (listed.datasets.length === 0) return { result: 'no-datasets' };
      datasetIds = listed.datasets.map(({ id }) => id);
    }
    const body = { question, datasetIds };
    const answer = await request(`${PROXY}/retrieval`, 'retrieval', signal, {
      limit: RETRIEVAL_LIMIT,
      body,
    });
    if (!('excluded' in answer)) return { result: answer.result };
    const excluded = answer.excluded.length;
    return 'chunks' in answer
      ? { result: 'ok', chunks: answer.chunks, excluded }
      : { result: 'no-results', excluded };
  };
  /**
   * The in-scope libraries in the proxy's order, then, for a `library`, one page of its files. A
   * name outside the scope is matched like a missing one: no documents request either way.
   * @type {Parameters<typeof listTool>[1]}
   */
  const list = async ({ library, keywords, page }, scope, signal) => {
    const listed = await request(`${PROXY}/datasets`, 'datasets', signal);
    if (!('datasets' in listed)) return failure(listed);
    const visible =
      scope === null ? listed.datasets : listed.datasets.filter(({ id }) => scope.includes(id));
    if (visible.length === 0) return { result: 'no-datasets' };
    if (library === undefined) return { result: 'ok', libraries: visible.map(({ name }) => name) };
    const target = visible.find(({ name }) => name === library);
    if (target === undefined) return { result: 'unknown-library' };
    const path = documentsRoute(target.id, String(page), String(LIST_PAGE_SIZE), keywords);
    const answer = await request(path, 'documents', signal);
    if (!('documents' in answer)) return failure(answer);
    const { total } = answer;
    const files = answer.documents.map(({ name }) => name);
    const pages = Math.ceil(total / LIST_PAGE_SIZE);
    return { result: 'ok', library, files, total, page, pages };
  };
  // Without these services the panel and the scope control still work, without the tools.
  ctx.inject(['tools', 'sessionProjections', 'agents'], (scoped) => {
    const resolve = scopeResolver(scoped);
    scoped.tools.register(searchTool(resolve, retrieve));
    scoped.tools.register(listTool(resolve, list));
  });
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
  ctx.connection.fetch.register({
    path: '/api/knowledge-base.chunks',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => forward(request, 'chunks', chunksPath(request.url)),
  });
}

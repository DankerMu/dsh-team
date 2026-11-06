// @ts-check
/**
 * Host half of the knowledge-base plugin. It validates the platform address the managed overlay
 * may give it, publishes whether the plugin is usable on this instance, and registers the browser
 * routes that forward the sidebar panel's reads to the platform's instance RAGFlow proxy, the
 * `/kb-scope` command and the `kbScope` projection that keep each Session's retrieval scope, and the
 * `knowledge_base_search` tool that retrieves within the root Session's turn snapshot.
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
 * `knowledge_base_search`, registered globally so every child Agent sees it. A root Session
 * searches its own turn snapshot; a child Agent searches the record taken when it was created or
 * resumed, never its own projection, so a delegation cannot widen the scope.
 * @param {import('./types.js').SearchServices} scoped
 * @param {(question: string, scope: import('./types.js').ScopeSelection, signal: AbortSignal) => Promise<import('./types.js').SearchValue>} retrieve
 */
function searchTool(scoped, retrieve) {
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
      let record;
      try {
        record = exec.agent === undefined ? undefined : scopeOf(exec.agent.session);
      } catch {
        // A broken projection or Session leaves the scope unknown; never search wider.
        record = undefined;
      }
      if (record === undefined) return { result: 'scope-unavailable' };
      if (exec.signal.aborted) return { result: 'unavailable' };
      if (record.scope?.length === 0) return { result: 'no-scope' };
      return retrieve(question, record.scope, exec.signal);
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
   * @param {'datasets' | 'documents'} kind
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
  // Without these services the panel and the scope control still work, without the tool.
  ctx.inject(['tools', 'sessionProjections', 'agents'], (scoped) => {
    scoped.tools.register(searchTool(scoped, retrieve));
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
}

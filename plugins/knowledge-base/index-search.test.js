import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from './index.js';

const VALID = 'http://172.30.0.3:8080';
const TOKEN = 'a1'.repeat(32);
const PROXY = `${VALID}/_platform/instance-api/ragflow`;
const FIRST = '0123456789abcdef0123456789abcdef';
const SECOND = 'fedcba9876543210fedcba9876543210';
const QUESTION = '报销需要提交哪些材料';
const HEX_ID = /[0-9a-f]{32}/;

// The fixed texts the fixture pins: one per outcome, and the two additions.
const TEXTS = {
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
const excludedLine = (count) => `有 ${String(count)} 个已选知识库已不可用，已跳过`;
const CHUNK = {
  content: '提交发票和审批单',
  documentName: 'expense-policy.txt',
  datasetName: '制度',
};

/** One available instance: the scoped services the tool injection receives, recorded. */
function world({ services = true } = {}) {
  const tools = [];
  const injected = [];
  const listeners = new Map();
  const states = new Map();
  const agents = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    on: (_event, callback) => callback([]),
    effect: (callback) => effects.push(callback()),
    connection: { fetch: { register: () => () => Promise.resolve() } },
    logger: { warn: (...args) => logs.push(args) },
    inject(deps, callback) {
      injected.push(deps);
      if (!services || !deps.includes('tools')) return;
      callback({
        tools: { register: (definition) => tools.push(definition) },
        sessionProjections: {
          stateOf: (session, key) => (key === 'kbScope' ? states.get(session.id) : undefined),
        },
        agents: { get: (id) => agents.get(id) },
        on: (event, listener) => listeners.set(event, listener),
        logger: { warn: (...args) => logs.push(args) },
      });
    },
  };
  apply(ctx, { platformUrl: VALID });
  /** A live Agent on a Session with the given header fields. */
  const live = (id, header = {}) => {
    const agent = { session: { id, header: { id, ...header } } };
    agents.set(id, agent);
    return agent;
  };
  const child = (id, parent) => live(id, { origin: 'subagent', parentSession: parent.session.id });
  /** The root Session's `kbScope` state with its latest turn snapshot. */
  const turn = (agent, scope, number = 1) =>
    states.set(agent.session.id, {
      child: false,
      selection: scope,
      running: null,
      turn: scope === undefined ? null : { turn: number, scope },
    });
  const created = (agent, source = 'startup') => listeners.get('agent/created')({ agent, source });
  const disposed = (agent) => listeners.get('agent/disposed')({ agent });
  const [tool] = tools;
  const search = (agent, args = { question: QUESTION }, signal = new AbortController().signal) =>
    tool.execute(args, { callId: 'call-1', agent, signal });
  return { tools, tool, injected, listeners, live, child, turn, created, disposed, search, logs };
}

function json(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve(new Response(text, { status }));
}

/** Routes the platform answers by path; every call is recorded by the spy. */
function platform({ datasets = { result: 'ok', datasets: [] }, retrieval } = {}) {
  fetchSpy.mockImplementation((url) => {
    if (url === `${PROXY}/datasets`) return json(datasets);
    if (url === `${PROXY}/retrieval`) return json(retrieval);
    return Promise.reject(new Error('unexpected platform path'));
  });
}
const okRetrieval = (chunks = [CHUNK], excluded = []) => ({ result: 'ok', excluded, chunks });
const retrievalBodies = () =>
  fetchSpy.mock.calls
    .filter(([url]) => url === `${PROXY}/retrieval`)
    .map(([, init]) => JSON.parse(init.body));
const text = (definition, value) => definition.output.render({ question: QUESTION }, value);

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('unexpected platform request')));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('registration', () => {
  it('registers knowledge_base_search once through the tools, projections and agents injection', () => {
    const { tools, injected, listeners } = world();

    expect(injected).toContainEqual(['tools', 'sessionProjections', 'agents']);
    expect(tools.map(({ name }) => name)).toEqual(['knowledge_base_search']);
    expect([...listeners.keys()].sort()).toEqual(['agent/created', 'agent/disposed']);
  });

  it('registers no tool while the injected services are missing', () => {
    const { tools, injected } = world({ services: false });

    expect(injected).toContainEqual(['tools', 'sessionProjections', 'agents']);
    expect(tools).toEqual([]);
  });

  it.each([
    ['no address', undefined, TOKEN],
    ['no token', { platformUrl: VALID }, undefined],
  ])('registers no tool without availability (%s)', (_label, config, token) => {
    vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', token);
    const injected = [];
    const ctx = {
      on: (_event, callback) => callback([]),
      inject: (deps) => injected.push(deps),
    };

    apply(ctx, config);

    expect(injected).toEqual([]);
  });

  it('takes exactly a question and declares the closed output shape', () => {
    const { tool } = world();

    expect(tool.parameters).toEqual({
      type: 'object',
      required: ['question'],
      additionalProperties: false,
      properties: { question: { type: 'string', description: expect.any(String) } },
    });
    expect(tool.timeoutMs).toBe(60_000);
    const { schema } = tool.output;
    expect(schema).toMatchObject({
      type: 'object',
      required: ['result'],
      additionalProperties: false,
    });
    expect(Object.keys(schema.properties).sort()).toEqual(['chunks', 'excluded', 'result']);
    expect([...schema.properties.result.enum].sort()).toEqual(['ok', ...Object.keys(TEXTS)].sort());
    expect(schema.properties.excluded.type).toBe('integer');
    expect(schema.properties.chunks.items).toMatchObject({
      required: ['content', 'documentName', 'datasetName'],
      additionalProperties: false,
    });
  });

  it('keeps the command name, its summary text and dataset IDs out of the definition', () => {
    const { tool } = world();
    const definition = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      schema: tool.output.schema,
    });

    expect(tool.description).toMatch(/[一-鿿]/u);
    expect(definition).not.toContain('kb-scope');
    expect(definition).not.toContain('知识库范围');
    expect(definition).not.toMatch(HEX_ID);
    expect(definition).not.toContain(VALID);
  });
});

describe('root resolution', () => {
  it('searches the root Session turn snapshot for the root itself', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);

    expect(await search(root)).toEqual({ result: 'ok', chunks: [CHUNK], excluded: 0 });
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [FIRST] }]);
  });

  it('treats an employee fork, with a parent but no origin, as its own root', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const fork = live('fork', { parentSession: 'root' });
    turn(fork, [SECOND]);

    await search(fork);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [SECOND] }]);
  });

  it('gives a child and a grandchild the root snapshot of their creation', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const first = child('child', root);
    created(first);
    const second = child('grandchild', first);
    created(second);

    await search(first);
    await search(second);
    expect(retrievalBodies()).toEqual([
      { question: QUESTION, datasetIds: [FIRST] },
      { question: QUESTION, datasetIds: [FIRST] },
    ]);
  });

  it('walks up to 16 live parents on resume and refuses a deeper chain', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    let parent = root;
    const chain = [];
    for (let depth = 1; depth <= 17; depth++) {
      parent = child(`child-${String(depth)}`, parent);
      chain.push(parent);
    }
    created(chain[15], 'resume');
    created(chain[16], 'resume');

    expect(await search(chain[15])).toMatchObject({ result: 'ok' });
    expect(await search(chain[16])).toEqual({ result: 'scope-unavailable' });
    expect(retrievalBodies()).toHaveLength(1);
  });

  it.each([
    ['a parent no longer in memory', 'gone'],
    ['a parent without a projection', 'no-state'],
    ['a root without a turn', 'null-turn'],
  ])('answers scope-unavailable for a child of %s without a request', async (_label, state) => {
    const w = world();
    const root = w.live('root');
    if (state === 'null-turn') w.turn(root, undefined);
    if (state === 'gone') w.turn(root, [FIRST]);
    const agent =
      state === 'gone'
        ? w.live('orphan', { origin: 'subagent', parentSession: 'gone' })
        : w.child('child', root);
    w.created(agent);

    expect(await w.search(agent)).toEqual({ result: 'scope-unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers scope-unavailable for a root without a turn snapshot or projection', async () => {
    const { live, turn, search } = world();
    const root = live('root');
    expect(await search(root)).toEqual({ result: 'scope-unavailable' });
    turn(root, undefined);
    expect(await search(root)).toEqual({ result: 'scope-unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers scope-unavailable without a calling Agent', async () => {
    const { tool } = world();
    const signal = new AbortController().signal;

    expect(await tool.execute({ question: QUESTION }, { callId: 'c', signal })).toEqual({
      result: 'scope-unavailable',
    });
  });

  it('never throws from agent/created, even for a broken header', () => {
    const { listeners } = world();
    const broken = { session: { id: 'x', header: { origin: 'subagent' } } };

    expect(() =>
      listeners.get('agent/created')({ agent: broken, source: 'startup' }),
    ).not.toThrow();
    expect(() => listeners.get('agent/created')({ agent: {}, source: 'startup' })).not.toThrow();
  });
});

describe('child snapshots', () => {
  it('logs one fixed line, without IDs, for each child left without a record', () => {
    const { live, child, turn, created, logs } = world();
    const root = live('root');
    created(child('child', root));
    expect(logs).toEqual([['knowledge-base: no retrieval scope recorded for a child Agent']]);
    turn(root, [FIRST]);
    created(child('second', root));
    created({}, 'startup');
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(FIRST);
  });

  it('keeps the creation turn after the root widens its scope and opens the next turn', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST], 3);
    const agent = child('child', root);
    created(agent);
    turn(root, null, 4);

    await search(agent);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [FIRST] }]);
  });

  it('takes the root turn current at a resume', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, disposed, search } = world();
    const root = live('root');
    turn(root, [FIRST], 1);
    const agent = child('child', root);
    created(agent);
    disposed(agent);
    turn(root, [SECOND], 2);
    created(agent, 'resume');

    await search(agent);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [SECOND] }]);
  });

  it.each(['compact', 'clear'])('keeps the record across a %s announcement', async (source) => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST], 1);
    const agent = child('child', root);
    created(agent);
    turn(root, [SECOND], 2);
    created(agent, source);

    await search(agent);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [FIRST] }]);
  });

  it.each(['compact', 'clear'])(
    'answers scope-unavailable after disposal and a %s announcement',
    async (source) => {
      const { live, child, turn, created, disposed, search } = world();
      const root = live('root');
      turn(root, [FIRST]);
      const agent = child('child', root);
      created(agent);
      disposed(agent);
      created(agent, source);

      expect(await search(agent)).toEqual({ result: 'scope-unavailable' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('copies the parent record to a grandchild instead of the root latest turn', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST], 1);
    const first = child('child', root);
    created(first);
    turn(root, [SECOND], 2);
    const second = child('grandchild', first);
    created(second);

    await search(second);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [FIRST] }]);
  });

  it('gives a grandchild no record when its parent has none', async () => {
    const { live, child, turn, created, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const first = child('child', root);
    const second = child('grandchild', first);
    created(second);

    expect(await search(second)).toEqual({ result: 'scope-unavailable' });
  });

  it('deletes the record on agent/disposed and never reads the child projection', async () => {
    const { live, child, turn, created, disposed, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const agent = child('child', root);
    // A child Session's own fold reads every library; it must never widen the scope.
    turn(agent, null);
    created(agent);
    disposed(agent);

    expect(await search(agent)).toEqual({ result: 'scope-unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers scope-unavailable for a child created before the plugin listened', async () => {
    const { live, child, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);

    expect(await search(child('child', root))).toEqual({ result: 'scope-unavailable' });
  });
});

describe('scope requests', () => {
  it('sends no request at all for an empty scope', async () => {
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, []);

    expect(await search(root)).toEqual({ result: 'no-scope' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists every library for the whole scope, then retrieves over them', async () => {
    platform({
      datasets: {
        result: 'ok',
        datasets: [
          { id: FIRST, name: '制度' },
          { id: SECOND, name: 'policies' },
        ],
      },
      retrieval: okRetrieval(),
    });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, null);

    expect(await search(root)).toEqual({ result: 'ok', chunks: [CHUNK], excluded: 0 });
    expect(fetchSpy.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${PROXY}/datasets`, 'GET'],
      [`${PROXY}/retrieval`, 'POST'],
    ]);
    expect(retrievalBodies()).toEqual([{ question: QUESTION, datasetIds: [FIRST, SECOND] }]);
  });

  it('answers no-datasets for an empty list without retrieving', async () => {
    platform({ datasets: { result: 'ok', datasets: [] } });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, null);

    expect(await search(root)).toEqual({ result: 'no-datasets' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['not-configured', 'unavailable', 'timeout', 'upstream-error', 'invalid-request'])(
    'passes a %s list failure through without retrieving',
    async (result) => {
      platform({ datasets: { result } });
      const { live, turn, search } = world();
      const root = live('root');
      turn(root, null);

      expect(await search(root)).toEqual({ result });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('posts exactly the question and the IDs with the token, JSON and no redirects', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST, SECOND]);
    const question = `  ${QUESTION}\n`;

    await search(root, { question });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${PROXY}/retrieval`);
    expect(init).toEqual({
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question, datasetIds: [FIRST, SECOND] }),
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ['an empty question', { question: '' }],
    ['a blank question', { question: ' \t\n' }],
    ['a U+0085 question', { question: '\u0085' }],
    ['a 4097-byte question', { question: `${'a'.repeat(4095)}é` }],
    ['a non-string question', { question: 7 }],
    ['an extra argument', { question: QUESTION, datasetIds: [FIRST] }],
    ['null arguments', null],
  ])('answers invalid-question for %s without a request', async (_label, args) => {
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);

    expect(await search(root, args)).toEqual({ result: 'invalid-question' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a 4096-byte question', async () => {
    platform({ retrieval: okRetrieval() });
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);

    expect(await search(root, { question: `${'a'.repeat(4094)}é` })).toMatchObject({
      result: 'ok',
    });
  });
});

describe('platform answers', () => {
  async function retrieved(retrieval, status = 200) {
    fetchSpy.mockImplementation(() => json(retrieval, status));
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    return search(root);
  }

  it('counts the excluded libraries and keeps positions only when present', async () => {
    const positioned = { ...CHUNK, positions: [[1, 2, 3, 4, 5]], extra: 'x' };
    expect(await retrieved(okRetrieval([positioned], [SECOND]))).toEqual({
      result: 'ok',
      chunks: [{ ...CHUNK, positions: [[1, 2, 3, 4, 5]] }],
      excluded: 1,
    });
    expect(await retrieved({ result: 'no-results', excluded: [SECOND, FIRST] })).toEqual({
      result: 'no-results',
      excluded: 2,
    });
  });

  it.each(['not-configured', 'unavailable', 'timeout', 'upstream-error', 'invalid-request'])(
    'passes the platform result %s through',
    async (result) => {
      expect(await retrieved({ result })).toEqual({ result });
    },
  );

  it.each([
    ['a missing content', okRetrieval([{ documentName: 'a', datasetName: 'b' }])],
    ['a numeric file name', okRetrieval([{ ...CHUNK, documentName: 1 }])],
    ['a missing dataset name', okRetrieval([{ content: 'a', documentName: 'b' }])],
    ['a null chunk', okRetrieval([null])],
    ['empty positions', okRetrieval([{ ...CHUNK, positions: [] }])],
    ['a four-number position', okRetrieval([{ ...CHUNK, positions: [[1, 2, 3, 4]] }])],
    ['a string position', okRetrieval([{ ...CHUNK, positions: [[1, 2, 3, 4, '5']] }])],
    ['a non-array position list', okRetrieval([{ ...CHUNK, positions: {} }])],
    ['chunks as an object', { result: 'ok', excluded: [], chunks: {} }],
    ['no excluded list', { result: 'ok', chunks: [CHUNK] }],
    ['a numeric exclusion', okRetrieval([CHUNK], [1])],
    ['no-results without exclusions', { result: 'no-results' }],
    ['an unknown result', { result: 'kb-sentinel' }],
    ['an array body', []],
    ['non-JSON', 'kb-sentinel'],
  ])('answers upstream-error for %s', async (_label, body) => {
    expect(await retrieved(body)).toEqual({ result: 'upstream-error' });
  });

  it.each([302, 401, 500])('answers upstream-error for HTTP %s', async (status) => {
    expect(await retrieved(okRetrieval(), status)).toEqual({ result: 'upstream-error' });
  });

  it('accepts an 8 MiB answer and refuses one byte more', async () => {
    const base = JSON.stringify(okRetrieval([{ ...CHUNK, content: '' }]));
    const fill = 8 * 1024 * 1024 - Buffer.byteLength(base);
    const exact = JSON.stringify(okRetrieval([{ ...CHUNK, content: 'a'.repeat(fill) }]));
    expect(Buffer.byteLength(exact)).toBe(8 * 1024 * 1024);
    expect((await retrieved(exact)).result).toBe('ok');
    const over = JSON.stringify(okRetrieval([{ ...CHUNK, content: 'a'.repeat(fill + 1) }]));
    expect(await retrieved(over)).toEqual({ result: 'upstream-error' });
  });

  it('answers unavailable for a transport failure', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);

    expect(await search(root)).toEqual({ result: 'unavailable' });
  });

  /** A platform request that only ends when its signal aborts. */
  const hanging = () =>
    fetchSpy.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

  it('answers timeout once one platform call outlives 25 seconds', async () => {
    vi.useFakeTimers();
    hanging();
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const pending = search(root);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ result: 'timeout' });
  });

  it('answers unavailable when the call is cancelled, before or during its request', async () => {
    hanging();
    const { live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await search(root, { question: QUESTION }, aborted.signal)).toEqual({
      result: 'unavailable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const cancel = new AbortController();
    const pending = search(root, { question: QUESTION }, cancel.signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    cancel.abort();
    expect(await pending).toEqual({ result: 'unavailable' });
  });

  it('logs fixed text only, never the question, a chunk, an ID, the token or the address', async () => {
    fetchSpy.mockImplementation(() => json({ result: 'kb-sentinel' }));
    const { live, turn, search, logs } = world();
    const root = live('root');
    turn(root, [FIRST]);

    await search(root, { question: 'kb-question-sentinel' });
    const logged = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of ['kb-question-sentinel', 'kb-sentinel', FIRST, TOKEN, VALID])
      expect(logged).not.toContain(secret);
  });
});

describe('outcome texts and cards', () => {
  const VALUES = [
    { result: 'ok', chunks: [CHUNK], excluded: 0 },
    { result: 'no-results', excluded: 0 },
    ...Object.keys(TEXTS)
      .filter((result) => result !== 'no-results')
      .map((result) => ({ result })),
  ];
  const card = (tool, value) =>
    tool.presentResult(
      { question: QUESTION },
      {
        content: text(tool, value),
        isError: false,
        meta: tool.output.presentationMeta({ question: QUESTION }, value),
      },
    );

  it('gives the eleven outcomes pairwise distinct model texts and card titles', () => {
    const { tool } = world();
    const texts = VALUES.map((value) => JSON.stringify(text(tool, value)));
    const titles = VALUES.map((value) => card(tool, value).title);

    expect(VALUES).toHaveLength(11);
    expect(new Set(texts).size).toBe(11);
    expect(new Set(titles).size).toBe(11);
    expect(titles[0]).toBe('知识库检索：1 条结果');
    for (const [result, fixed] of Object.entries(TEXTS)) {
      const value = VALUES.find((item) => item.result === result);
      expect(text(tool, value)).toEqual([{ type: 'text', text: fixed }]);
      expect(card(tool, value)).toMatchObject({ card: 'generic', title: fixed });
    }
  });

  it('shows each chunk with its file and library, and the exclusion count', () => {
    const { tool } = world();
    const value = {
      result: 'ok',
      chunks: [CHUNK, { ...CHUNK, content: '第二段', documentName: 'b.pdf', datasetName: '财务' }],
      excluded: 1,
    };
    const [block] = text(tool, value);

    expect(block.text.split('\n')[0]).toBe('知识库检索：2 条结果');
    for (const part of [excludedLine(1), CHUNK.content, CHUNK.documentName, '第二段', '财务'])
      expect(block.text).toContain(part);
    expect(block.text).not.toContain('位置：');
    expect(card(tool, value)).toEqual({
      card: 'generic',
      title: '知识库检索：2 条结果',
      content: [block],
    });
    const [noResults] = text(tool, { result: 'no-results', excluded: 2 });
    expect(noResults.text).toBe(`${TEXTS['no-results']}\n${excludedLine(2)}`);
  });

  it('shows positions verbatim only when the chunk has them', () => {
    const { tool } = world();
    const positions = [
      [3, 10, 20, 30, 40],
      [4, 1, 2, 3, 5],
    ];
    const [block] = text(tool, {
      result: 'ok',
      chunks: [{ ...CHUNK, positions }],
      excluded: 0,
    });

    expect(block.text).toContain(`位置：${JSON.stringify(positions)}`);
    expect(block.text).not.toContain('页');
  });

  it('projects meta without IDs, and the text and card carry no ID, token or address', async () => {
    platform({ retrieval: okRetrieval([CHUNK], [SECOND]) });
    const { tool, live, turn, search } = world();
    const root = live('root');
    turn(root, [FIRST, SECOND]);
    const value = await search(root);
    const meta = tool.output.presentationMeta({ question: QUESTION }, value);

    expect(meta).toEqual({
      result: 'ok',
      title: '知识库检索：1 条结果',
      excluded: 1,
      chunks: [CHUNK],
    });
    expect(tool.output.presentationMeta({ question: QUESTION }, { result: 'timeout' })).toEqual({
      result: 'timeout',
      title: TEXTS.timeout,
      excluded: 0,
      chunks: [],
    });
    const shown = JSON.stringify([meta, text(tool, value), card(tool, value)]);
    for (const secret of [FIRST, SECOND, TOKEN, VALID, 'kb-scope', '知识库范围'])
      expect(shown).not.toContain(secret);
  });

  it.each([
    ['an error result', { content: [], isError: true, meta: { result: 'timeout' } }],
    ['no meta', { content: [], isError: false }],
    ['an unknown result', { content: [], isError: false, meta: { result: 'x', title: 'x' } }],
    [
      'a malformed chunk',
      {
        content: [],
        isError: false,
        meta: { result: 'ok', title: 't', excluded: 0, chunks: [{ content: 1 }] },
      },
    ],
    [
      'a negative exclusion',
      { content: [], isError: false, meta: { result: 'ok', title: 't', excluded: -1, chunks: [] } },
    ],
    ['an array meta', { content: [], isError: false, meta: [] }],
  ])('falls back to the native card for %s', (_label, result) => {
    const { tool } = world();

    expect(tool.presentResult({ question: QUESTION }, result)).toBeUndefined();
  });
});

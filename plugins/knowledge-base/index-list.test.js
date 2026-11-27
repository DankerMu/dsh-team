import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from './index.js';

const ADDRESS = 'http://172.30.0.3:8080';
const TOKEN = 'b2'.repeat(32);
const ROUTE = `${ADDRESS}/_platform/instance-api/ragflow`;
const A = { id: '0123456789abcdef'.repeat(2), name: '制度' };
const B = { id: 'fedcba9876543210'.repeat(2), name: 'policies' };
const C = { id: '00112233445566778899aabbccddeeff', name: '财务' };
const FILES = [
  { id: 'aaaabbbbccccddddeeeeffff00001111', name: 'expense-policy.txt' },
  { id: '1111000022223333444455556666aaaa', name: 'attendance-policy.txt' },
];
const ID = /[0-9a-f]{32}/;
const FORBIDDEN = ['kb-scope', '知识库范围'];

// The fixture's closed list outcomes besides `ok`; each has its own fixed text.
const FAILURES = [
  'no-scope',
  'scope-unavailable',
  'no-datasets',
  'unknown-library',
  'invalid-request',
  'not-configured',
  'timeout',
  'unavailable',
  'upstream-error',
];
const PROXY_FAILURES = ['not-configured', 'unavailable', 'timeout', 'upstream-error'];

/**
 * One available instance with recorded host calls: every `on` registration is kept in order, so a
 * second listener for the same event is counted rather than overwritten.
 */
function instance({ stateOf } = {}) {
  const registered = [];
  const subscriptions = [];
  const scopes = new Map();
  const live = new Map();
  const logs = [];
  const warn = (...args) => logs.push(args);
  apply(
    {
      on: (_event, callback) => callback([]),
      effect: () => undefined,
      connection: { fetch: { register: () => () => Promise.resolve() } },
      logger: { warn },
      inject(deps, callback) {
        if (!deps.includes('agents')) return;
        callback({
          tools: { register: (definition) => registered.push(definition) },
          sessionProjections: {
            stateOf:
              stateOf ??
              ((session, key) => (key === 'kbScope' ? scopes.get(session.id) : undefined)),
          },
          agents: { get: (id) => live.get(id) },
          on: (event, listener) => subscriptions.push({ event, listener }),
          logger: { warn },
        });
      },
    },
    { platformUrl: ADDRESS },
  );
  const emit = (event, payload) => {
    for (const subscription of subscriptions)
      if (subscription.event === event) subscription.listener(payload);
  };
  const tool = registered.find(({ name }) => name === 'knowledge_base_list');
  const agent = (id, header = {}) => {
    const value = { session: { id, header } };
    live.set(id, value);
    return value;
  };
  return {
    registered,
    subscriptions,
    tool,
    logs,
    root: (id, scope) => {
      const value = agent(id);
      scopes.set(id, { child: false, selection: scope, running: null, turn: { turn: 1, scope } });
      return value;
    },
    widen: (id, scope) =>
      scopes.set(id, { child: false, selection: scope, running: null, turn: { turn: 2, scope } }),
    child: (id, parent) => agent(id, { origin: 'subagent', parentSession: parent.session.id }),
    created: (value) => emit('agent/created', { agent: value, source: 'startup' }),
    list: (value, args = {}, signal = new AbortController().signal) =>
      tool.execute(args, { callId: 'list-1', agent: value, signal }),
  };
}

const answer = (body, status = 200) =>
  Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

/** The two proxy list routes; any other URL fails the test through an unexpected request. */
function proxy({
  datasets = [A, B],
  documents = { result: 'ok', total: 2, documents: FILES },
} = {}) {
  requests.mockImplementation((url) => {
    if (url === `${ROUTE}/datasets`)
      return answer(Array.isArray(datasets) ? { result: 'ok', datasets } : datasets);
    if (url.startsWith(`${ROUTE}/datasets/`)) return answer(documents);
    return Promise.reject(new Error('unexpected platform path'));
  });
}
const urls = () => requests.mock.calls.map(([url]) => url);
const shown = (tool, value, args = {}) => ({
  text: tool.output.render(args, value),
  meta: tool.output.presentationMeta(args, value),
});

let requests;
beforeEach(() => {
  requests = vi.fn(() => Promise.reject(new Error('unexpected platform request')));
  vi.stubGlobal('fetch', requests);
  vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('knowledge_base_list registration', () => {
  it('registers after knowledge_base_search, sharing one agent/created and one agent/disposed listener', () => {
    const { registered, subscriptions } = instance();

    expect(registered.map(({ name }) => name)).toEqual([
      'knowledge_base_search',
      'knowledge_base_list',
    ]);
    expect(subscriptions.map(({ event }) => event).sort()).toEqual([
      'agent/created',
      'agent/disposed',
    ]);
  });

  it('takes optional library, keywords and page only, with a 60-second timeout', () => {
    const { tool } = instance();

    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool.parameters.required).toBeUndefined();
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['keywords', 'library', 'page']);
    expect(tool.parameters.properties.page).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 999_999,
    });
    expect(tool.timeoutMs).toBe(60_000);
    const { schema } = tool.output;
    expect(schema).toMatchObject({ required: ['result'], additionalProperties: false });
    expect([...schema.properties.result.enum].sort()).toEqual(['ok', ...FAILURES].sort());
    expect(tool).not.toHaveProperty('presentResult');
  });

  it('points the model at knowledge_base_search for content, without scope command text or IDs', () => {
    const { tool } = instance();
    const definition = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      schema: tool.output.schema,
    });

    expect(tool.description).toContain('knowledge_base_search');
    for (const forbidden of [...FORBIDDEN, ADDRESS]) expect(definition).not.toContain(forbidden);
    expect(definition).not.toMatch(ID);
  });
});

describe('knowledge_base_list scope', () => {
  it('lists only the libraries of the root turn snapshot, in the proxy order', async () => {
    proxy({ datasets: [A, B, C] });
    const w = instance();

    expect(await w.list(w.root('root', [C.id, A.id]))).toEqual({
      result: 'ok',
      libraries: [A.name, C.name],
    });
    expect(urls()).toEqual([`${ROUTE}/datasets`]);
  });

  it('lists every library for the whole scope', async () => {
    proxy({ datasets: [A, B, C] });
    const w = instance();

    expect(await w.list(w.root('root', null))).toEqual({
      result: 'ok',
      libraries: [A.name, B.name, C.name],
    });
  });

  it('answers no-scope for an empty scope without a request', async () => {
    const w = instance();

    expect(await w.list(w.root('root', []))).toEqual({ result: 'no-scope' });
    expect(await w.list(w.root('other', []), { library: A.name })).toEqual({ result: 'no-scope' });
    expect(requests).not.toHaveBeenCalled();
  });

  it('keeps a child on the root snapshot of its creation after the root widens', async () => {
    proxy();
    const w = instance();
    const root = w.root('root', [A.id]);
    const child = w.child('child', root);
    w.created(child);
    w.widen('root', null);

    expect(await w.list(child)).toEqual({ result: 'ok', libraries: [A.name] });
    expect(await w.list(root)).toEqual({ result: 'ok', libraries: [A.name, B.name] });
  });

  it('answers scope-unavailable for a child without a record, or without a calling Agent', async () => {
    const w = instance();
    const child = w.child('child', w.root('root', [A.id]));

    expect(await w.list(child)).toEqual({ result: 'scope-unavailable' });
    expect(await w.tool.execute({}, { callId: 'c', signal: new AbortController().signal })).toEqual(
      { result: 'scope-unavailable' },
    );
    expect(requests).not.toHaveBeenCalled();
  });

  it('answers scope-unavailable when the projection read throws', async () => {
    const w = instance({
      stateOf: () => {
        throw new Error('projection store closed');
      },
    });

    expect(await w.list(w.root('root', null))).toEqual({ result: 'scope-unavailable' });
    expect(requests).not.toHaveBeenCalled();
  });

  it('answers an out-of-scope library exactly like a nonexistent one, without a documents request', async () => {
    proxy();
    const w = instance();
    const root = w.root('root', [A.id]);

    const outside = await w.list(root, { library: B.name });
    const missing = await w.list(root, { library: 'nope' });

    expect(outside).toEqual({ result: 'unknown-library' });
    expect(missing).toEqual(outside);
    expect(shown(w.tool, outside)).toEqual(shown(w.tool, missing));
    expect(urls()).toEqual([`${ROUTE}/datasets`, `${ROUTE}/datasets`]);
  });

  it('matches library names case-sensitively', async () => {
    proxy();
    const w = instance();

    expect(await w.list(w.root('root', null), { library: 'Policies' })).toEqual({
      result: 'unknown-library',
    });
  });

  it('answers no-datasets for an empty list or a scope none of whose libraries is listed', async () => {
    const w = instance();
    proxy({ datasets: [] });
    expect(await w.list(w.root('root', null))).toEqual({ result: 'no-datasets' });
    proxy({ datasets: [B] });
    expect(await w.list(w.root('other', [A.id]), { library: B.name })).toEqual({
      result: 'no-datasets',
    });
    expect(urls()).toEqual([`${ROUTE}/datasets`, `${ROUTE}/datasets`]);
  });
});

describe('knowledge_base_list files', () => {
  it('lists one page of an in-scope library with keywords, total, page and pages', async () => {
    proxy({ documents: { result: 'ok', total: 25, documents: FILES } });
    const w = instance();

    expect(
      await w.list(w.root('root', [A.id]), { library: A.name, keywords: 'expense', page: 2 }),
    ).toEqual({
      result: 'ok',
      library: A.name,
      files: FILES.map(({ name }) => name),
      total: 25,
      page: 2,
      pages: 2,
    });
    expect(urls()).toEqual([
      `${ROUTE}/datasets`,
      `${ROUTE}/datasets/${A.id}/documents?page=2&page_size=20&keywords=expense`,
    ]);
    const [, init] = requests.mock.calls[1];
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
  });

  it('defaults to the first page and encodes keywords as the panel route does', async () => {
    proxy({ documents: { result: 'ok', total: 0, documents: [] } });
    const w = instance();
    const root = w.root('root', null);

    expect(await w.list(root, { library: B.name })).toEqual({
      result: 'ok',
      library: B.name,
      files: [],
      total: 0,
      page: 1,
      pages: 0,
    });
    await w.list(root, { library: B.name, keywords: '报销 制度&x' });
    expect(urls().filter((url) => url.includes('/documents'))).toEqual([
      `${ROUTE}/datasets/${B.id}/documents?page=1&page_size=20`,
      `${ROUTE}/datasets/${B.id}/documents?page=1&page_size=20&keywords=${encodeURIComponent('报销 制度&x')}`,
    ]);
  });

  it.each([
    ['keywords without a library', { keywords: 'expense' }],
    ['a page without a library', { page: 2 }],
    ['page 0', { library: A.name, page: 0 }],
    ['page 1000000', { library: A.name, page: 1_000_000 }],
    ['a fractional page', { library: A.name, page: 1.5 }],
    ['a string page', { library: A.name, page: '2' }],
    ['a blank library', { library: ' \t' }],
    ['a U+0085 library', { library: '\u0085' }],
    ['a 257-byte library', { library: `${'a'.repeat(255)}é` }],
    ['a non-string library', { library: 7 }],
    ['blank keywords', { library: A.name, keywords: ' ' }],
    ['257-byte keywords', { library: A.name, keywords: `${'a'.repeat(255)}é` }],
    ['an extra key', { library: A.name, datasetId: A.id }],
    ['null arguments', null],
    ['array arguments', []],
  ])('answers invalid-request for %s without a request', async (_label, args) => {
    const w = instance();

    expect(await w.list(w.root('root', null), args)).toEqual({ result: 'invalid-request' });
    expect(requests).not.toHaveBeenCalled();
  });

  it('accepts a 256-byte library, 256-byte keywords and page 999999', async () => {
    const name = `${'a'.repeat(254)}é`;
    proxy({ datasets: [{ id: A.id, name }], documents: { result: 'ok', total: 1, documents: [] } });
    const w = instance();
    const value = await w.list(w.root('root', null), {
      library: name,
      keywords: name,
      page: 999_999,
    });

    expect(value).toMatchObject({ result: 'ok', library: name, page: 999_999, pages: 1 });
  });

  it.each(PROXY_FAILURES)('passes a %s list failure through', async (result) => {
    proxy({ datasets: { result } });
    const w = instance();

    expect(await w.list(w.root('root', null))).toEqual({ result });
    expect(await w.list(w.root('other', null), { library: A.name })).toEqual({ result });
    expect(urls()).toEqual([`${ROUTE}/datasets`, `${ROUTE}/datasets`]);
  });

  it.each(PROXY_FAILURES)('passes a %s documents failure through', async (result) => {
    proxy({ documents: { result } });
    const w = instance();

    expect(await w.list(w.root('root', null), { library: A.name })).toEqual({ result });
  });

  it.each([
    ['a malformed list', { datasets: { result: 'ok', datasets: [{ id: 'x', name: 'y' }] } }],
    ['a malformed page', { documents: { result: 'ok', total: -1, documents: [] } }],
  ])('answers upstream-error for %s', async (_label, answers) => {
    proxy(answers);
    const w = instance();

    expect(await w.list(w.root('root', null), { library: A.name })).toEqual({
      result: 'upstream-error',
    });
  });

  it('answers unavailable for a cancelled call without a request', async () => {
    const w = instance();
    const cancelled = new AbortController();
    cancelled.abort();

    expect(await w.list(w.root('root', null), {}, cancelled.signal)).toEqual({
      result: 'unavailable',
    });
    expect(requests).not.toHaveBeenCalled();
  });

  it('logs fixed text only, never the library, the keywords or an ID', async () => {
    proxy({ documents: { result: 'kb-list-sentinel' } });
    const w = instance();

    expect(
      await w.list(w.root('root', null), { library: A.name, keywords: 'kw-sentinel' }),
    ).toEqual({ result: 'upstream-error' });
    const logged = JSON.stringify(w.logs);
    expect(w.logs.length).toBeGreaterThan(0);
    for (const secret of [A.name, 'kw-sentinel', 'kb-list-sentinel', A.id, TOKEN, ADDRESS])
      expect(logged).not.toContain(secret);
  });
});

describe('knowledge_base_list texts and meta', () => {
  it('gives every failure its own fixed text, used as the meta title', () => {
    const { tool } = instance();
    const texts = FAILURES.map((result) => shown(tool, { result }));

    expect(new Set(texts.map(({ text }) => text[0].text)).size).toBe(FAILURES.length);
    for (const [index, result] of FAILURES.entries()) {
      const { text, meta } = texts[index];
      expect(text).toEqual([{ type: 'text', text: meta.title }]);
      expect(meta).toEqual({ result, title: expect.stringMatching(/[一-鿿]/u) });
      for (const forbidden of FORBIDDEN) expect(meta.title).not.toContain(forbidden);
    }
  });

  it('names each listed library on its own line, flattening line breaks', () => {
    const { tool } = instance();
    const value = { result: 'ok', libraries: ['制度', 'a\nb\r\nc d'] };
    const { text, meta } = shown(tool, value);

    expect(text[0].text.split('\n')).toEqual([meta.title, '- 制度', '- a b  c d']);
    expect(meta).toEqual({ ...value, title: meta.title });
    expect(meta.title).toContain('2');
  });

  it('names one page of files with the library, the totals and a next-page hint', () => {
    const { tool } = instance();
    const value = {
      result: 'ok',
      library: '制度',
      files: ['a.txt', 'b\n- c.txt'],
      total: 45,
      page: 2,
      pages: 3,
    };
    const lines = shown(tool, value).text[0].text.split('\n');

    expect(lines[0]).toContain('制度');
    for (const part of ['45', '2', '3']) expect(lines[0]).toContain(part);
    expect(lines.slice(1, 3)).toEqual(['- a.txt', '- b - c.txt']);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('page');
    const last = shown(tool, { ...value, page: 3 }).text[0].text.split('\n');
    expect(last).toHaveLength(3);
  });

  it('says a library has no files, no matching files, or nothing on a page past the end', () => {
    const { tool } = instance();
    const base = { result: 'ok', library: '制度', files: [], page: 1 };
    const empty = { ...base, total: 0, pages: 0 };
    const titles = [
      [empty, {}],
      [empty, { library: '制度', keywords: 'expense' }],
      [{ ...base, total: 3, page: 4, pages: 1 }, {}],
    ].map(([value, args]) => {
      const { text, meta } = shown(tool, value, args);
      expect(text).toEqual([{ type: 'text', text: meta.title }]);
      expect(meta).toEqual({ ...value, title: meta.title });
      return meta.title;
    });

    expect(new Set(titles).size).toBe(3);
    expect(titles[1]).toContain('expense');
  });

  it('names the filter only from valid call arguments, never from the value', () => {
    const { tool } = instance();
    const value = { result: 'ok', library: '制度', files: [], total: 0, page: 1, pages: 0 };
    const plain = shown(tool, value).meta.title;

    for (const args of [null, 'expense', { keywords: ' ' }, { keywords: 7 }])
      expect(shown(tool, value, args).meta.title).toBe(plain);
    expect(shown(tool, value, { keywords: 'a\nb' }).meta.title).toContain('「a b」');
  });

  it('shows names only: no ID, token, address or scope text in a real answer', async () => {
    const w = instance();
    const root = w.root('root', [A.id, B.id]);
    const none = { result: 'ok', total: 0, documents: [] };
    const answers = [
      [undefined, {}],
      [undefined, { library: A.name }],
      [none, { library: A.name }],
      [none, { library: A.name, keywords: 'expense' }],
      [
        { ...none, total: 3 },
        { library: A.name, page: 4 },
      ],
      [{ result: 'ok', total: 45, documents: FILES }, { library: A.name }],
    ];
    const outputs = [];
    for (const [documents, args] of answers) {
      proxy({ documents });
      const value = await w.list(root, args);
      expect(value.result).toBe('ok');
      outputs.push(shown(w.tool, value, args));
    }
    const titles = outputs.map(({ meta }) => meta.title);
    const rendered = JSON.stringify(outputs);

    // Libraries, a page, an empty library, no match, past the end, and a next-page hint.
    expect(new Set(titles).size).toBe(answers.length);
    expect(titles[3]).toContain('expense');
    expect(outputs[5].text[0].text.split('\n').at(-1)).toContain('page=2');
    expect(rendered).toContain(FILES[0].name);
    expect(rendered).not.toMatch(ID);
    for (const secret of [TOKEN, ADDRESS, ...FORBIDDEN]) expect(rendered).not.toContain(secret);
  });
});

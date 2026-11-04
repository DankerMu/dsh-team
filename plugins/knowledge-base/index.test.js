import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { apply, inject, name } from './index.js';

// The one fixed rejection message (the fixture's config contract); it never carries the input.
const REJECTED =
  'knowledge-base config must be absent or exactly { platformUrl: "http://<instance +3 IPv4>:<port>" }';
const GLOBAL = '__DSH_TEAM_KNOWLEDGE_BASE__';
const VALID = 'http://172.30.0.3:8080';
const TOKEN = 'a1'.repeat(32);
const DATASET = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const DATASETS_PATH = '/api/knowledge-base.datasets';
const DOCUMENTS_PATH = '/api/knowledge-base.documents';
const PROXY = `${VALID}/_platform/instance-api/ragflow`;

/** A host context that fails on any use: a rejected config must not reach the host. */
function untouchedContext() {
  const touched = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        touched.push(String(key));
        throw new Error('host context used');
      },
    },
  );
  return { ctx, touched };
}

/** A host context that records every subscription, effect, route and log line. */
function recordingContext() {
  const injections = [];
  const effects = [];
  const routes = new Map();
  const logs = [];
  const log =
    (level) =>
    (...args) =>
      logs.push({ level, args });
  const ctx = {
    on(event, callback) {
      injections.push(event);
      const table = [];
      callback(table);
      injections.push(table);
    },
    effect(callback) {
      effects.push(callback());
    },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error('route registered twice');
          routes.set(route.path, route);
          return () => Promise.resolve();
        },
      },
    },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
  };
  return { ctx, injections, effects, routes, logs };
}

function rejection(config) {
  const { ctx, touched } = untouchedContext();
  try {
    apply(ctx, config);
  } catch (error) {
    expect(touched).toEqual([]);
    return error;
  }
  throw new Error('apply accepted the config');
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('unexpected upstream request')));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('names the host plugin and injects only the connection service', () => {
  expect(name).toBe('dsh-team-knowledge-base');
  expect(inject).toEqual(['connection']);
});

describe('availability', () => {
  const EMPTY = [undefined, null, {}, Object.create(null)];
  it.each(EMPTY.map((config) => [config]))(
    'publishes an unavailable page global and registers nothing without an address (%s)',
    (config) => {
      const { ctx, injections, effects, routes } = recordingContext();

      expect(apply(ctx, config)).toBeUndefined();
      expect(injections).toEqual([
        'webserver/index-inject',
        [{ kind: 'global', name: GLOBAL, value: { available: false } }],
      ]);
      expect(effects).toEqual([]);
      expect(routes.size).toBe(0);
    },
  );

  it.each([
    ['a missing token', undefined],
    ['an empty token', ''],
    ['an upper-case token', 'A1'.repeat(32)],
    ['a short token', 'a'.repeat(63)],
    ['a long token', 'a'.repeat(65)],
    ['a token with a line break', `${'a'.repeat(64)}\n`],
    ['a non-hex token', 'g'.repeat(64)],
  ])('treats %s as unavailable even with an address', (_label, token) => {
    if (token === undefined) vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', undefined);
    else vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', token);
    const { ctx, injections, routes } = recordingContext();

    apply(ctx, { platformUrl: VALID });

    expect(injections[1]).toEqual([{ kind: 'global', name: GLOBAL, value: { available: false } }]);
    expect(routes.size).toBe(0);
  });

  it.each([
    'http://172.30.0.3:8080',
    'http://172.30.0.19:8080',
    'http://10.0.0.3:1',
    'http://10.0.0.3:65535',
    'http://255.255.255.243:443',
    'http://0.0.0.3:80',
  ])('registers both GET routes for the address %s with a valid token', (platformUrl) => {
    for (const config of [{ platformUrl }, Object.assign(Object.create(null), { platformUrl })]) {
      const { ctx, injections, routes } = recordingContext();

      apply(ctx, config);

      expect(injections).toEqual([
        'webserver/index-inject',
        [{ kind: 'global', name: GLOBAL, value: { available: true } }],
      ]);
      expect(
        [...routes.values()].map(({ path, methods, requestBody }) => [path, methods, requestBody]),
      ).toEqual([
        [DATASETS_PATH, ['GET'], 'buffered'],
        [DOCUMENTS_PATH, ['GET'], 'buffered'],
      ]);
      expect(JSON.stringify(injections)).not.toContain(TOKEN);
      expect(JSON.stringify(injections)).not.toContain(platformUrl);
    }
  });
});

it.each([
  ['an extra key', { platformUrl: VALID, token: 'kb-sentinel' }],
  ['only another key', { ragflowApiKey: 'kb-sentinel' }],
  ['a symbol key', { [Symbol('kb-sentinel')]: VALID }],
  ['a numeric address', { platformUrl: 1720003 }],
  ['a null address', { platformUrl: null }],
  ['an object address', { platformUrl: new URL(VALID) }],
  [
    'an accessor address',
    Object.defineProperty({}, 'platformUrl', { get: () => VALID, enumerable: true }),
  ],
  ['an https address', { platformUrl: 'https://172.30.0.3:8080' }],
  ['an upper-case scheme', { platformUrl: 'HTTP://172.30.0.3:8080' }],
  ['a leading-zero octet', { platformUrl: 'http://172.030.0.3:8080' }],
  ['a leading-zero last octet', { platformUrl: 'http://172.30.0.03:8080' }],
  ['an out-of-range octet', { platformUrl: 'http://172.256.0.3:8080' }],
  ['a three-octet address', { platformUrl: 'http://172.30.3:8080' }],
  ['a host name', { platformUrl: 'http://kb-sentinel.invalid:8080' }],
  ['the employee +2 address', { platformUrl: 'http://172.30.0.2:8080' }],
  ['the Document Server +4 address', { platformUrl: 'http://172.30.0.4:8080' }],
  ['a missing port', { platformUrl: 'http://172.30.0.3' }],
  ['an empty port', { platformUrl: 'http://172.30.0.3:' }],
  ['port 0', { platformUrl: 'http://172.30.0.3:0' }],
  ['port 65536', { platformUrl: 'http://172.30.0.3:65536' }],
  ['a leading-zero port', { platformUrl: 'http://172.30.0.3:08080' }],
  ['a path', { platformUrl: `${VALID}/kb-sentinel` }],
  ['a trailing slash', { platformUrl: `${VALID}/` }],
  ['a query', { platformUrl: `${VALID}?kb-sentinel` }],
  ['a fragment', { platformUrl: `${VALID}#kb-sentinel` }],
  ['user information', { platformUrl: 'http://kb-sentinel@172.30.0.3:8080' }],
  ['surrounding whitespace', { platformUrl: ` ${VALID}` }],
  ['a trailing line break', { platformUrl: `${VALID}\n` }],
  ['an array', [VALID]],
  ['a map', new Map([['platformUrl', VALID]])],
  [
    'a class instance',
    new (class Config {
      platformUrl = VALID;
    })(),
  ],
  ['a string config', VALID],
  ['a number config', 3],
  ['a boolean config', true],
])('rejects %s with the fixed TypeError before touching the host', (_label, config) => {
  const error = rejection(config);

  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toBe(REJECTED);
  expect(error.message).not.toContain('kb-sentinel');
  expect(error.message).not.toContain('172.');
});

/** The registered routes of an available instance, plus its recorded logs and effects. */
function availableRoutes() {
  const context = recordingContext();
  apply(context.ctx, { platformUrl: VALID });
  const call = (path, query = '', signal = new AbortController().signal) =>
    context.routes.get(path).fetch(new Request(`http://dsh.internal${path}${query}`, { signal }));
  return { ...context, call };
}

/** A platform answer whose body is the given text or JSON value. */
function platformAnswer(body, init = { status: 200 }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve(new Response(text, init));
}

async function answered(response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

describe('query strings', () => {
  it.each(['?', '?page=1', '?a', '#x'])(
    'answers invalid-request for the datasets query %s without a platform request',
    async (query) => {
      const { call } = availableRoutes();

      expect(await answered(await call(DATASETS_PATH, query))).toEqual({
        result: 'invalid-request',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  const valid = `datasetId=${DATASET}&page=2&pageSize=20`;
  it.each([
    ['no query', ''],
    ['a bare question mark', '?'],
    ['a missing dataset', '?page=1&pageSize=20'],
    ['a missing page', `?datasetId=${DATASET}&pageSize=20`],
    ['a missing page size', `?datasetId=${DATASET}&page=1`],
    ['an upper-case dataset', `?datasetId=${DATASET.toUpperCase()}&page=1&pageSize=20`],
    ['a short dataset', `?datasetId=${DATASET.slice(1)}&page=1&pageSize=20`],
    ['page 0', `?datasetId=${DATASET}&page=0&pageSize=20`],
    ['a leading-zero page', `?datasetId=${DATASET}&page=01&pageSize=20`],
    ['page 1000000', `?datasetId=${DATASET}&page=1000000&pageSize=20`],
    ['page size 0', `?datasetId=${DATASET}&page=1&pageSize=0`],
    ['page size 101', `?datasetId=${DATASET}&page=1&pageSize=101`],
    ['the proxy page size name', `?datasetId=${DATASET}&page=1&page_size=20`],
    ['an unknown key', `?${valid}&extra=1`],
    ['a repeated key', `?${valid}&page=3`],
    ['a valueless key', `?${valid}&keywords`],
    ['an empty item', `?${valid}&`],
    ['a malformed escape', `?${valid}&keywords=%zz`],
    ['a non-UTF-8 escape', `?${valid}&keywords=%ff`],
    ['blank keywords', `?${valid}&keywords=%20%20`],
    ['U+0085 keywords', `?${valid}&keywords=%C2%85`],
    ['plus-only keywords', `?${valid}&keywords=+`],
    ['257-byte keywords', `?${valid}&keywords=${'a'.repeat(255)}%C3%A9`],
    ['a fragment', `?${valid}#kb-sentinel`],
  ])('answers invalid-request for %s without a platform request', async (_label, query) => {
    const { call } = availableRoutes();

    expect(await answered(await call(DOCUMENTS_PATH, query))).toEqual({
      result: 'invalid-request',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['no keywords', '', 'page=2&page_size=20'],
    ['decoded keywords', '&keywords=a%20b%2Bc%25', 'page=2&page_size=20&keywords=a%20b%2Bc%25'],
    ['plus as space', '&keywords=expense+policy', 'page=2&page_size=20&keywords=expense%20policy'],
    [
      '256-byte keywords',
      `&keywords=${'a'.repeat(256)}`,
      `page=2&page_size=20&keywords=${'a'.repeat(256)}`,
    ],
    [
      'non-ASCII keywords',
      '&keywords=%E5%88%B6%E5%BA%A6',
      'page=2&page_size=20&keywords=%E5%88%B6%E5%BA%A6',
    ],
  ])('forwards %s to the proxy documents route', async (_label, suffix, forwarded) => {
    fetchSpy.mockReturnValue(platformAnswer({ result: 'ok', total: 0, documents: [] }));
    const { call } = availableRoutes();

    expect(await answered(await call(DOCUMENTS_PATH, `?${valid}${suffix}`))).toEqual({
      result: 'ok',
      total: 0,
      documents: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${PROXY}/datasets/${DATASET}/documents?${forwarded}`);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: 'manual',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards the datasets request with the instance token and no redirects', async () => {
    fetchSpy.mockReturnValue(
      platformAnswer({
        result: 'ok',
        datasets: [
          { id: DATASET, name: '制度' },
          { id: OTHER, name: 'policies' },
        ],
      }),
    );
    const { call } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({
      result: 'ok',
      datasets: [
        { id: DATASET, name: '制度' },
        { id: OTHER, name: 'policies' },
      ],
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${PROXY}/datasets`);
    expect(init).toMatchObject({
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: 'manual',
    });
  });
});

describe('platform answers', () => {
  const documentsQuery = `?datasetId=${DATASET}&page=1&pageSize=20&keywords=kb-keyword-sentinel`;

  it('keeps only the listed fields of a valid answer', async () => {
    fetchSpy.mockReturnValueOnce(
      platformAnswer({
        result: 'ok',
        datasets: [{ id: DATASET, name: 'a', avatar: 'kb-sentinel' }],
        extra: 1,
      }),
    );
    fetchSpy.mockReturnValueOnce(
      platformAnswer({
        result: 'ok',
        total: 41,
        documents: [{ id: OTHER, name: 'b.txt', size: 3 }],
        extra: 1,
      }),
    );
    const { call } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({
      result: 'ok',
      datasets: [{ id: DATASET, name: 'a' }],
    });
    expect(await answered(await call(DOCUMENTS_PATH, documentsQuery))).toEqual({
      result: 'ok',
      total: 41,
      documents: [{ id: OTHER, name: 'b.txt' }],
    });
  });

  it.each(['not-configured', 'unavailable', 'timeout', 'upstream-error', 'invalid-request'])(
    'passes the platform result %s through on both routes',
    async (result) => {
      fetchSpy.mockImplementation(() => platformAnswer({ result }));
      const { call } = availableRoutes();

      expect(await answered(await call(DATASETS_PATH))).toEqual({ result });
      expect(await answered(await call(DOCUMENTS_PATH, documentsQuery))).toEqual({ result });
    },
  );

  const entries = [
    ['no-results', { result: 'no-results' }, { result: 'no-results' }],
    ['an unknown result', { result: 'kb-sentinel' }, { result: 'kb-sentinel' }],
    ['ok without entries', { result: 'ok' }, { result: 'ok', total: 1 }],
    ['an object list', { result: 'ok', datasets: {} }, { result: 'ok', total: 1, documents: {} }],
    [
      'an invalid ID',
      { result: 'ok', datasets: [{ id: 'kb-sentinel', name: 'a' }] },
      { result: 'ok', total: 1, documents: [{ id: DATASET.toUpperCase(), name: 'a' }] },
    ],
    [
      'an empty name',
      { result: 'ok', datasets: [{ id: DATASET, name: '' }] },
      { result: 'ok', total: 1, documents: [{ id: DATASET, name: '' }] },
    ],
    [
      'a non-string name',
      { result: 'ok', datasets: [{ id: DATASET, name: 3 }] },
      { result: 'ok', total: 1, documents: [{ id: DATASET, name: null }] },
    ],
    [
      'a null entry',
      { result: 'ok', datasets: [null] },
      { result: 'ok', total: 1, documents: [null] },
    ],
    ['an array body', [], []],
    ['a null body', null, null],
    ['a string body', '"ok"', '"ok"'],
    ['non-JSON', 'kb-sentinel', 'kb-sentinel'],
    ['an empty body', '', ''],
  ];
  it.each(entries)('maps %s to upstream-error', async (_label, datasets, documents) => {
    fetchSpy.mockReturnValueOnce(platformAnswer(datasets));
    fetchSpy.mockReturnValueOnce(platformAnswer(documents));
    const { call } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({ result: 'upstream-error' });
    expect(await answered(await call(DOCUMENTS_PATH, documentsQuery))).toEqual({
      result: 'upstream-error',
    });
  });

  it.each([
    ['a negative total', -1],
    ['a fractional total', 1.5],
    ['a string total', '2'],
    ['a missing total', undefined],
  ])('maps a documents answer with %s to upstream-error', async (_label, total) => {
    fetchSpy.mockReturnValue(platformAnswer({ result: 'ok', total, documents: [] }));
    const { call } = availableRoutes();

    expect(await answered(await call(DOCUMENTS_PATH, documentsQuery))).toEqual({
      result: 'upstream-error',
    });
  });

  it.each([
    ['a redirect', 302],
    ['a forbidden answer', 403],
    ['a missing route', 404],
    ['a server error', 500],
    ['a created answer', 201],
  ])('maps %s to upstream-error and drops its body', async (_label, status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    fetchSpy.mockReturnValue(
      Promise.resolve(new Response(body, { status, headers: { location: '/elsewhere' } })),
    );
    const { call, logs } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({ result: 'upstream-error' });
    expect(cancel).toHaveBeenCalled();
    expect(logs).toEqual([
      { level: 'warn', args: ['knowledge-base: platform request failed: %s', 'upstream-error'] },
    ]);
  });

  it('logs the rejected instance token on its own fixed line', async () => {
    fetchSpy.mockReturnValue(platformAnswer({ statusCode: 401 }, { status: 401 }));
    const { call, logs } = availableRoutes();

    expect(await answered(await call(DOCUMENTS_PATH, documentsQuery))).toEqual({
      result: 'upstream-error',
    });
    expect(logs).toEqual([
      { level: 'warn', args: ['knowledge-base: the platform rejected the instance token'] },
      { level: 'warn', args: ['knowledge-base: platform request failed: %s', 'upstream-error'] },
    ]);
  });

  it('maps an answer over 2 MiB to upstream-error while one of exactly 2 MiB passes', async () => {
    const limit = 2 * 1024 * 1024;
    const exact = JSON.stringify({ result: 'ok', datasets: [{ id: DATASET, name: 'a' }] });
    fetchSpy.mockReturnValueOnce(platformAnswer(exact.padEnd(limit, ' ')));
    fetchSpy.mockReturnValueOnce(platformAnswer(exact.padEnd(limit + 1, ' ')));
    const { call } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({
      result: 'ok',
      datasets: [{ id: DATASET, name: 'a' }],
    });
    expect(await answered(await call(DATASETS_PATH))).toEqual({ result: 'upstream-error' });
  });

  it('maps invalid UTF-8 to upstream-error', async () => {
    fetchSpy.mockReturnValue(Promise.resolve(new Response(new Uint8Array([0x7b, 0xff, 0x7d]))));
    const { call } = availableRoutes();

    expect(await answered(await call(DATASETS_PATH))).toEqual({ result: 'upstream-error' });
  });

  it('maps a transport failure, a synchronous throw and an unreadable body to unavailable', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed kb-sentinel')),
    );
    fetchSpy.mockImplementationOnce(() => {
      throw new TypeError('kb-sentinel');
    });
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new Error('kb-sentinel'));
      },
    });
    fetchSpy.mockReturnValueOnce(Promise.resolve(new Response(broken)));
    const { call, logs } = availableRoutes();

    for (let attempt = 0; attempt < 3; attempt++)
      expect(await answered(await call(DATASETS_PATH))).toEqual({ result: 'unavailable' });
    expect(JSON.stringify(logs)).not.toContain('kb-sentinel');
  });
});

/** A platform request that only ends when its signal aborts. */
function hangingFetch() {
  fetchSpy.mockImplementation(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

describe('deadline and cancellation', () => {
  it('answers timeout after 25 seconds without an answer, not before', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const { call } = availableRoutes();
    let settled = false;
    const pending = call(DATASETS_PATH).then((response) => {
      settled = true;
      return response;
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answered(await pending)).toEqual({ result: 'timeout' });
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('applies the deadline through the end of the body', async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":'));
      },
    });
    fetchSpy.mockReturnValue(Promise.resolve(new Response(stalled)));
    const { call } = availableRoutes();
    const pending = call(DOCUMENTS_PATH, `?datasetId=${DATASET}&page=1&pageSize=20`);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await answered(await pending)).toEqual({ result: 'timeout' });
  });

  it('aborts the platform request when the browser disconnects', async () => {
    hangingFetch();
    const { call, logs } = availableRoutes();
    const browser = new AbortController();
    const pending = call(DATASETS_PATH, '', browser.signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    browser.abort();

    expect(await answered(await pending)).toEqual({ result: 'unavailable' });
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
    expect(logs).toEqual([]);
  });

  it('aborts in-flight platform requests when the plugin is disposed and waits for them', async () => {
    hangingFetch();
    const { call, effects } = availableRoutes();
    const pending = call(DATASETS_PATH);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(effects).toHaveLength(1);

    await effects[0]();

    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await answered(await pending)).toEqual({ result: 'unavailable' });
  });
});

it('never logs the keywords, token, platform address or answer body', async () => {
  fetchSpy.mockReturnValueOnce(platformAnswer('kb-body-sentinel', { status: 500 }));
  fetchSpy.mockImplementationOnce(() => Promise.reject(new TypeError('kb-body-sentinel')));
  fetchSpy.mockReturnValueOnce(platformAnswer({ result: 'kb-body-sentinel' }));
  const { call, logs } = availableRoutes();
  const query = `?datasetId=${DATASET}&page=1&pageSize=20&keywords=kb-keyword-sentinel`;

  for (let attempt = 0; attempt < 3; attempt++) await call(DOCUMENTS_PATH, query);

  expect(logs.length).toBeGreaterThan(0);
  const text = JSON.stringify(logs);
  for (const secret of ['kb-keyword-sentinel', 'kb-body-sentinel', TOKEN, '172.30.0.3', DATASET])
    expect(text).not.toContain(secret);
});

it('ships the fixed manifest and exactly one config-free insert row addressed by absolute path', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('./package.json'));

  expect(manifest).toMatchObject({
    name: '@dsh-team/knowledge-base',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'index.js',
    engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'],
      },
    },
  });
  expect(manifest.exports).toEqual({
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json',
  });
  expect(manifest.peerDependencies).toBeUndefined();
  expect(manifest.files).toEqual([
    'package.json',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'README.md',
  ]);
  expect(parse(read('./cordis.patch.yml'))).toEqual([
    { insert: [{ id: 'knowledge-base', name: '/opt/dsh-team/knowledge-base/index.js' }] },
  ]);
});

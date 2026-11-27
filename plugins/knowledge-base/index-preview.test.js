import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apply } from './index.js';

const VALID = 'http://172.30.0.3:8080';
const TOKEN = 'a1'.repeat(32);
const DATASET = '0123456789abcdef0123456789abcdef';
const DOCUMENT = 'fedcba9876543210fedcba9876543210';
const CHUNKS_PATH = '/api/knowledge-base.chunks';
const PROXY = `${VALID}/_platform/instance-api/ragflow`;
const VALID_QUERY = `datasetId=${DATASET}&documentId=${DOCUMENT}&page=2&pageSize=20`;

/** The chunks route of an available instance, with its recorded logs and disposal effects. */
function chunksRoute() {
  const routes = new Map();
  const logs = [];
  const effects = [];
  const ctx = {
    on: (_event, callback) => callback([]),
    effect: (callback) => effects.push(callback()),
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    logger: { warn: (...args) => logs.push(args) },
    inject: () => undefined,
  };
  apply(ctx, { platformUrl: VALID });
  const call = (query = '', signal = new AbortController().signal) =>
    routes
      .get(CHUNKS_PATH)
      .fetch(new Request(`http://dsh.internal${CHUNKS_PATH}${query}`, { signal }));
  return { call, logs, effects };
}

async function answered(response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

function platformAnswer(body, init = { status: 200 }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve(new Response(text, init));
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

it('forwards a valid preview query to the proxy chunks route with the instance token', async () => {
  fetchSpy.mockReturnValue(
    platformAnswer({
      result: 'ok',
      total: 41,
      chunks: [{ content: 'a' }, { content: '<b>x</b>' }],
    }),
  );
  const { call } = chunksRoute();

  expect(await answered(await call(`?${VALID_QUERY}`))).toEqual({
    result: 'ok',
    total: 41,
    chunks: [{ content: 'a' }, { content: '<b>x</b>' }],
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe(`${PROXY}/datasets/${DATASET}/documents/${DOCUMENT}/chunks?page=2&page_size=20`);
  expect(init).toMatchObject({
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'manual',
  });
});

it('accepts the keys in any order and the page and page-size bounds', async () => {
  fetchSpy.mockImplementation(() => platformAnswer({ result: 'ok', total: 0, chunks: [] }));
  const { call } = chunksRoute();
  const query = `pageSize=100&page=999999&documentId=${DOCUMENT}&datasetId=${DATASET}`;

  expect(await answered(await call(`?${query}`))).toEqual({ result: 'ok', total: 0, chunks: [] });
  expect(
    await answered(await call(`?${VALID_QUERY.replace('pageSize=20', 'pageSize=1')}`)),
  ).toEqual({ result: 'ok', total: 0, chunks: [] });
  expect(fetchSpy.mock.calls.map(([url]) => url.split('?')[1])).toEqual([
    'page=999999&page_size=100',
    'page=2&page_size=1',
  ]);
});

it.each([
  ['no query', ''],
  ['a bare question mark', '?'],
  ['a missing document', `?datasetId=${DATASET}&page=1&pageSize=20`],
  ['a missing dataset', `?documentId=${DOCUMENT}&page=1&pageSize=20`],
  ['a missing page', `?datasetId=${DATASET}&documentId=${DOCUMENT}&pageSize=20`],
  ['a missing page size', `?datasetId=${DATASET}&documentId=${DOCUMENT}&page=1`],
  ['an upper-case document', `?${VALID_QUERY.replace(DOCUMENT, DOCUMENT.toUpperCase())}`],
  ['a short document', `?${VALID_QUERY.replace(DOCUMENT, DOCUMENT.slice(1))}`],
  ['an upper-case dataset', `?${VALID_QUERY.replace(DATASET, DATASET.toUpperCase())}`],
  ['page 0', `?${VALID_QUERY.replace('page=2', 'page=0')}`],
  ['page 1000000', `?${VALID_QUERY.replace('page=2', 'page=1000000')}`],
  ['page size 101', `?${VALID_QUERY.replace('pageSize=20', 'pageSize=101')}`],
  ['the proxy page size name', `?${VALID_QUERY.replace('pageSize', 'page_size')}`],
  ['keywords', `?${VALID_QUERY}&keywords=a`],
  ['an unknown key', `?${VALID_QUERY}&extra=1`],
  ['a repeated key', `?${VALID_QUERY}&page=3`],
  ['a valueless key', `?${VALID_QUERY}&documentId`],
  ['an empty item', `?${VALID_QUERY}&`],
  ['an undecodable escape', `?${VALID_QUERY}&%zz=1`],
  ['a fragment', `?${VALID_QUERY}#kb-sentinel`],
])('answers invalid-request for %s without a platform request', async (_label, query) => {
  const { call } = chunksRoute();

  expect(await answered(await call(query))).toEqual({ result: 'invalid-request' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('keeps only the chunk texts and the total of a valid answer', async () => {
  fetchSpy.mockReturnValue(
    platformAnswer({
      result: 'ok',
      total: 1,
      chunks: [{ content: 'a', chunk_id: 'kb-sentinel' }],
      extra: 'kb-sentinel',
    }),
  );
  const { call } = chunksRoute();

  const body = await answered(await call(`?${VALID_QUERY}`));

  expect(body).toEqual({ result: 'ok', total: 1, chunks: [{ content: 'a' }] });
  expect(JSON.stringify(body)).not.toContain('kb-sentinel');
});

it.each(['not-configured', 'unavailable', 'timeout', 'upstream-error', 'invalid-request'])(
  'passes the platform result %s through',
  async (result) => {
    fetchSpy.mockReturnValue(platformAnswer({ result }));
    const { call } = chunksRoute();

    expect(await answered(await call(`?${VALID_QUERY}`))).toEqual({ result });
  },
);

it.each([
  ['no-results', { result: 'no-results', excluded: [] }],
  ['ok without chunks', { result: 'ok', total: 1 }],
  ['ok without a total', { result: 'ok', chunks: [] }],
  ['a negative total', { result: 'ok', total: -1, chunks: [] }],
  ['a string total', { result: 'ok', total: '1', chunks: [] }],
  ['an object chunk list', { result: 'ok', total: 1, chunks: {} }],
  ['a numeric content', { result: 'ok', total: 1, chunks: [{ content: 7 }] }],
  ['a chunk without content', { result: 'ok', total: 1, chunks: [{ text: 'a' }] }],
  ['a null chunk', { result: 'ok', total: 1, chunks: [null] }],
  ['a documents answer', { result: 'ok', total: 1, documents: [] }],
  ['an array body', []],
  ['a null body', null],
  ['non-JSON', 'kb-sentinel'],
  ['an empty body', ''],
])('maps %s to upstream-error and logs fixed text only', async (_label, body) => {
  fetchSpy.mockReturnValue(platformAnswer(body));
  const { call, logs } = chunksRoute();

  expect(await answered(await call(`?${VALID_QUERY}`))).toEqual({ result: 'upstream-error' });
  expect(logs).toEqual([['knowledge-base: platform request failed: %s', 'upstream-error']]);
});

it('maps a platform answer over 2 MiB to upstream-error', async () => {
  const content = 'x'.repeat(2 * 1024 * 1024);
  fetchSpy.mockReturnValue(platformAnswer({ result: 'ok', total: 1, chunks: [{ content }] }));
  const { call } = chunksRoute();

  expect(await answered(await call(`?${VALID_QUERY}`))).toEqual({ result: 'upstream-error' });
});

it('answers timeout after the 25-second deadline', async () => {
  vi.useFakeTimers();
  fetchSpy.mockImplementation(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const { call } = chunksRoute();
  const pending = call(`?${VALID_QUERY}`);

  await vi.advanceTimersByTimeAsync(25_000);
  expect(await answered(await pending)).toEqual({ result: 'timeout' });
});

it('never logs the document, token, platform address or chunk text', async () => {
  fetchSpy.mockReturnValueOnce(platformAnswer('kb-body-sentinel', { status: 500 }));
  fetchSpy.mockReturnValueOnce(
    platformAnswer({ result: 'ok', total: 1, chunks: [{ content: 1 }] }),
  );
  const { call, logs } = chunksRoute();

  await call(`?${VALID_QUERY}`);
  await call(`?${VALID_QUERY}`);

  expect(logs.length).toBe(2);
  const text = JSON.stringify(logs);
  for (const secret of ['kb-body-sentinel', TOKEN, '172.30.0.3', DATASET, DOCUMENT])
    expect(text).not.toContain(secret);
});

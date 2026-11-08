import { afterEach, expect, it, vi } from 'vitest';
import {
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  listRagflowDatasets,
  listRagflowDocuments,
  ragflowVersion,
  testRagflowConnection,
} from './client.ts';

const KEY = 'owned-nonsecret-ragflow-key';
const BASE = 'https://kb.invalid';
const VERSION_BODY = JSON.stringify({ code: 0, data: 'v1.0.0-rc2', message: 'success' });
/** RAGFlow v1.0.0-rc2's `TenantInfoResponse`: tenant and model IDs, no avatar. */
const MODELS_BODY = JSON.stringify({
  code: 0,
  data: {
    tenant_id: 'f'.repeat(32),
    name: "owner's Kingdom",
    llm_id: 'deepseek-chat@DeepSeek',
    embd_id: 'BAAI/bge-m3@Builtin',
    rerank_id: '',
    asr_id: '',
    img2txt_id: '',
    tts_id: '',
    parser_ids: 'naive:General,qa:Q&A,table:Table',
    role: 'owner',
  },
  message: 'success',
});

type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
type Respond = (request: Request, signal: AbortSignal) => Promise<Response> | Response;
function sender(respond: Respond) {
  return vi.fn<Send>((request, init) => Promise.resolve(respond(request, init.signal)));
}
const VERSION_PATH = '/api/v1/system/version';
const MODELS_PATH = '/api/v1/users/me/models';
/** Answers the version step with `version`, the key step with `key` and any other path with 404. */
function steps(version: Respond, key: Respond = () => new Response(MODELS_BODY)) {
  return sender((request, signal) => {
    // A suffix match also serves a saved address with a path prefix.
    const path = new URL(request.url).pathname;
    if (path.endsWith(VERSION_PATH)) return version(request, signal);
    if (path.endsWith(MODELS_PATH)) return key(request, signal);
    return new Response('{"code":404}', { status: 404 });
  });
}
/** The version step went first without the key, then the key step with it, and nothing else. */
function expectProbes(send: ReturnType<typeof sender>) {
  const requests = send.mock.calls.map(([request]) => request);
  expect(
    requests.map((request) => [
      request.method,
      request.url,
      request.redirect,
      request.headers.get('authorization'),
    ]),
  ).toEqual([
    ['GET', `${BASE}${VERSION_PATH}`, 'manual', null],
    ['GET', `${BASE}${MODELS_PATH}`, 'manual', `Bearer ${KEY}`],
  ]);
}
function check(send: Send, settings = { baseURL: BASE, apiKey: KEY }, deadlineMs = 1_000) {
  return testRagflowConnection(settings, new AbortController().signal, deadlineMs, send);
}
/** Endless zero chunks whose first exceeds `limit` by one byte; `pulls` counts the reads. */
function oversizedBody(limit: number, pulls: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.push(pulls.length);
      controller.enqueue(new Uint8Array(pulls.length === 1 ? limit + 1 : 1_048_576));
    },
  });
}
/** A body that stays open until the request signal aborts, like undici's fetch body. */
function heldBody(signal: AbortSignal, first?: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (first !== undefined) controller.enqueue(new TextEncoder().encode(first));
      signal.addEventListener('abort', () => {
        controller.error(signal.reason);
      });
    },
  });
}
function rejectOnAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

it('uses a ten-second per-request deadline and a closed result set', () => {
  expect(RAGFLOW_TIMEOUT_MS).toBe(10_000);
  expect(RAGFLOW_RESULTS).toEqual([
    'ok',
    'not-configured',
    'unavailable',
    'timeout',
    'upstream-error',
    'invalid-request',
    'no-results',
  ]);
});

it("reads the version without the key, then the key's tenant models with the key", async () => {
  const send = steps(() => new Response(VERSION_BODY));

  const outcome = await check(send);

  expect(outcome).toEqual({ result: 'ok', version: 'v1.0.0-rc2' });
  expectProbes(send);
});

it('checks the key without reading a dataset row whose avatar exceeds 64 KiB', async () => {
  const avatar = `data:image/png;base64,${'A'.repeat(65_535 - 22)}`;
  const row = { id: 'a'.repeat(32), name: 'kb', avatar, tenant_avatar: avatar };
  const datasets = JSON.stringify({ code: 0, data: [row], message: 'success' });
  const send = sender((request) => {
    const path = new URL(request.url).pathname;
    if (path === VERSION_PATH) return new Response(VERSION_BODY);
    if (path === '/api/v1/datasets') return new Response(datasets);
    if (path === MODELS_PATH) return new Response(MODELS_BODY);
    return new Response('{"code":404}', { status: 404 });
  });

  const outcome = await check(send);

  expect(avatar).toHaveLength(65_535);
  expect(new TextEncoder().encode(datasets).byteLength).toBeGreaterThan(65_536);
  expect(outcome).toEqual({ result: 'ok', version: 'v1.0.0-rc2' });
  expect(send.mock.calls.some(([request]) => request.url.includes('/api/v1/datasets'))).toBe(false);
});

it.each([
  ['https://kb', 'https://kb/api/v1/system/version'],
  ['https://kb/', 'https://kb/api/v1/system/version'],
  ['https://kb//', 'https://kb/api/v1/system/version'],
  ['https://kb/sub/', 'https://kb/sub/api/v1/system/version'],
])('joins the API path to saved address %j after trailing slashes', async (baseURL, url) => {
  const send = steps(() => new Response(VERSION_BODY));

  await check(send, { baseURL, apiKey: KEY });

  expect(send.mock.calls.map(([request]) => request.url)).toEqual([
    url,
    url.replace('/system/version', '/users/me/models'),
  ]);
});

it.each([
  ['an empty address', { baseURL: '', apiKey: KEY }],
  ['an empty key', { baseURL: BASE, apiKey: '' }],
  ['a key that cannot form a header', { baseURL: BASE, apiKey: `${KEY}\nX-Injected: 1` }],
])('returns not-configured without any request for %s', async (_label, settings) => {
  const send = steps(() => new Response(VERSION_BODY));

  const outcome = await check(send, settings);

  expect(outcome).toEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  [401, '{"code":401,"message":"Invalid access token"}'],
  [403, null],
  [200, '{"code":401,"data":null,"message":"Invalid access token"}'],
] as const)('maps a rejected key (HTTP %i, body %j) to not-configured', async (status, body) => {
  const send = steps(
    () => new Response(VERSION_BODY),
    () => new Response(body, { status }),
  );

  expect(await check(send)).toEqual({ result: 'not-configured' });
  expectProbes(send);
});

it.each([
  [302, null],
  [404, VERSION_BODY],
  [500, VERSION_BODY],
  [200, 'not json'],
  [200, ''],
  [200, 'null'],
  [200, '[0]'],
  [200, '{"data":"v1"}'],
  [200, '{"code":"0","data":"v1"}'],
  [200, '{"code":102,"data":"v1","message":"Unsupported"}'],
  [200, '{"code":109,"data":"v1"}'],
] as const)(
  'maps a version answer of HTTP %i with body %j to upstream-error without listing',
  async (status, body) => {
    const send = steps(() => new Response(body, { status }));

    expect(await check(send)).toEqual({ result: 'upstream-error' });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['missing', { code: 0, message: 'success' }],
  ['a number', { code: 0, data: 1 }],
  ['empty', { code: 0, data: '' }],
  ['65 characters', { code: 0, data: 'v'.repeat(65) }],
  ['a control character', { code: 0, data: 'v1\u0007' }],
  ['non-ASCII', { code: 0, data: 'v1.0.0-版本' }],
])('rejects a version that is %s as upstream-error without listing', async (_label, body) => {
  const send = steps(() => new Response(JSON.stringify(body)));

  expect(await check(send)).toEqual({ result: 'upstream-error' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('accepts a version of exactly 64 printable ASCII characters', async () => {
  const version = ` ~${'x'.repeat(62)}`;
  const send = steps(() => new Response(JSON.stringify({ code: 0, data: version })));

  expect(await check(send)).toEqual({ result: 'ok', version });
});

it.each([
  [302, null],
  [404, MODELS_BODY],
  [200, 'not json'],
  // rc2's answer when the key's tenant is not found.
  [200, '{"code":102,"data":false,"message":"Tenant not found!"}'],
  [200, '{"code":"0"}'],
] as const)(
  'reports a failed key step (HTTP %i, body %j) without the version',
  async (status, body) => {
    const send = steps(
      () => new Response(VERSION_BODY),
      () => new Response(body, { status }),
    );

    expect(await check(send)).toEqual({ result: 'upstream-error' });
    expectProbes(send);
  },
);

it('rejects a body one byte over 64 KiB without reading the remainder', async () => {
  const pulls: number[] = [];
  const oversized = oversizedBody(65_536, pulls);
  const exact = `{"code":0,"data":"v1","p":"${'x'.repeat(65_536 - 29)}"}`;

  expect(new TextEncoder().encode(exact).byteLength).toBe(65_536);
  expect(await check(steps(() => new Response(exact)))).toEqual({ result: 'ok', version: 'v1' });
  expect(await check(steps(() => new Response(oversized)))).toEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it('still limits the connection test key step to 64 KiB', async () => {
  const pulls: number[] = [];
  const send = steps(
    () => new Response(VERSION_BODY),
    () => new Response(oversizedBody(65_536, pulls)),
  );

  const outcome = await check(send);

  expect(outcome).toEqual({ result: 'upstream-error' });
  expectProbes(send);
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it.each([
  ['before a status', (signal: AbortSignal) => rejectOnAbort(signal)],
  ['while reading the body', (signal: AbortSignal) => new Response(heldBody(signal, '{"co'))],
])('reports a deadline %s as timeout', async (_label, respond) => {
  const send = steps(
    () => new Response(VERSION_BODY),
    (_request, signal) => respond(signal),
  );

  expect(await check(send, undefined, 20)).toEqual({ result: 'timeout' });
  expectProbes(send);
});

it('gives each request its own deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Each step spends most of the deadline; one shared deadline would expire in the second.
  const send = sender((request, signal) => {
    vi.advanceTimersByTime(900);
    signal.throwIfAborted();
    return new Response(request.url.includes('/system/') ? VERSION_BODY : MODELS_BODY);
  });

  expect(await check(send, undefined, 1_000)).toEqual({ result: 'ok', version: 'v1.0.0-rc2' });
});

it('reports transport failures before and after a status as unavailable', async () => {
  const refused = steps(() => Promise.reject(new TypeError('fetch failed')));
  const reset = steps(
    () => new Response(VERSION_BODY),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            controller.error(new TypeError('terminated'));
          },
        }),
      ),
  );

  expect(await check(refused)).toEqual({ result: 'unavailable' });
  expect(await check(reset)).toEqual({ result: 'unavailable' });
  expect(refused).toHaveBeenCalledTimes(1);
  expectProbes(reset);
});

it.each(['the version step', 'the key step'])(
  'propagates an external cancellation during %s instead of classifying it',
  async (step) => {
    const owner = new AbortController();
    const held: Respond = (_request, signal) => {
      queueMicrotask(() => {
        owner.abort();
      });
      return new Response(heldBody(signal, '{'));
    };
    const send =
      step === 'the version step' ? steps(held) : steps(() => new Response(VERSION_BODY), held);

    await expect(
      testRagflowConnection({ baseURL: BASE, apiKey: KEY }, owner.signal, 60_000, send),
    ).rejects.toThrow();
  },
);

it('does not send when already cancelled', async () => {
  const owner = new AbortController();
  owner.abort();
  const send = steps(() => new Response(VERSION_BODY));

  await expect(
    testRagflowConnection({ baseURL: BASE, apiKey: KEY }, owner.signal, 1_000, send),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

function version(send: Send, settings = { baseURL: BASE, apiKey: KEY }) {
  return ragflowVersion(settings, new AbortController().signal, 1_000, send);
}

it.each([
  ['an empty address', { baseURL: '', apiKey: KEY }],
  ['an empty key', { baseURL: BASE, apiKey: '' }],
])('reads no version for %s and reports not-configured', async (_label, settings) => {
  const send = steps(() => new Response(VERSION_BODY));

  expect(await version(send, settings)).toEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it('reads only the version, without the key', async () => {
  const send = steps(() => new Response(VERSION_BODY));

  const outcome = await version(send);

  expect(outcome).toEqual({ result: 'ok', version: 'v1.0.0-rc2' });
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]?.[0];
  expect([request?.method, request?.url, request?.redirect]).toEqual([
    'GET',
    'https://kb.invalid/api/v1/system/version',
    'manual',
  ]);
  expect(request?.headers.has('authorization')).toBe(false);
});

it.each([
  [
    'an invalid version string',
    () => new Response(JSON.stringify({ code: 0, data: 'v1\u0007' })),
    'upstream-error',
  ],
  ['a rejected key code', () => new Response('{"code":401}'), 'not-configured'],
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
] as const)('maps %s to its closed result', async (_label, respond, result) => {
  expect(await version(steps(respond))).toEqual({ result });
});

it('still limits the version read alone to 64 KiB', async () => {
  const pulls: number[] = [];

  const outcome = await version(steps(() => new Response(oversizedBody(65_536, pulls))));

  expect(outcome).toEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

const LIST_URL =
  'https://kb.invalid/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
const ID = (index: number) => index.toString(16).padStart(32, '0');
/** RAGFlow v1.0.0-rc2 list rows carry far more than the proxy returns. */
function row(index: number, name = `库 ${String(index)}`): Record<string, unknown> {
  return {
    id: ID(index),
    name,
    description: 'dropped',
    avatar: 'data:image/png;base64,AAAA',
    tenant_avatar: 'data:image/png;base64,BBBB',
    nickname: 'owner',
    tenant_id: 'f'.repeat(32),
    parser_config: { chunk_token_num: 512 },
  };
}
function listing(data: unknown, extra: Record<string, unknown> = {}): string {
  const total = Array.isArray(data) ? data.length : 0;
  return JSON.stringify({ code: 0, data, total_datasets: total, message: 'success', ...extra });
}
function list(send: Send, settings = { baseURL: BASE, apiKey: KEY }, deadlineMs = 1_000) {
  return listRagflowDatasets(settings, new AbortController().signal, deadlineMs, send);
}

it.each([
  ['an empty address', { baseURL: '', apiKey: KEY }],
  ['an empty key', { baseURL: BASE, apiKey: '' }],
  ['a key that cannot form a header', { baseURL: BASE, apiKey: `${KEY}\nX-Injected: 1` }],
])('lists nothing for %s and reports not-configured', async (_label, settings) => {
  const send = sender(() => new Response(listing([])));

  expect(await list(send, settings)).toEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it('lists every dataset once with the key and returns only ids and names in upstream order', async () => {
  const send = sender(() => new Response(listing([row(3), row(1), row(2)])));

  const outcome = await list(send);

  expect(outcome).toEqual({
    result: 'ok',
    datasets: [
      { id: ID(3), name: '库 3' },
      { id: ID(1), name: '库 1' },
      { id: ID(2), name: '库 2' },
    ],
  });
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]?.[0];
  expect([request?.method, request?.url, request?.redirect]).toEqual(['GET', LIST_URL, 'manual']);
  expect(request?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
});

it('reports an empty listing as ok with no datasets', async () => {
  expect(await list(sender(() => new Response(listing([]))))).toEqual({
    result: 'ok',
    datasets: [],
  });
});

it('accepts exactly 1000 datasets and rejects 1001 rather than truncating', async () => {
  const rows = (count: number) => Array.from({ length: count }, (_value, index) => row(index));

  const full = await list(sender(() => new Response(listing(rows(1_000)))));
  const over = await list(sender(() => new Response(listing(rows(1_001)))));

  expect(full.result === 'ok' ? full.datasets.length : full.result).toBe(1_000);
  expect(over).toEqual({ result: 'upstream-error' });
});

it.each([
  ['fewer than the listed entries', { total_datasets: 2 }],
  ['more than the listed entries', { total_datasets: 4 }],
  ['missing', { total_datasets: undefined }],
  ['negative', { total_datasets: -1 }],
  ['fractional', { total_datasets: 1.5 }],
  ['a string', { total_datasets: '3' }],
])('rejects a total_datasets that is %s as upstream-error', async (_label, extra) => {
  const send = sender(() => new Response(listing([row(1), row(2), row(3)], extra)));

  expect(await list(send)).toEqual({ result: 'upstream-error' });
});

it.each([
  ['an uppercase id', { ...row(1), id: 'A'.repeat(32) }],
  ['a 31-character id', { ...row(1), id: 'a'.repeat(31) }],
  ['a numeric id', { ...row(1), id: 1 }],
  ['a missing id', { name: 'x' }],
  ['an empty name', row(1, '')],
  ['a numeric name', { ...row(1), name: 7 }],
  ['a missing name', { id: ID(1) }],
  ['a name over 1024 UTF-8 bytes', row(1, '库'.repeat(341) + 'xx')],
  ['a non-object entry', ID(1)],
  ['a null entry', null],
])('rejects the whole listing when one entry has %s', async (_label, bad) => {
  const send = sender(() => new Response(listing([row(0), bad, row(2)])));

  expect(await list(send)).toEqual({ result: 'upstream-error' });
});

it.each([
  ['a control character', 'a\u0001b', 3],
  ['exactly 1024 UTF-8 bytes of multibyte text', '库'.repeat(341) + 'x', 1_024],
])('accepts a name with %s without judging its content', async (_label, name, bytes) => {
  expect(Buffer.byteLength(name)).toBe(bytes);

  const outcome = await list(sender(() => new Response(listing([row(1, name)]))));

  expect(outcome).toEqual({ result: 'ok', datasets: [{ id: ID(1), name }] });
});

it.each([
  ['a non-array data', JSON.stringify({ code: 0, data: { datasets: [] }, total_datasets: 0 })],
  ['a missing data', JSON.stringify({ code: 0, total_datasets: 0 })],
  ['a duplicate id', listing([row(1), row(2), row(1)])],
  ['a non-zero code', JSON.stringify({ code: 102, data: [], total_datasets: 0 })],
])('rejects a listing with %s as upstream-error', async (_label, body) => {
  expect(await list(sender(() => new Response(body)))).toEqual({ result: 'upstream-error' });
});

it('reads a listing larger than 64 KiB and rejects one byte over 8 MiB unread', async () => {
  const pulls: number[] = [];
  const padded = listing([row(1)], { padding: 'x'.repeat(8_388_608 - 400) });

  const large = await list(sender(() => new Response(padded)));
  const oversized = await list(sender(() => new Response(oversizedBody(8_388_608, pulls))));

  expect(new TextEncoder().encode(padded).byteLength).toBeLessThanOrEqual(8_388_608);
  expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(8_388_608 - 400);
  expect(large).toEqual({ result: 'ok', datasets: [{ id: ID(1), name: '库 1' }] });
  expect(oversized).toEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it.each([
  ['a rejected key', () => new Response('{"code":401}', { status: 401 }), 'not-configured'],
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
] as const)('maps %s while listing to its closed result', async (_label, respond, result) => {
  expect(await list(sender(respond))).toEqual({ result });
});

it('reports a listing body that stalls past the deadline as timeout', async () => {
  const send = sender((_request, signal) => new Response(heldBody(signal, '{"code":0,')));

  expect(await list(send, undefined, 20)).toEqual({ result: 'timeout' });
});

it('propagates an external cancellation while listing instead of classifying it', async () => {
  const owner = new AbortController();
  const send = sender((_request, signal) => {
    queueMicrotask(() => {
      owner.abort();
    });
    return new Response(heldBody(signal, '{'));
  });

  await expect(
    listRagflowDatasets({ baseURL: BASE, apiKey: KEY }, owner.signal, 60_000, send),
  ).rejects.toThrow();
});

const DATASET = 'd'.repeat(32);
const DOCUMENTS_URL = `https://kb.invalid/api/v1/datasets/${DATASET}/documents`;
/** RAGFlow v1.0.0-rc2 document rows carry far more than the proxy returns. */
function documentRow(index: number, name = `文件 ${String(index)}.txt`): Record<string, unknown> {
  return {
    id: ID(index),
    name,
    dataset_id: DATASET,
    thumbnail: 'data:image/png;base64,AAAA',
    location: 'dropped-location',
    created_by: 'f'.repeat(32),
    nickname: 'owner',
    meta_fields: { secret: 'dropped' },
    parser_config: { chunk_token_num: 512 },
  };
}
function page(docs: unknown, total: unknown = Array.isArray(docs) ? docs.length : 0): string {
  return JSON.stringify({ code: 0, data: { total, docs }, message: 'success' });
}
function documents(
  send: Send,
  query: { page: number; pageSize: number; keywords?: string } = { page: 2, pageSize: 30 },
  settings = { baseURL: BASE, apiKey: KEY },
  deadlineMs = 1_000,
) {
  return listRagflowDocuments(
    settings,
    DATASET,
    query,
    new AbortController().signal,
    deadlineMs,
    send,
  );
}

it.each([
  ['an empty address', { baseURL: '', apiKey: KEY }],
  ['an empty key', { baseURL: BASE, apiKey: '' }],
  ['a key that cannot form a header', { baseURL: BASE, apiKey: `${KEY}\nX-Injected: 1` }],
])('lists no documents for %s and reports not-configured', async (_label, settings) => {
  const send = sender(() => new Response(page([])));

  expect(await documents(send, undefined, settings)).toEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it('reads one document page with the key and returns only ids and names in upstream order', async () => {
  const send = sender(() => new Response(page([documentRow(3), documentRow(1)], 42)));

  const outcome = await documents(send);

  expect(outcome).toEqual({
    result: 'ok',
    total: 42,
    documents: [
      { id: ID(3), name: '文件 3.txt' },
      { id: ID(1), name: '文件 1.txt' },
    ],
  });
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]?.[0];
  expect([request?.method, request?.url, request?.redirect]).toEqual([
    'GET',
    `${DOCUMENTS_URL}?page=2&page_size=30&orderby=create_time&desc=false`,
    'manual',
  ]);
  expect(request?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
});

it.each([
  ['报告 a_b%', '%E6%8A%A5%E5%91%8A%20a_b%25'],
  ['a b', 'a%20b'],
  ['a+b', 'a%2Bb'],
  [' a&b=c#d ', '%20a%26b%3Dc%23d%20'],
])('forwards the file-name filter %j untrimmed as %s', async (keywords, encoded) => {
  const send = sender(() => new Response(page([])));

  await documents(send, { page: 1, pageSize: 10, keywords });

  expect(send.mock.calls[0]?.[0].url).toBe(
    `${DOCUMENTS_URL}?page=1&page_size=10&orderby=create_time&desc=false&keywords=${encoded}`,
  );
});

it.each([
  ['an empty page', page([], 0), 0],
  ['a page past the end', page([], 2), 2],
])('reports %s as ok with no documents and the upstream total', async (_label, body, total) => {
  expect(await documents(sender(() => new Response(body)))).toEqual({
    result: 'ok',
    total,
    documents: [],
  });
});

it.each([
  ['a missing dataset (code 404)', '{"code":404,"data":null,"message":"x"}', 'invalid-request'],
  ['a dataset the key cannot read (code 403)', '{"code":403,"message":"x"}', 'invalid-request'],
  ['a rejected key (code 401)', '{"code":401,"message":"x"}', 'not-configured'],
  ['another non-zero code', '{"code":102,"message":"x"}', 'upstream-error'],
] as const)('maps %s to its closed result', async (_label, body, result) => {
  expect(await documents(sender(() => new Response(body)))).toEqual({ result });
});

it('keeps code 404 an upstream-error for the dataset list and the connection test', async () => {
  const missing = () => new Response('{"code":404,"data":null}');

  expect(await list(sender(missing))).toEqual({ result: 'upstream-error' });
  expect(await check(steps(() => new Response(VERSION_BODY), missing))).toEqual({
    result: 'upstream-error',
  });
});

it('accepts a page exactly as long as the requested page size and the total', async () => {
  const rows = [documentRow(1), documentRow(2)];

  const outcome = await documents(
    sender(() => new Response(page(rows, 2))),
    {
      page: 1,
      pageSize: 2,
    },
  );

  expect(outcome.result).toBe('ok');
});

it.each([
  ['more entries than the page size', page([documentRow(1), documentRow(2)], 9), 1],
  ['more entries than the total', page([documentRow(1), documentRow(2)], 1), 30],
  ['a negative total', page([], -1), 30],
  ['a fractional total', page([], 1.5), 30],
  ['a string total', page([], '0'), 30],
  ['a missing total', JSON.stringify({ code: 0, data: { docs: [] } }), 30],
  ['non-array docs', JSON.stringify({ code: 0, data: { total: 0, docs: {} } }), 30],
  ['a null data', JSON.stringify({ code: 0, data: null }), 30],
  ['an entry of another dataset', page([{ ...documentRow(1), dataset_id: 'e'.repeat(32) }]), 30],
  ['an entry without a dataset', page([{ id: ID(1), name: 'x' }]), 30],
  ['an uppercase id', page([{ ...documentRow(1), id: 'A'.repeat(32) }]), 30],
  ['a 31-character id', page([{ ...documentRow(1), id: 'a'.repeat(31) }]), 30],
  ['an empty name', page([documentRow(1, '')]), 30],
  ['a name over 1024 UTF-8 bytes', page([documentRow(1, '库'.repeat(341) + 'xx')]), 30],
  ['a duplicate id', page([documentRow(1), documentRow(2), documentRow(1)]), 30],
])('rejects the whole page with %s as upstream-error', async (_label, body, pageSize) => {
  const send = sender(() => new Response(body));

  expect(await documents(send, { page: 1, pageSize })).toEqual({ result: 'upstream-error' });
});

it('reads a document page larger than 64 KiB and rejects one byte over 8 MiB unread', async () => {
  const pulls: number[] = [];
  const padded = JSON.stringify({
    code: 0,
    data: { total: 1, docs: [documentRow(1)] },
    padding: 'x'.repeat(8_388_608 - 600),
  });

  const large = await documents(sender(() => new Response(padded)));
  const oversized = await documents(sender(() => new Response(oversizedBody(8_388_608, pulls))));

  expect(new TextEncoder().encode(padded).byteLength).toBeLessThanOrEqual(8_388_608);
  expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(65_536);
  expect(large).toEqual({ result: 'ok', total: 1, documents: [{ id: ID(1), name: '文件 1.txt' }] });
  expect(oversized).toEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it.each([
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
  ['a rejected key status', () => new Response(null, { status: 403 }), 'not-configured'],
] as const)(
  'maps %s while reading documents to its closed result',
  async (_label, respond, result) => {
    expect(await documents(sender(respond))).toEqual({ result });
  },
);

it('reports a document page that stalls past the deadline as timeout', async () => {
  const send = sender((_request, signal) => new Response(heldBody(signal, '{"code":0,')));

  expect(await documents(send, undefined, undefined, 20)).toEqual({ result: 'timeout' });
});

it('propagates an external cancellation while reading documents instead of classifying it', async () => {
  const owner = new AbortController();
  const send = sender((_request, signal) => {
    queueMicrotask(() => {
      owner.abort();
    });
    return new Response(heldBody(signal, '{'));
  });

  await expect(
    listRagflowDocuments(
      { baseURL: BASE, apiKey: KEY },
      DATASET,
      { page: 1, pageSize: 10 },
      owner.signal,
      60_000,
      send,
    ),
  ).rejects.toThrow();
});

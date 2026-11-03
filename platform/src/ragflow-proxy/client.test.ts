import { afterEach, expect, it, vi } from 'vitest';
import {
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  listRagflowDatasets,
  ragflowVersion,
  testRagflowConnection,
} from './client.ts';

const KEY = 'owned-nonsecret-ragflow-key';
const BASE = 'https://kb.invalid';
const VERSION_BODY = JSON.stringify({ code: 0, data: 'v1.0.0-rc2', message: 'success' });
const LIST_BODY = JSON.stringify({ code: 0, data: [], message: 'success' });

type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
type Respond = (request: Request, signal: AbortSignal) => Promise<Response> | Response;
function sender(respond: Respond) {
  return vi.fn<Send>((request, init) => Promise.resolve(respond(request, init.signal)));
}
/** Answers the version step with `version` and the list step with `list`. */
function steps(version: Respond, list: Respond = () => new Response(LIST_BODY)) {
  return sender((request, signal) =>
    request.url.includes('/system/version') ? version(request, signal) : list(request, signal),
  );
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
  ]);
});

it('reads the version without the key, then lists one dataset with the key', async () => {
  const send = steps(() => new Response(VERSION_BODY));

  const outcome = await check(send);

  expect(outcome).toEqual({ result: 'ok', version: 'v1.0.0-rc2' });
  const [version, list] = send.mock.calls.map(([request]) => request);
  expect(send).toHaveBeenCalledTimes(2);
  expect([version?.method, version?.url, version?.redirect]).toEqual([
    'GET',
    'https://kb.invalid/api/v1/system/version',
    'manual',
  ]);
  expect(version?.headers.has('authorization')).toBe(false);
  expect([list?.method, list?.url, list?.redirect]).toEqual([
    'GET',
    'https://kb.invalid/api/v1/datasets?page=1&page_size=1',
    'manual',
  ]);
  expect(list?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
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
    url.replace('/system/version', '/datasets?page=1&page_size=1'),
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
  expect(send).toHaveBeenCalledTimes(2);
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
  [404, LIST_BODY],
  [200, '{"code":102,"message":"x"}'],
  [200, '{"code":"0"}'],
] as const)(
  'reports a failed list step (HTTP %i, body %j) without the version',
  async (status, body) => {
    const send = steps(
      () => new Response(VERSION_BODY),
      () => new Response(body, { status }),
    );

    expect(await check(send)).toEqual({ result: 'upstream-error' });
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

it.each([
  ['before a status', (signal: AbortSignal) => rejectOnAbort(signal)],
  ['while reading the body', (signal: AbortSignal) => new Response(heldBody(signal, '{"co'))],
])('reports a deadline %s as timeout', async (_label, respond) => {
  const send = steps(
    () => new Response(VERSION_BODY),
    (_request, signal) => respond(signal),
  );

  expect(await check(send, undefined, 20)).toEqual({ result: 'timeout' });
});

it('gives each request its own deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Each step spends most of the deadline; one shared deadline would expire in the second.
  const send = sender((request, signal) => {
    vi.advanceTimersByTime(900);
    signal.throwIfAborted();
    return new Response(request.url.includes('/system/') ? VERSION_BODY : LIST_BODY);
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
});

it.each(['the version step', 'the list step'])(
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
  ['a control character', 'a\u0001b'],
  ['exactly 1024 UTF-8 bytes of multibyte text', '库'.repeat(341) + 'x'],
])('accepts a name with %s without judging its content', async (_label, name) => {
  expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(1_024);

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

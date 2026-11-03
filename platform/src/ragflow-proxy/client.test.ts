import { afterEach, expect, it, vi } from 'vitest';
import { RAGFLOW_TEST_RESULTS, RAGFLOW_TIMEOUT_MS, testRagflowConnection } from './client.ts';

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
  expect(RAGFLOW_TEST_RESULTS).toEqual([
    'ok',
    'not-configured',
    'unavailable',
    'timeout',
    'upstream-error',
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
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.push(pulls.length);
      controller.enqueue(new Uint8Array(pulls.length === 1 ? 65_537 : 1_048_576));
    },
  });
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

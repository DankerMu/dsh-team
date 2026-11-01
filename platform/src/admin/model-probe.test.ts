import { expect, it, vi } from 'vitest';
import type { Settings } from '../db/index.ts';
import { modelSnapshot } from '../managed-config/index.ts';
import { MODEL_PROBE_DEADLINE_MS, probeModel } from './model-probe.ts';

const KEY = 'owned-nonsecret-probe-key';
const SETTINGS: Settings = {
  idleMinutes: 30,
  cpuCores: 2,
  memoryMiB: 4096,
  maxRunningInstances: 60,
  defaultPermissionTier: 'yolo',
  models: [{ name: 'alpha' }, { name: 'beta' }],
  modelBaseUrl: 'http://models.invalid/v1',
  modelApiKey: KEY,
  defaultModel: 'beta',
  pluginCatalog: {},
  pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  registryProbeEnabled: true,
  webToolsEnabled: false,
};
const COMPLETION = JSON.stringify({ id: 'x', choices: [{ index: 0, message: { content: '' } }] });

type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
function sender(respond: (request: Request, signal: AbortSignal) => Promise<Response> | Response) {
  return vi.fn<Send>((request, init) => Promise.resolve(respond(request, init.signal)));
}
function snapshot(patch: Partial<Settings> = {}) {
  return modelSnapshot({ ...SETTINGS, ...patch });
}
function probe(send: Send, patch: Partial<Settings> = {}, signal = new AbortController().signal) {
  return probeModel(snapshot(patch), signal, 1_000, send);
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

it('uses a twenty-second deadline for the route', () => {
  expect(MODEL_PROBE_DEADLINE_MS).toBe(20_000);
});

it('sends exactly one minimal non-streaming completion with the saved key and default model', async () => {
  const send = sender(() => new Response(COMPLETION, { status: 200 }));

  const outcome = await probe(send);

  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]?.[0];
  expect(request?.url).toBe('http://models.invalid/v1/chat/completions');
  expect(request?.method).toBe('POST');
  expect(request?.redirect).toBe('manual');
  expect(request?.headers.get('content-type')).toBe('application/json');
  expect(request?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(await request?.text()).toBe(
    '{"model":"beta","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}',
  );
  expect(outcome).toMatchObject({ result: 'ok', httpStatus: 200 });
  expect(Number.isSafeInteger(outcome.elapsedMs) && outcome.elapsedMs >= 0).toBe(true);
});

it.each([
  ['http://models.invalid/v1', 'http://models.invalid/v1/chat/completions'],
  ['http://models.invalid/v1/', 'http://models.invalid/v1/chat/completions'],
  ['https://models.invalid/prefix/api', 'https://models.invalid/prefix/api/chat/completions'],
  ['https://www.dmxapi.cn', 'https://www.dmxapi.cn/chat/completions'],
  ['http://models.invalid/v1 ', 'http://models.invalid/v1%20/chat/completions'],
])('forms the DSH completion URL from %j without rewriting it', async (address, expected) => {
  const send = sender(() => new Response(COMPLETION));

  await probe(send, { modelBaseUrl: address });

  expect(send.mock.calls[0]?.[0].url).toBe(expected);
});

it.each<[string, Partial<Settings>]>([
  ['unconfigured', { modelApiKey: ' ' }],
  ['unconfigured', { modelBaseUrl: '' }],
  ['unconfigured', { models: [], defaultModel: '' }],
  ['invalid-address', { modelBaseUrl: 'www.dmxapi.cn/v1' }],
  ['invalid-address', { modelBaseUrl: 'ftp://models.invalid/v1' }],
  ['invalid-address', { modelBaseUrl: 'javascript:alert(1)' }],
  ['invalid-address', { modelBaseUrl: 'http://user:pass@models.invalid/v1' }],
  ['invalid-key', { modelApiKey: 'owned\r\nInjected: header' }],
  ['invalid-key', { modelApiKey: 'owned\u0000key' }],
  ['invalid-key', { modelApiKey: '中文密钥' }],
])('returns %s without any request for %j', async (result, patch) => {
  const send = sender(() => new Response(COMPLETION));

  const outcome = await probe(send, patch);

  expect(outcome).toEqual({ result, httpStatus: null, elapsedMs: 0 });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  [200, COMPLETION, 'ok'],
  [201, '{"choices":[]}', 'ok'],
  [200, 'not json', 'bad-response'],
  [200, '', 'bad-response'],
  [200, '{"choices":{}}', 'bad-response'],
  [200, '{"data":[]}', 'bad-response'],
  [200, '[{"choices":[]}]', 'bad-response'],
  [200, 'null', 'bad-response'],
  [204, null, 'bad-response'],
  [301, COMPLETION, 'bad-response'],
  [302, null, 'bad-response'],
  [401, COMPLETION, 'unauthorized'],
  [403, null, 'unauthorized'],
  [404, COMPLETION, 'not-found'],
  [400, COMPLETION, 'rejected'],
  [422, null, 'rejected'],
  [429, null, 'rejected'],
  [500, COMPLETION, 'server-error'],
  [503, null, 'server-error'],
] as const)('classifies HTTP %i with body %j as %s', async (status, body, result) => {
  const send = sender(() => new Response(body, { status }));

  expect(await probe(send)).toMatchObject({ result, httpStatus: status });
});

it('accepts exactly 64 KiB and rejects one byte more without buffering the remainder', async () => {
  const exact = `{"choices":[],"padding":"${'x'.repeat(65_536 - 27)}"}`;
  const pulls: number[] = [];
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.push(pulls.length);
      controller.enqueue(new Uint8Array(pulls.length === 1 ? 65_537 : 1_048_576));
    },
  });

  expect(new TextEncoder().encode(exact).byteLength).toBe(65_536);
  expect(await probe(sender(() => new Response(exact)))).toMatchObject({ result: 'ok' });
  expect(await probe(sender(() => new Response(oversized)))).toMatchObject({
    result: 'bad-response',
    httpStatus: 200,
  });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it('reports a deadline before any status as timeout with a null status', async () => {
  const send = sender((_request, signal) => rejectOnAbort(signal));

  const outcome = await probeModel(snapshot(), new AbortController().signal, 20, send);

  expect(outcome).toMatchObject({ result: 'timeout', httpStatus: null });
});

it('reports a deadline while reading the body as timeout with the received status', async () => {
  const send = sender((_request, signal) => new Response(heldBody(signal, '{"choi')));

  const outcome = await probeModel(snapshot(), new AbortController().signal, 20, send);

  expect(outcome).toMatchObject({ result: 'timeout', httpStatus: 200 });
});

it('reports transport failures before and after a status as unreachable', async () => {
  const failed = sender(() => Promise.reject(new TypeError('fetch failed')));
  const reset = sender(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      ),
  );

  expect(await probe(failed)).toMatchObject({ result: 'unreachable', httpStatus: null });
  expect(await probe(reset)).toMatchObject({ result: 'unreachable', httpStatus: 200 });
});

it.each(['before a status', 'while reading the body'])(
  'propagates an external cancellation %s instead of classifying it',
  async (phase) => {
    const owner = new AbortController();
    const send = sender((_request, signal) => {
      if (phase === 'before a status') {
        queueMicrotask(() => {
          owner.abort();
        });
        return rejectOnAbort(signal);
      }
      queueMicrotask(() => {
        owner.abort();
      });
      return new Response(heldBody(signal, '{'));
    });

    await expect(probeModel(snapshot(), owner.signal, 60_000, send)).rejects.toThrow();
  },
);

it('does not send when already cancelled', async () => {
  const owner = new AbortController();
  owner.abort();
  const send = sender(() => new Response(COMPLETION));

  await expect(probeModel(snapshot(), owner.signal, 1_000, send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

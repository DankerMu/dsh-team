import { EventEmitter } from 'node:events';
import { IncomingMessage, type RequestOptions } from 'node:http';
import type * as HttpModule from 'node:http';
import { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { readTaskState, taskStateFromResponse } from './task-state.ts';

const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof HttpModule>()),
  request: boundary.request,
}));
afterEach(() => {
  vi.useRealTimers();
  boundary.request.mockReset();
});

it.each([
  [[], 'idle'],
  [[{ running: false }, { running: false }], 'idle'],
  [[{ running: false }, { running: true }], 'busy'],
  [[{ running: true }, { running: 'false' }], 'unknown'],
  [[null], 'unknown'],
  [[{}], 'unknown'],
] as const)(
  'classifies only a complete strict-boolean Session list %j as %s',
  (items, expected) => {
    expect(
      taskStateFromResponse(
        { type: 'server-response', rpcId: 'owned', result: { ok: true, value: { items } } },
        'owned',
      ),
    ).toBe(expected);
  },
);

it.each([
  null,
  {},
  { type: 'client-request' },
  { type: 'server-response', rpcId: 'foreign', result: { ok: true, value: { items: [] } } },
  { type: 'server-response', rpcId: 'owned', result: null },
  { type: 'server-response', rpcId: 'owned', result: { ok: false, value: { items: [] } } },
  { type: 'server-response', rpcId: 'owned', result: { ok: true, value: null } },
  { type: 'server-response', rpcId: 'owned', result: { ok: true, value: {} } },
  { type: 'server-response', rpcId: 'owned', result: { ok: true, value: { items: {} } } },
])('rejects unavailable or mismatched response %j', (document) => {
  expect(taskStateFromResponse(document, 'owned')).toBe('unknown');
});

const input = {
  host: '127.0.0.1',
  port: 3080,
  cookie: 'owned-cookie',
  authority: 'owned.example',
  publicUrl: 'http://owned.example',
};

it.each([
  'idle',
  'busy',
  'bad-status',
  'malformed',
  'partial',
  'oversize',
  'aborted',
  'error',
  'closed',
] as const)('settles and destroys the HTTP resources for %s observations', async (mode) => {
  const socket = new Socket();
  const incoming = new IncomingMessage(socket);
  incoming.statusCode = mode === 'bad-status' ? 401 : 200;
  const outgoing = new EventEmitter();
  const destroy = vi.fn();
  Object.assign(outgoing, {
    destroy,
    end: (body: string) => {
      const envelope: unknown = JSON.parse(body);
      if (typeof envelope !== 'object' || envelope === null || !('rpcId' in envelope))
        throw new Error('Missing fixture request');
      incoming.complete = mode !== 'partial';
      queueMicrotask(() => {
        if (mode === 'aborted' || mode === 'error' || mode === 'closed') {
          incoming.emit(
            mode === 'closed' ? 'close' : mode === 'aborted' ? 'aborted' : 'error',
            new Error('private response'),
          );
          return;
        }
        const bytes =
          mode === 'oversize'
            ? Buffer.alloc(1024 * 1024 + 1)
            : Buffer.from(
                mode === 'malformed'
                  ? '{'
                  : JSON.stringify({
                      type: 'server-response',
                      rpcId: envelope.rpcId,
                      result: { ok: true, value: { items: [{ running: mode === 'busy' }] } },
                    }),
              );
        incoming.emit('data', bytes);
        incoming.emit('end');
      });
    },
  });
  boundary.request.mockImplementation(
    (_options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      receive(incoming);
      return outgoing;
    },
  );
  try {
    expect(await readTaskState({ ...input, signal: new AbortController().signal })).toBe(
      mode === 'idle' || mode === 'busy' ? mode : 'unknown',
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(incoming.destroyed).toBe(true);
  } finally {
    socket.destroy();
  }
});

it('bounds the whole request and rejects aborted or unconstructable probes', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  expect(await readTaskState({ ...input, signal: controller.signal })).toBe('unknown');
  boundary.request.mockImplementation(() => {
    throw new Error('private header');
  });
  expect(await readTaskState({ ...input, signal: new AbortController().signal })).toBe('unknown');
  boundary.request.mockImplementation((options: RequestOptions) => {
    const outgoing = new EventEmitter();
    Object.assign(outgoing, { end: () => undefined, destroy: () => undefined });
    options.signal?.addEventListener('abort', () => outgoing.emit('error', new Error('deadline')));
    return outgoing;
  });
  const result = readTaskState({ ...input, signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(1999);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('unknown');
});

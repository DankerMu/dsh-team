import { once } from 'node:events';
import { IncomingMessage } from 'node:http';
import type { ClientRequest, RequestOptions } from 'node:http';
import { Socket } from 'node:net';
import { Duplex, PassThrough, Writable } from 'node:stream';
import type * as NodeHttp from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cookieHeaders,
  PUBLIC_ORIGIN,
  injectRegister,
  sessionCookieToken,
  withApp,
} from '../../test/auth-fixture.ts';
import { forwardHeaders, requestTarget } from './http.ts';

interface TransportState {
  mode: string;
  destroyed: boolean;
  pending: ClientRequest | undefined;
  socket: Duplex | undefined;
}
const transport = vi.hoisted(() => {
  const state: TransportState = {
    mode: 'response',
    destroyed: false,
    pending: undefined,
    socket: undefined,
  };
  return state;
});
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>();
  return {
    ...actual,
    request: (_options: RequestOptions, receive?: (response: IncomingMessage) => void) => {
      if (transport.mode === 'construct') throw new Error('private endpoint');
      const rawSocket = transport.mode === 'ws' ? transport.socket : undefined;
      const outgoing: Writable =
        rawSocket === undefined
          ? new PassThrough()
          : Object.assign(
              new Writable({
                autoDestroy: false,
                final(done) {
                  // Socket assignment precedes finish; the peer may answer before the write callback.
                  queueMicrotask(() => {
                    outgoing.emit('socket', rawSocket);
                    queueMicrotask(done);
                  });
                },
              }),
              { socket: rawSocket },
            );
      let handedOff = false;
      outgoing.once('upgrade', () => {
        handedOff = true;
      });
      // The controlled external request exposes Node's writable/socket/event contract.
      transport.pending = outgoing as unknown as ClientRequest;
      if (outgoing instanceof PassThrough) outgoing.resume();
      outgoing.once('close', () => {
        transport.destroyed = true;
        if (!handedOff) rawSocket?.destroy();
      });
      queueMicrotask(() => {
        if (transport.mode === 'request') {
          outgoing.emit('error', new Error('private transport'));
          outgoing.emit('error', new Error('second private transport'));
        } else if (transport.mode === 'upgrade') {
          const socket = new PassThrough();
          outgoing.emit('upgrade', {}, socket);
        }
      });
      outgoing.once('finish', () => {
        if (transport.mode !== 'response' && transport.mode !== 'truncated') return;
        const response = Object.assign(new PassThrough(), {
          statusCode: 401,
          headers: {
            'set-cookie': ['backend=private'],
            'content-type': 'application/json',
            connection: 'x-private',
            'x-private': 'private',
          },
        });
        // The external HTTP fixture supplies the IncomingMessage fields consumed by forwarding.
        receive?.(response as unknown as IncomingMessage);
        if (transport.mode === 'truncated') {
          response.write('partial');
          queueMicrotask(() => {
            response.destroy(new Error('private upstream failure'));
          });
        } else response.end('{"upstreamError":true}');
      });
      // The transport fixture implements the writable/event surface consumed by the client.
      return outgoing as unknown as ClientRequest;
    },
  };
});
afterEach(() => {
  transport.mode = 'response';
  transport.destroyed = false;
  transport.pending = undefined;
  transport.socket = undefined;
});

it('removes credential and nominated hop headers without mutating the input', () => {
  const headers = {
    cookie: 'platform=private',
    connection: 'Cookie, X-Hop',
    'x-hop': 'remove',
    accept: 'text/plain',
    'set-cookie': ['backend=private'],
  };

  expect(forwardHeaders(headers, 'cookie')).toEqual({
    accept: 'text/plain',
    'set-cookie': ['backend=private'],
  });
  expect(forwardHeaders(headers, 'set-cookie')).toEqual({ accept: 'text/plain' });
  expect(headers.cookie).toBe('platform=private');
});

it('reconstructs request framing after hop filtering but never invents response framing', () => {
  expect(forwardHeaders({ 'transfer-encoding': 'chunked' }, 'cookie')).toEqual({
    'transfer-encoding': 'chunked',
  });
  expect(
    forwardHeaders({ 'content-length': '11', connection: 'Content-Length' }, 'cookie'),
  ).toEqual({ 'transfer-encoding': 'chunked' });
  expect(forwardHeaders({ 'content-length': '11' }, 'cookie')).toEqual({ 'content-length': '11' });
  expect(forwardHeaders({ 'transfer-encoding': 'chunked' }, 'set-cookie')).toEqual({});
});
it.each([
  ['http://host/api/%2F/../x?q=1', '/api/%2F/../x?q=1'],
  ['https://host?x=1', '/?x=1'],
  ['http://host', '/'],
  ['/raw//path', '/raw//path'],
])('preserves raw target semantics for %s', (input, expected) => {
  expect(requestTarget(input)).toBe(expected);
});

it.each(['construct', 'request', 'upgrade', 'response', 'truncated'])(
  'owns %s transport outcomes without exposing backend credentials',
  async (mode) => {
    transport.mode = mode;
    await withApp(
      async (app, _database, lines) => {
        const registered = await injectRegister(app, {
          email: 'http-unit@example.com',
          password: 'test-password',
        });
        const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;

        const pending = app.inject({
          method: 'POST',
          url: '/api/test',
          headers: { cookie },
          payload: 'bytes',
        });
        if (mode === 'truncated') {
          await expect(pending).rejects.toThrow();
        } else {
          const response = await pending;
          expect(response.statusCode).toBe(mode === 'response' ? 401 : 502);
          expect(response.headers['set-cookie']).toBeUndefined();
          expect(response.headers['x-private']).toBeUndefined();
          expect(response.body).not.toContain('private');
          if (mode === 'response') expect(response.json()).toEqual({ upstreamError: true });
          else expect(response.json()).toMatchObject({ statusCode: 502, error: 'Bad Gateway' });
        }
        expect(lines.join('')).not.toContain('private');
      },
      false,
      [],
      () => ({ host: '127.0.0.1', port: 3080, cookie: 'backend=private' }),
    );
    expect(transport.destroyed).toBe(mode !== 'construct');
  },
);

function controlledPeer(): { socket: Duplex; output: Buffer[] } {
  const output: Buffer[] = [];
  const socket = new Duplex({
    read() {
      /* The external peer supplies data explicitly with push(). */
    },
    write(chunk: Buffer, _encoding, done) {
      output.push(Buffer.from(chunk));
      done();
    },
  });
  return { socket, output };
}

it.each([
  'late',
  'finish-first',
  'upstream-error',
  'client-error',
  'client-end',
  'upstream-end',
  'app-close',
  'construct',
  'rejected',
  'invalid',
])(
  'settles upgrade ownership under the %s transport transition without a second response',
  async (mode) => {
    transport.mode = mode === 'construct' ? 'construct' : 'ws';
    const endTransition = mode === 'finish-first' ? 'client-end' : mode;
    await withApp(
      async (app, _database, lines) => {
        const registered = await injectRegister(app, {
          email: 'ws-unit@example.com',
          password: 'test-password',
        });
        const request = new IncomingMessage(new Socket());
        request.method = 'GET';
        request.url = '/ws';
        request.headers = {
          cookie: `platform_session=${sessionCookieToken(cookieHeaders(registered))}`,
          origin: PUBLIC_ORIGIN,
          upgrade: 'websocket',
        };
        request.rawHeaders = ['Origin', PUBLIC_ORIGIN];
        const client = controlledPeer();
        const upstream = controlledPeer();
        const { promise: clientClosed, resolve: resolveClosed } =
          Promise.withResolvers<undefined>();
        client.socket.once('close', () => {
          resolveClosed(undefined);
        });
        try {
          transport.socket = upstream.socket;
          app.server.emit('upgrade', request, client.socket, Buffer.from([1]));
          const pending = transport.pending;
          if (mode === 'construct') {
            await clientClosed;
            expect(Buffer.concat(client.output).toString()).toMatch(/^HTTP\/1\.1 502 /);
            expect(lines.join('')).not.toContain('private endpoint');
            return;
          }
          expect(pending).toBeDefined();
          if (pending === undefined) throw new Error('Missing controlled transport request');
          await once(pending, mode === 'finish-first' ? 'finish' : 'socket');
          if (mode === 'late') {
            client.socket.destroy();
            await clientClosed;
          }
          if (mode === 'rejected') pending.emit('response', upstream.socket);
          else
            pending.emit(
              'upgrade',
              {
                statusCode: 101,
                headers: {
                  upgrade: mode === 'invalid' ? 'h2c' : 'websocket',
                  'set-cookie': ['backend=private'],
                  'sec-websocket-accept': 'selected',
                },
              },
              upstream.socket,
              Buffer.from([2]),
            );
          if (mode === 'upstream-error') {
            upstream.socket.emit('error', new Error('private upstream'));
            upstream.socket.emit('error', new Error('late private error'));
          } else if (mode === 'client-error')
            client.socket.emit('error', new Error('private peer'));
          else if (endTransition === 'client-end') client.socket.push(null);
          else if (mode === 'upstream-end') upstream.socket.push(null);
          else if (mode === 'app-close') await app.close();
          await clientClosed;

          expect(pending.destroyed).toBe(true);
          expect(upstream.socket.destroyed).toBe(true);
          const output = Buffer.concat(client.output).toString();
          if (mode === 'late') expect(output).toBe('');
          else if (mode === 'invalid' || mode === 'rejected')
            expect(output).toMatch(/^HTTP\/1\.1 502 /);
          else {
            expect(output).toMatch(/^HTTP\/1\.1 101 /);
            expect(output).not.toContain('502');
          }
          expect(output.toLowerCase()).not.toContain('set-cookie');
          expect(lines.join('')).not.toContain('private');
        } finally {
          client.socket.destroy();
          upstream.socket.destroy();
          request.socket.destroy();
        }
      },
      false,
      [],
      () => ({ host: '127.0.0.1', port: 3080, cookie: 'backend=private' }),
    );
  },
);

it('refuses a queued upgrade arriving after shutdown starts without acquiring another upstream', async () => {
  transport.mode = 'ws';
  let resolutions = 0;
  await withApp(
    async (app) => {
      const registered = await injectRegister(app, {
        email: 'ws-closing@example.com',
        password: 'test-password',
      });
      const request = new IncomingMessage(new Socket());
      request.method = 'GET';
      request.url = '/ws';
      request.headers = {
        cookie: `platform_session=${sessionCookieToken(cookieHeaders(registered))}`,
        origin: PUBLIC_ORIGIN,
        upgrade: 'websocket',
      };
      request.rawHeaders = ['Origin', PUBLIC_ORIGIN];
      const first = controlledPeer();
      const arriving = controlledPeer();
      try {
        app.server.emit('upgrade', request, first.socket, Buffer.alloc(0));
        first.socket.once('close', () => {
          app.server.emit('upgrade', request, arriving.socket, Buffer.alloc(0));
        });
        await app.close();

        expect(arriving.socket.destroyed).toBe(true);
        expect(resolutions).toBe(1);
        expect(Buffer.concat(arriving.output).toString()).not.toContain('101');
      } finally {
        first.socket.destroy();
        arriving.socket.destroy();
        request.socket.destroy();
      }
    },
    false,
    [],
    () => {
      resolutions += 1;
      return { host: '127.0.0.1', port: 3080, cookie: 'backend=private' };
    },
  );
});

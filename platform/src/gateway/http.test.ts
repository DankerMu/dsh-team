import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type * as NodeHttp from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  sessionCookieToken,
  withApp,
} from '../../test/auth-fixture.ts';
import { forwardHeaders, requestTarget } from './http.ts';

const transport = vi.hoisted(() => ({ mode: 'response', destroyed: false }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>();
  const { PassThrough } = await import('node:stream');
  return {
    ...actual,
    request: (_options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      if (transport.mode === 'construct') throw new Error('private endpoint');
      const outgoing = new PassThrough();
      outgoing.resume();
      outgoing.once('close', () => {
        transport.destroyed = true;
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
        receive(response as unknown as IncomingMessage);
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

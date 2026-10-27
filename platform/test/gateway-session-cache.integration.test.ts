import { once } from 'node:events';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import { PUBLIC_ORIGIN } from './auth-fixture.ts';
import {
  reader,
  rejectedUpgrade,
  sendHttp,
  withForwardingApp,
  withUpstream,
} from './gateway-http-fixture.ts';

const IMMUTABLE = 'private, max-age=31536000, immutable';
const SESSION_VARY = 'Cookie';
const UPSTREAM: Record<string, { status: number; headers: OutgoingHttpHeaders; body: string }> = {
  '/page': { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>page</p>' },
  '/assets/index-5SrrfWpU.js': {
    status: 200,
    headers: { 'content-type': 'text/javascript' },
    body: 'export {};',
  },
  '/moved': { status: 301, headers: { location: '/page', 'x-upstream': 'moved' }, body: '' },
  '/missing': { status: 404, headers: { 'content-type': 'text/plain' }, body: 'missing' },
  '/encoded': {
    status: 200,
    headers: { 'content-type': 'text/plain', vary: 'Accept-Encoding' },
    body: 'encoded',
  },
  '/keyed': { status: 200, headers: { 'content-type': 'text/plain', vary: 'cookie' }, body: 'k' },
  '/any': { status: 200, headers: { 'content-type': 'text/plain', vary: '*' }, body: 'any' },
};

function withoutTransport(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const transport = new Set([
    'date',
    'connection',
    'keep-alive',
    'content-length',
    'transfer-encoding',
    'vary',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !transport.has(name)));
}

it.each([
  ['/page', SESSION_VARY, {}],
  ['/assets/index-5SrrfWpU.js', SESSION_VARY, { 'cache-control': IMMUTABLE }],
  ['/moved', SESSION_VARY, {}],
  ['/missing', SESSION_VARY, {}],
  ['/encoded', `Accept-Encoding, ${SESSION_VARY}`, {}],
  ['/keyed', 'cookie', {}],
  ['/any', '*', {}],
] as const)('forwards %s with Vary %s and nothing else changed', async (path, vary, added) => {
  const expected = UPSTREAM[path];
  if (expected === undefined) throw new Error('Missing upstream case');
  await withUpstream(
    (request, response) => {
      const selected = UPSTREAM[request.url ?? ''];
      if (selected === undefined) throw new Error('Unexpected upstream path');
      response.writeHead(selected.status, selected.headers);
      response.end(selected.body);
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const response = await sendHttp(base, { path, headers: { cookie } });

          expect(response.status).toBe(expected.status);
          expect(response.headers.vary).toBe(vary);
          expect(withoutTransport(response.headers)).toEqual({
            ...expected.headers,
            ...added,
            vary: undefined,
          });
          expect(response.body.toString()).toBe(expected.body);
        },
      );
    },
  );
});

it('leaves platform answers, gateway redirects and unavailable answers without the session Vary', async () => {
  await withForwardingApp(
    () => ({ outcome: 'stopped' }),
    async ({ base, cookie }) => {
      const answers = [
        await sendHttp(base, { path: '/_platform/login' }),
        await sendHttp(base, { path: '/_platform/api/session', headers: { cookie } }),
        await sendHttp(base, { path: '/', headers: { accept: 'text/html' } }),
        await sendHttp(base, { path: '/', headers: { accept: 'text/html', cookie } }),
        await sendHttp(base, { path: '/', headers: { cookie } }),
      ];

      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 302, 302, 503]);
      for (const answer of answers) expect(answer.headers.vary ?? '').not.toMatch(/cookie/i);
    },
  );
});

it('keeps a WebSocket 101 free of the session Vary', async () => {
  await withUpstream(
    (_request, response) => {
      response.end();
    },
    async (target, server) => {
      server.on('upgrade', (_request, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nVary: Accept\r\n\r\n',
        );
      });
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const address = new URL(base);
          const client = connect(Number(address.port), address.hostname);
          const read = reader(client);
          try {
            await once(client, 'connect');
            client.write(
              `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${PUBLIC_ORIGIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`,
            );
            const head = (await read('\r\n\r\n')).toString();

            expect(head).toMatch(/^HTTP\/1\.1 101 /);
            expect(head).toContain('vary: Accept\r\n');
            expect(head.toLowerCase()).not.toMatch(/cookie/);
          } finally {
            client.destroy();
          }
        },
      );
    },
  );
});

it('refuses an admitted Service-Worker script fetch with 403 and never reaches the instance', async () => {
  const reached: (string | undefined)[] = [];
  await withUpstream(
    (request, response) => {
      const header = request.headers['service-worker'];
      reached.push(typeof header === 'string' ? header : undefined);
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('// worker');
    },
    async (target: GatewayUpstream) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie }) => {
          const refused = await sendHttp(base, {
            path: '/sw.js',
            headers: { cookie, 'service-worker': 'script' },
          });
          const anonymous = await sendHttp(base, {
            path: '/sw.js',
            headers: { 'service-worker': 'script' },
          });
          const plain = await sendHttp(base, { path: '/sw.js', headers: { cookie } });

          expect(refused.status).toBe(403);
          expect(JSON.parse(refused.body.toString()) as unknown).toEqual({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Forbidden',
          });
          expect(refused.headers.vary).toBeUndefined();
          expect(anonymous.status).toBe(401);
          expect(plain.status).toBe(200);
          expect(plain.body.toString()).toBe('// worker');
          expect(reached).toEqual([undefined]);
        },
      );
    },
  );
});

it('adds the shadowing-cookie expiries only to a duplicate-cookie upgrade refusal', async () => {
  await withForwardingApp(
    () => ({ outcome: 'stopped' }),
    async ({ base, cookie }) => {
      const shadowed = await rejectedUpgrade(
        base,
        `${cookie}; platform_session=${'b'.repeat(64)}`,
        [`Origin: ${PUBLIC_ORIGIN}`, 'Upgrade: websocket'],
        '/ws/events?x=1',
      );
      const single = await rejectedUpgrade(base, `platform_session=${'b'.repeat(64)}`, [
        `Origin: ${PUBLIC_ORIGIN}`,
        'Upgrade: websocket',
      ]);

      expect(shadowed).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
      expect(shadowed.split('\r\n').filter((line) => line.startsWith('Set-Cookie: '))).toEqual(
        ['/ws/events/', '/ws/events', '/ws/', '/ws'].map(
          (path) => `Set-Cookie: platform_session=; Path=${path}; Max-Age=0`,
        ),
      );
      expect(single).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
      expect(single.toLowerCase()).not.toContain('set-cookie');
    },
  );
});

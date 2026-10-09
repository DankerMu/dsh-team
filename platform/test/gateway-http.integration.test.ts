import type { RequestListener } from 'node:http';
import { expect, it } from 'vitest';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import {
  cookieHeaders,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
} from './auth-fixture.ts';
import { sendHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';

it('forwards malformed JSON bytes with only the selected DSH cookie and preserves upstream error bodies', async () => {
  const observed: unknown[] = [];
  await withUpstream(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        observed.push({
          method: request.method,
          path: request.url,
          host: request.headers.host,
          cookie: request.headers.cookie,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(401, {
          'content-type': 'application/json',
          'set-cookie': ['dsh-auth=hidden', 'another=hidden'],
        });
        response.end('{"upstream":"selected","extra":42}');
      });
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, cookie, lines }) => {
          const response = await sendHttp(
            base,
            {
              method: 'POST',
              path: '/api/test?instance=forged',
              headers: { cookie: `theme=dark; ${cookie}`, 'content-type': 'application/json' },
            },
            '{',
          );

          expect(response.status).toBe(401);
          expect(response.body.toString()).toBe('{"upstream":"selected","extra":42}');
          expect(response.headers['set-cookie']).toBeUndefined();
          expect(observed).toEqual([
            {
              method: 'POST',
              path: '/api/test?instance=forged',
              host: '127.0.0.1:8080',
              cookie: target.cookie,
              body: '{',
            },
          ]);
          expect(lines.join('')).not.toContain('FST_ERR_REP_ALREADY_SENT');
        },
      );
    },
  );
});

it('binds two users to their own endpoint-cookie pair despite forged routing and hop headers', async () => {
  const observed: unknown[] = [];
  const handler =
    (label: string): RequestListener =>
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        observed.push({
          label,
          method: request.method,
          path: request.url,
          host: request.headers.host,
          cookie: request.headers.cookie,
          hop: request.headers['x-hop'],
          body: Buffer.concat(chunks),
        });
        response.writeHead(202, {
          'x-upstream': label,
          connection: 'x-private',
          'x-private': 'remove',
          'set-cookie': ['dsh-auth=private', 'another=private'],
        });
        response.end(label);
      });
    };
  await withUpstream(handler('A'), async (a) => {
    await withUpstream(handler('B'), async (b) => {
      const destinations = new Map<string, GatewayUpstream>();
      const selected: string[] = [];
      await withForwardingApp(
        (id) => {
          selected.push(id);
          return destinations.get(id);
        },
        async ({ base, app, cookie, userId }) => {
          const registered = await injectRegister(app, {
            email: 'second@example.com',
            password: 'test-password',
          });
          const otherId = readPublicIdentity(registered.json<unknown>()).id;
          const otherCookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
          destinations.set(userId, a);
          destinations.set(otherId, b);
          const body = Buffer.from([0, 255, 123, 125]);
          const path = `/api/%2Fraw/../upload?user=${otherId}&instance=forged`;

          for (const [credential, label, id] of [
            [cookie, 'A', userId],
            [otherCookie, 'B', otherId],
          ] as const) {
            const response = await sendHttp(
              base,
              {
                method: 'POST',
                path: `http://untrusted.invalid${path}`,
                headers: {
                  cookie: [credential, 'dsh-auth=forged', 'theme=dark'],
                  host: 'untrusted.invalid',
                  'x-forwarded-host': 'untrusted.invalid',
                  'x-user-id': otherId,
                  'content-type': 'application/octet-stream',
                  connection: 'Cookie, Host, X-Hop',
                  'x-hop': 'remove',
                },
              },
              body,
            );
            expect(response.status).toBe(202);
            expect(response.body.toString()).toBe(label);
            expect(response.headers['set-cookie']).toBeUndefined();
            expect(response.headers['x-private']).toBeUndefined();
            expect(response.headers['x-upstream']).toBe(label);
            expect(selected.at(-1)).toBe(id);
          }
          expect(observed).toEqual([
            {
              label: 'A',
              method: 'POST',
              path,
              host: '127.0.0.1:8080',
              cookie: a.cookie,
              hop: undefined,
              body,
            },
            {
              label: 'B',
              method: 'POST',
              path,
              host: '127.0.0.1:8080',
              cookie: b.cookie,
              hop: undefined,
              body,
            },
          ]);
          expect(selected).toEqual([userId, otherId]);
        },
      );
    });
  });
});

it('never resolves platform or anonymous traffic and preserves unavailable destinations', async () => {
  const selected: string[] = [];
  await withForwardingApp(
    (id) => {
      selected.push(id);
      return undefined;
    },
    async ({ base, cookie, userId }) => {
      expect((await sendHttp(base, { path: '/healthz', headers: { cookie } })).status).toBe(200);
      expect(
        (await sendHttp(base, { path: '/_platform/missing', headers: { cookie } })).status,
      ).toBe(404);
      expect((await sendHttp(base, { path: '/api/test' })).status).toBe(401);
      expect(selected).toEqual([]);
      expect((await sendHttp(base, { path: '/', headers: { cookie } })).status).toBe(503);
      expect(selected).toEqual([userId]);
    },
  );
});

it.each(['resolver', 'endpoint', 'reset', 'upgrade'] as const)(
  'returns safe 502 for %s failure and remains usable',
  async (failure) => {
    let failing = true;
    await withUpstream(
      (request, response) => {
        if (failing && failure === 'reset') {
          request.socket.destroy();
          return;
        }
        if (failing && failure === 'upgrade') {
          response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }).flushHeaders();
          return;
        }
        response.end('healthy');
      },
      async (target) => {
        await withForwardingApp(
          () => {
            if (failing && failure === 'resolver') throw new Error('private resolver diagnostic');
            return failing && failure === 'endpoint' ? { ...target, port: -1 } : target;
          },
          async ({ base, cookie, lines }) => {
            const response = await sendHttp(base, { headers: { cookie } });
            expect(response.status).toBe(502);
            expect(JSON.parse(response.body.toString()) as unknown).toEqual({
              statusCode: 502,
              error: 'Bad Gateway',
              message: 'Instance unavailable',
            });
            expect(`${response.body.toString()}${lines.join('')}`).not.toContain(
              'private resolver diagnostic',
            );
            expect(lines.join('')).not.toContain(target.cookie);
            failing = false;
            expect((await sendHttp(base, { headers: { cookie } })).body.toString()).toBe('healthy');
          },
        );
      },
    );
  },
);

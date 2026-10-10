import { once } from 'node:events';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { deleteUserSessions } from '../src/auth/index.ts';
import { PUBLIC_ORIGIN } from './auth-fixture.ts';
import { sendHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';
import {
  registerAccount,
  sessionTimes,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';

it('redirects anonymous HTML navigation to the fixed platform login without parsing a body', async () => {
  await withListeningApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/_platform/login');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

async function upgrade(
  baseUrl: string,
  path = '/',
  cookie = '',
  authority?: string,
  origin = PUBLIC_ORIGIN,
): Promise<string> {
  const url = new URL(baseUrl);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = connect(Number(url.port), url.hostname);
  let response = '';
  // Bound a broken real peer; completion is EOF, never elapsed time.
  socket.setTimeout(2_000, () => socket.destroy(new Error('Upgrade did not close')));
  socket.on('error', reject);
  socket.on('data', (chunk: Buffer) => {
    response += chunk.toString();
  });
  socket.on('end', () => {
    resolve(response);
  });
  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${authority ?? url.host}\r\nOrigin: ${origin}\r\nAccept: text/html\r\nX-Forwarded-Host: ${authority ?? url.host}\r\nX-User-Id: someone-else\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
    );
  });
  return promise;
}

it('rejects an anonymous real WebSocket upgrade with a complete 401 response and EOF', async () => {
  await withListeningApp(async (baseUrl) => {
    const response = await upgrade(baseUrl);

    expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(response).toContain('\r\nConnection: close\r\n');
    expect(response).not.toContain('Set-Cookie');
  });
});

it('preserves platform routes and rejects instance bodies before parsing them', async () => {
  await withListeningApp(async (baseUrl, app) => {
    await registerAccount(app, 'gateway@example.com');
    const login = await successfulLogin(baseUrl, 'gateway@example.com');
    const cookie = `platform_session=${login.token}`;

    expect((await fetch(`${baseUrl}/healthz?probe=1`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/_platform/missing`, { headers: { cookie } })).status).toBe(404);
    for (const headers of [{}, { cookie }]) {
      for (const type of ['application/json', 'application/octet-stream']) {
        const response = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          headers: { ...headers, 'content-type': type },
          body: '{',
        });
        expect(response.status).toBe('cookie' in headers ? 503 : 401);
        expect(await response.json()).toMatchObject({ statusCode: response.status });
      }
    }
    expect((await fetch(`${baseUrl}/`, { headers: { cookie } })).status).toBe(503);
    expect(await upgrade(baseUrl, '/_platform/missing', cookie)).toMatch(/^HTTP\/1\.1 404 /);
  });
});

it.each(['missing', 'malformed', 'duplicate', 'expired', 'revoked', 'disabled'] as const)(
  'rejects %s sessions on HTTP and actual upgrades after prior valid admission',
  async (state) => {
    await withListeningApp(async (baseUrl, app, database) => {
      const user = await registerAccount(app, 'gateway@example.com');
      const login = await successfulLogin(baseUrl, 'gateway@example.com');
      let cookie = `platform_session=${login.token}`;
      expect((await fetch(`${baseUrl}/api/test`, { headers: { cookie } })).status).toBe(503);
      expect(await upgrade(baseUrl, '/', cookie)).toMatch(/^HTTP\/1\.1 503 /);
      switch (state) {
        case 'missing':
          cookie = '';
          break;
        case 'malformed':
          cookie = 'platform_session=not-a-token';
          break;
        case 'duplicate':
          cookie = `${cookie}; ${cookie}`;
          break;
        case 'expired':
          database
            .prepare('UPDATE platform_sessions SET last_activity_at = ?')
            .run(Date.now() - 8 * 86_400_000);
          break;
        case 'revoked':
          deleteUserSessions(database, user.id);
          break;
        case 'disabled':
          database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
          break;
      }

      const response = await fetch(`${baseUrl}/api/test`, { headers: { cookie } });
      const handshake = await upgrade(baseUrl, '/', cookie);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
      });
      expect(handshake).toMatch(/^HTTP\/1\.1 401 /);
      expect(handshake).not.toContain(login.token);
    });
  },
);

it('renews an active session through either gateway entrypoint and fails closed on storage failure', async () => {
  await withListeningApp(async (baseUrl, app, database, lines) => {
    await registerAccount(app, 'gateway@example.com');
    const { token } = await successfulLogin(baseUrl, 'gateway@example.com');
    const cookie = `platform_session=${token}`;
    for (const upgraded of [false, true]) {
      const started = Date.now();
      const before = started - 120_000;
      database.prepare('UPDATE platform_sessions SET last_activity_at = ?').run(before);

      if (upgraded) await upgrade(baseUrl, '/', cookie);
      else await fetch(`${baseUrl}/api/test`, { headers: { cookie } });

      const row = sessionTimes(database, token);
      expect(row.last_activity_at).toBeGreaterThanOrEqual(started);
      expect(row.last_activity_at).toBeLessThanOrEqual(Date.now());
    }
    database.exec('DROP TABLE platform_sessions');
    const response = await fetch(`${baseUrl}/api/test`, { headers: { cookie } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(await upgrade(baseUrl, '/', cookie)).toMatch(
      /^HTTP\/1\.1 500 Internal Server Error\r\n/,
    );
    const errors: unknown[] = lines
      .map((line) => JSON.parse(line) as unknown)
      .filter(
        (line) => typeof line === 'object' && line !== null && 'level' in line && line.level === 50,
      );
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(errors)).not.toContain(token);
    expect(JSON.stringify(errors)).not.toContain('platform_sessions');
  });
});

it('ignores forged authorities and remains live after an aborted upgrade', async () => {
  const observer = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  let connections = 0;
  observer.listen(0, '127.0.0.1');
  await once(observer, 'listening');
  try {
    const target = observer.address();
    if (target === null || typeof target === 'string') throw new Error('Missing observer address');
    const authority = `127.0.0.1:${String(target.port)}`;
    await withListeningApp(async (baseUrl, app) => {
      await registerAccount(app, 'gateway@example.com');
      const { token } = await successfulLogin(baseUrl, 'gateway@example.com');
      const cookie = `platform_session=${token}`;
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const attempt = request(
        new URL(`/api/other?instance=${authority}`, baseUrl),
        {
          headers: {
            cookie,
            host: authority,
            'x-forwarded-host': authority,
            'x-user-id': 'someone-else',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      attempt.on('error', reject);
      attempt.end();
      expect(await promise).toBe(503);
      expect(await upgrade(baseUrl, `/api/other?instance=${authority}`, cookie, authority)).toMatch(
        /^HTTP\/1\.1 503 /,
      );
      const url = new URL(baseUrl);
      const received = once(app.server, 'upgrade');
      const socket = connect(Number(url.port), url.hostname);
      const closed = once(socket, 'close');
      await once(socket, 'connect');
      socket.end(
        `GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await received;
      socket.destroy();
      await closed;

      expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
      expect(await upgrade(baseUrl)).toMatch(/^HTTP\/1\.1 401 /);
      expect(connections).toBe(0);
    });
  } finally {
    observer.close();
    await once(observer, 'close');
  }
});

it('fully closes a rejected upgrade even when the peer withholds its FIN', async () => {
  await withListeningApp(async (baseUrl, app) => {
    const url = new URL(baseUrl);
    const { promise, resolve } = Promise.withResolvers<{
      peer: Duplex;
      closed: Promise<unknown[]>;
    }>();
    app.server.once('upgrade', (_request, peer) => {
      // Observe before finish/close next-ticks; the deadline only bounds a leak.
      resolve({ peer, closed: once(peer, 'close', { signal: AbortSignal.timeout(1_000) }) });
    });
    const client = connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
    let response = '';
    client.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });
    const received = once(client, 'end');
    await once(client, 'connect');
    client.write(
      `GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    const { peer, closed } = await promise;
    try {
      await Promise.all([received, closed]);

      expect(response).toBe(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      expect(peer.destroyed).toBe(true);
      expect(client.writableEnded).toBe(false);
    } finally {
      client.destroy();
      peer.destroy();
    }
    await app.close();
    expect(app.server.listenerCount('upgrade')).toBe(0);
  });
});

it('keeps absolute-form reserved targets out of the gateway on both transports', async () => {
  await withListeningApp(async (baseUrl, app) => {
    await registerAccount(app, 'absolute@example.com');
    const { token } = await successfulLogin(baseUrl, 'absolute@example.com');
    for (const cookie of ['', `platform_session=${token}`]) {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const call = request(
        baseUrl,
        {
          path: 'http://example.invalid/_platform/missing',
          headers: { cookie, accept: 'text/html' },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      call.on('error', reject);
      call.end();

      expect(await promise).toBe(404);
      expect(await upgrade(baseUrl, 'http://example.invalid/_platform/missing', cookie)).toMatch(
        /^HTTP\/1\.1 404 /,
      );
      expect(await upgrade(baseUrl, 'http://example.invalid/', cookie)).toMatch(
        cookie === '' ? /^HTTP\/1\.1 401 / : /^HTTP\/1\.1 503 /,
      );
    }
  });
});

const UNAVAILABLE = ['stopped', 'starting', 'full', 'error', 'unconfigured'] as const;

it.each(UNAVAILABLE)(
  'redirects %s navigation to the fixed wait page and explains API unavailability',
  async (reason) => {
    const selected: string[] = [];
    await withForwardingApp(
      (id) => {
        selected.push(id);
        return { outcome: reason };
      },
      async ({ base, cookie, userId }) => {
        for (const method of ['GET', 'HEAD'] as const) {
          const page = await sendHttp(base, {
            method,
            path: '/?returnTo=https://foreign.example&reason=forged',
            headers: {
              cookie,
              accept: 'application/json, TEXT/HTML;q=0.5',
              'x-user-id': 'someone-else',
            },
          });

          expect(page.status).toBe(302);
          expect(page.headers.location).toBe('/_platform/wait');
        }
        for (const method of ['GET', 'POST', 'HEAD'] as const) {
          const api = await sendHttp(
            base,
            {
              method,
              path: '/api/session',
              headers: {
                cookie,
                accept: method === 'POST' ? 'text/html' : 'text/html;q=0',
                'content-type': 'application/json',
              },
            },
            method === 'POST' ? '{' : undefined,
          );
          expect(api.status).toBe(503);
          expect(api.headers.location).toBeUndefined();
          if (method === 'HEAD') expect(api.body).toEqual(Buffer.alloc(0));
          else
            expect(JSON.parse(api.body.toString())).toEqual({
              statusCode: 503,
              error: 'Service Unavailable',
              message: 'Instance unavailable',
              reason,
            });
        }
        expect(selected).toEqual([userId, userId, userId, userId, userId]);
      },
    );
  },
);

it.each(UNAVAILABLE)(
  'rejects a valid upgrade with framed %s JSON and EOF instead of an HTML redirect',
  async (reason) => {
    await withForwardingApp(
      () => ({ outcome: reason }),
      async ({ base, cookie }) => {
        const response = await upgrade(base, '/ws', cookie);

        const [headers, body] = response.split('\r\n\r\n');
        expect(headers).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
        expect(headers).toContain('Content-Type: application/json');
        expect(headers).toContain('Connection: close');
        expect(headers).not.toContain('Location:');
        expect(headers).toContain(`Content-Length: ${String(Buffer.byteLength(body ?? ''))}`);
        expect(JSON.parse(body ?? '')).toEqual({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Instance unavailable',
          reason,
        });
        expect(response).not.toContain(cookie);
      },
    );
  },
);

it('resolves only admitted users and observes an unavailable to running transition without caching', async () => {
  let running = false;
  const selected: string[] = [];
  await withUpstream(
    (_request, response) => {
      response.end('ready bytes');
    },
    async (target) => {
      await withForwardingApp(
        (id) => {
          selected.push(id);
          return running ? target : { outcome: 'starting' };
        },
        async ({ base, cookie, userId }) => {
          const anonymous = await sendHttp(base, { headers: { accept: 'text/html' } });
          expect(anonymous.status).toBe(302);
          expect(anonymous.headers.location).toBe('/_platform/login');
          expect(
            (await sendHttp(base, { path: '/_platform/wait', headers: { cookie } })).status,
          ).toBe(404);
          expect(await upgrade(base, '/ws', cookie, undefined, 'http://foreign.example')).toMatch(
            /^HTTP\/1\.1 403 /,
          );
          expect(selected).toEqual([]);
          const waiting = await sendHttp(base, { headers: { cookie } });
          expect(JSON.parse(waiting.body.toString())).toMatchObject({ reason: 'starting' });

          running = true;
          const ready = await sendHttp(base, { headers: { cookie, accept: 'text/html' } });

          expect(ready.status).toBe(200);
          expect(ready.body.toString()).toBe('ready bytes');
          expect(ready.headers.location).toBeUndefined();
          expect(selected).toEqual([userId, userId]);
        },
      );
    },
  );
});

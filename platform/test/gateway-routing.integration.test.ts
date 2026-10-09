import { once } from 'node:events';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { expect, it } from 'vitest';
import { deleteUserSessions } from '../src/auth/index.ts';
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
      `GET ${path} HTTP/1.1\r\nHost: ${authority ?? url.host}\r\nX-Forwarded-Host: ${authority ?? url.host}\r\nX-User-Id: someone-else\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${cookie}\r\n\r\n`,
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
  await withListeningApp(async (baseUrl, app, database) => {
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
      const socket = connect(Number(url.port), url.hostname);
      const closed = once(socket, 'close');
      await once(socket, 'connect');
      socket.end(
        `GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
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

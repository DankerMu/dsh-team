import { request, type IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { createSession, deleteUserSessions } from '../src/auth/index.ts';
import {
  PUBLIC_ORIGIN,
  cookieHeaders,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
} from './auth-fixture.ts';
import {
  observeHttp,
  reader,
  sendHttp,
  withForwardingApp,
  withUpstream,
} from './gateway-http-fixture.ts';
import type { ReadPeer } from './gateway-http-fixture.ts';

const CLIENT_FRAME = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
const SERVER_FRAME = Buffer.from([0x82, 2, 0, 255]);

function peer(socket: Duplex, head?: Parameters<typeof reader>[1]) {
  const read = reader(socket, head);
  const closed = Promise.withResolvers<undefined>();
  socket.once('close', () => {
    closed.resolve(undefined);
  });
  return { socket, read, closed: closed.promise };
}

function acceptPeer(request: IncomingMessage, socket: Duplex, head: Parameters<typeof reader>[1]) {
  const result = peer(socket, head);
  socket.once('end', () => {
    socket.destroy();
  });
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key'] ?? ''}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return result;
}

async function openPeer(base: string, cookie: string, path: string, upgrade = true) {
  const address = new URL(base);
  const socket = connect(Number(address.port), address.hostname);
  const result = peer(socket);
  try {
    await once(socket, 'connect');
    const headers = upgrade
      ? `Connection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${PUBLIC_ORIGIN}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
      : 'Connection: keep-alive\r\n';
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nCookie: ${cookie}\r\n${headers}\r\n`,
    );
    const response = (await result.read('\r\n\r\n')).toString();
    expect(response).toMatch(upgrade ? /^HTTP\/1\.1 101 / : /^HTTP\/1\.1 200 /);
    return result;
  } catch (error) {
    socket.destroy();
    await result.closed;
    throw error;
  }
}

it('disconnects two WebSockets and an active download for one user within one second without harming another', async () => {
  const upstreams = new Map<
    string,
    { socket: Duplex; read: ReadPeer; closed: Promise<undefined> }
  >();
  await withUpstream(
    (request, response) => {
      upstreams.set('/download', peer(request.socket));
      response.writeHead(200, { 'content-length': '1000000' });
      response.write('prefix');
    },
    async (target, server) => {
      server.on('upgrade', (request, socket, head) => {
        upstreams.set(request.url ?? '', acceptPeer(request, socket, head));
      });
      await withForwardingApp(
        () => target,
        async ({ app, base, cookie, userId }) => {
          const registered = await injectRegister(app, {
            email: 'connection-b@example.com',
            password: 'test-password',
          });
          const other = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
          expect(readPublicIdentity(registered.json<unknown>()).id).not.toBe(userId);
          const clients: Awaited<ReturnType<typeof openPeer>>[] = [];
          try {
            for (const path of ['/a-one', '/a-two', '/download'])
              clients.push(await openPeer(base, cookie, path, path !== '/download'));
            const sibling = await openPeer(base, other, '/b');
            clients.push(sibling);
            expect(await clients[2]?.read(6)).toEqual(Buffer.from('prefix'));
            expect(clients.slice(0, 3).every((client) => !client.socket.destroyed)).toBe(true);
            const closing = [...clients.slice(0, 3).map((client) => client.closed)];
            for (const path of ['/a-one', '/a-two', '/download']) {
              const upstream = upstreams.get(path);
              if (upstream === undefined) throw new Error('Missing active upstream');
              closing.push(upstream.closed);
            }

            const started = performance.now();
            await observeHttp(
              Promise.all([app.disconnectUserConnections(userId), ...closing]),
              1000,
            );
            expect(performance.now() - started).toBeLessThan(1000);

            const siblingUpstream = upstreams.get('/b');
            if (siblingUpstream === undefined) throw new Error('Missing sibling upstream');
            sibling.socket.write(CLIENT_FRAME);
            expect(await siblingUpstream.read(CLIENT_FRAME.length)).toEqual(CLIENT_FRAME);
            siblingUpstream.socket.write(SERVER_FRAME);
            expect(await sibling.read(SERVER_FRAME.length)).toEqual(SERVER_FRAME);
            await app.disconnectUserConnections(userId);
            await app.disconnectUserConnections('unknown');
            const later = await openPeer(base, cookie, '/a-later');
            clients.push(later);
            const laterUpstream = upstreams.get('/a-later');
            if (laterUpstream === undefined) throw new Error('Missing later upstream');
            laterUpstream.socket.write(SERVER_FRAME);
            expect(await later.read(SERVER_FRAME.length)).toEqual(SERVER_FRAME);
          } finally {
            for (const client of clients) client.socket.destroy();
            await observeHttp(Promise.all(clients.map((client) => client.closed)));
          }
        },
      );
    },
  );
});

it('releases completed HTTP ownership before the same keep-alive socket serves another user', async () => {
  let finishDownload: (() => void) | undefined;
  await withUpstream(
    (request, response) => {
      if (request.url === '/first') {
        response.writeHead(200, { 'content-length': '5' }).end('first');
      } else {
        response.writeHead(200, { 'content-length': '11' }).write('b-prefix');
        finishDownload = () => {
          response.end('-ok');
        };
      }
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ app, base, cookie, userId }) => {
          const registered = await injectRegister(app, {
            email: 'keepalive-b@example.com',
            password: 'test-password',
          });
          const other = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
          const client = await openPeer(base, cookie, '/first', false);
          try {
            expect(await client.read(5)).toEqual(Buffer.from('first'));
            client.socket.write(
              `GET /second HTTP/1.1\r\nHost: ${new URL(base).host}\r\nCookie: ${other}\r\nConnection: keep-alive\r\n\r\n`,
            );
            expect((await client.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
            expect(await client.read(8)).toEqual(Buffer.from('b-prefix'));

            await observeHttp(app.disconnectUserConnections(userId), 1000);

            if (finishDownload === undefined) throw new Error('Missing active download');
            finishDownload();
            expect(await client.read(3)).toEqual(Buffer.from('-ok'));
          } finally {
            client.socket.destroy();
            await observeHttp(client.closed);
          }
        },
      );
    },
  );
});

it.each([false, true])(
  'fences a resolver-triggered disconnect before upstream creation (upgrade=%s)',
  async (upgrade) => {
    let upstreamConnections = 0;
    let disconnect: ((userId: string) => Promise<void>) | undefined;
    let destroyed: Promise<void> | undefined;
    let resolutions = 0;
    await withUpstream(
      (_request, response) => {
        response.end('unexpected');
      },
      async (target, server) => {
        server.on('connection', () => {
          upstreamConnections++;
        });
        await withForwardingApp(
          (userId) => {
            resolutions++;
            if (disconnect === undefined) throw new Error('Missing application disconnect');
            destroyed = disconnect(userId);
            return target;
          },
          async ({ app, base, cookie }) => {
            disconnect = app.disconnectUserConnections;
            const call = request(new URL('/reentrant', base), {
              headers: {
                cookie,
                ...(upgrade
                  ? {
                      connection: 'Upgrade',
                      upgrade: 'websocket',
                      origin: PUBLIC_ORIGIN,
                      'sec-websocket-version': '13',
                      'sec-websocket-key': randomBytes(16).toString('base64'),
                    }
                  : {}),
              },
            });
            const closed = Promise.withResolvers<undefined>();
            call.on('error', () => {
              /* Deliberate server-side disconnect has no HTTP response. */
            });
            call.once('close', () => {
              closed.resolve(undefined);
            });
            try {
              call.end();
              await observeHttp(closed.promise, 1000);
              if (destroyed === undefined) throw new Error('Resolver did not invoke disconnect');
              await observeHttp(destroyed, 1000);

              expect(resolutions).toBe(1);
              expect(upstreamConnections).toBe(0);
            } finally {
              call.destroy();
              await observeHttp(closed.promise);
            }
          },
        );
      },
    );
  },
);

it.each(['user', 'session'])(
  'disconnects by %s while its WebSocket handshake is pending',
  async (mode) => {
    const accepted = Promise.withResolvers<ReturnType<typeof peer>>();
    await withUpstream(
      (_request, response) => {
        response.end('healthy');
      },
      async (target, server) => {
        server.on('upgrade', (_request, socket, head) => {
          const upstream = peer(socket, head);
          socket.once('end', () => {
            socket.destroy();
          });
          accepted.resolve(upstream);
        });
        await withForwardingApp(
          () => target,
          async ({ app, base, cookie, userId, database }) => {
            const call = request(base, {
              headers: {
                cookie,
                connection: 'Upgrade',
                upgrade: 'websocket',
                origin: PUBLIC_ORIGIN,
                'sec-websocket-version': '13',
                'sec-websocket-key': randomBytes(16).toString('base64'),
              },
            });
            let upgraded = false;
            call.once('upgrade', (_response, socket) => {
              upgraded = true;
              socket.destroy();
            });
            call.on('error', () => {
              /* Pending handshake is deliberately cancelled. */
            });
            const closed = Promise.withResolvers<undefined>();
            call.once('close', () => {
              closed.resolve(undefined);
            });
            try {
              call.end();
              const upstream = await observeHttp(accepted.promise);

              if (mode === 'session') deleteUserSessions(database, userId);
              await observeHttp(
                Promise.all([
                  mode === 'user' ? app.disconnectUserConnections(userId) : undefined,
                  closed.promise,
                  upstream.closed,
                ]),
                mode === 'user' ? 1000 : 2000,
              );

              expect(upgraded).toBe(false);
              expect(upstream.socket.closed).toBe(true);
              expect((await app.inject('/healthz')).statusCode).toBe(200);
            } finally {
              call.destroy();
              await observeHttp(closed.promise);
            }
          },
        );
      },
    );
  },
);

it('keeps another application owner alive for the same requested user ID', async () => {
  let complete: (() => void) | undefined;
  await withUpstream(
    (_request, response) => {
      response.writeHead(200, { 'content-length': '14' }).write('prefix');
      complete = () => {
        response.end('complete');
      };
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ app, base, cookie, userId }) => {
          const client = await openPeer(base, cookie, '/owned', false);
          try {
            expect(await client.read(6)).toEqual(Buffer.from('prefix'));

            await withForwardingApp(
              () => target,
              async ({ app: otherApp }) => {
                await observeHttp(otherApp.disconnectUserConnections(userId), 1000);
              },
            );

            if (complete === undefined) throw new Error('Missing original transfer');
            complete();
            expect(await client.read(8)).toEqual(Buffer.from('complete'));
            expect((await app.inject('/healthz')).statusCode).toBe(200);
          } finally {
            client.socket.destroy();
            await observeHttp(client.closed);
          }
        },
      );
    },
  );
});

it('closes an active HTTP transfer and its upstream during application shutdown', async () => {
  const accepted = Promise.withResolvers<ReturnType<typeof peer>>();
  await withUpstream(
    (incoming, response) => {
      accepted.resolve(peer(incoming.socket));
      response.writeHead(200, { 'content-length': '1000' }).write('prefix');
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ app, base, cookie }) => {
          const client = await openPeer(base, cookie, '/download', false);
          try {
            expect(await client.read(6)).toEqual(Buffer.from('prefix'));
            const upstream = await observeHttp(accepted.promise);

            await observeHttp(Promise.all([app.close(), client.closed, upstream.closed]), 1000);

            expect(client.socket.closed).toBe(true);
            expect(upstream.socket.closed).toBe(true);
          } finally {
            client.socket.destroy();
            await observeHttp(client.closed);
          }
        },
      );
    },
  );
});

async function withSessionConnections(
  run: (
    context: Parameters<Parameters<typeof withForwardingApp>[1]>[0] & {
      open: (cookie: string, path: string, upgrade?: boolean) => ReturnType<typeof openPeer>;
      remote: (path: string) => ReturnType<typeof peer>;
    },
  ) => Promise<void>,
) {
  const upstreams = new Map<string, ReturnType<typeof peer>>();
  await withUpstream(
    (request, response) => {
      upstreams.set(request.url ?? '', peer(request.socket));
      response.writeHead(200, { 'content-length': '1000000' }).write('prefix');
    },
    async (target, server) => {
      server.on('upgrade', (request, socket, head) => {
        upstreams.set(request.url ?? '', acceptPeer(request, socket, head));
      });
      await withForwardingApp(
        () => target,
        async (context) => {
          const clients: Awaited<ReturnType<typeof openPeer>>[] = [];
          try {
            await run({
              ...context,
              open: async (cookie, path, upgrade = true) => {
                const client = await openPeer(context.base, cookie, path, upgrade);
                clients.push(client);
                return client;
              },
              remote: (path) => {
                const result = upstreams.get(path);
                if (result === undefined) throw new Error('Missing active upstream');
                return result;
              },
            });
          } finally {
            for (const client of clients) client.socket.destroy();
            await observeHttp(Promise.all(clients.map((client) => client.closed)));
          }
        },
      );
    },
  );
}

async function exchange(
  client: Awaited<ReturnType<typeof openPeer>>,
  remote: ReturnType<typeof peer>,
) {
  client.socket.write(CLIENT_FRAME);
  expect(await remote.read(CLIENT_FRAME.length)).toEqual(CLIENT_FRAME);
  remote.socket.write(SERVER_FRAME);
  expect(await client.read(SERVER_FRAME.length)).toEqual(SERVER_FRAME);
}

it('closes only the logged-out session while another session of that user and another user remain live', async () => {
  await withSessionConnections(async ({ base, cookie, database, userId, app, open, remote }) => {
    const second = `platform_session=${createSession(database, userId, Date.now())}`;
    const registered = await injectRegister(app, {
      email: 'session-b@example.com',
      password: 'test-password',
    });
    const other = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
    const old = await open(cookie, '/old');
    const download = await open(cookie, '/download', false);
    const sibling = await open(second, '/second');
    const different = await open(other, '/other');
    expect(await download.read(6)).toEqual(Buffer.from('prefix'));

    const response = await sendHttp(
      base,
      {
        method: 'POST',
        path: '/_platform/api/logout',
        headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(response.status).toBe(204);
    await observeHttp(
      Promise.all([old.closed, download.closed, remote('/old').closed, remote('/download').closed]),
    );
    await exchange(sibling, remote('/second'));
    await exchange(different, remote('/other'));
  });
});

it('revokes both old browser sessions after password change but keeps the replacement session live', async () => {
  await withSessionConnections(async ({ base, cookie, database, userId, open, remote }) => {
    const second = `platform_session=${createSession(database, userId, Date.now())}`;
    const first = await open(cookie, '/first');
    const sibling = await open(second, '/second');

    const response = await sendHttp(
      base,
      {
        method: 'POST',
        path: '/_platform/api/change-password',
        headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      },
      JSON.stringify({ currentPassword: 'test-password', newPassword: 'replacement-password' }),
    );

    expect(response.status).toBe(204);
    const replacement = `platform_session=${sessionCookieToken(response.headers['set-cookie'] ?? [])}`;
    const fresh = await open(replacement, '/fresh');
    await observeHttp(
      Promise.all([
        first.closed,
        sibling.closed,
        remote('/first').closed,
        remote('/second').closed,
      ]),
    );
    await exchange(fresh, remote('/fresh'));
  });
});

it('keeps a rolled-back logout alive across a sweep and does not renew its activity', async () => {
  await withSessionConnections(async ({ base, cookie, database, userId, open, remote }) => {
    const live = await open(cookie, '/live');
    database.exec(
      "CREATE TEMP TRIGGER abort_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    const response = await sendHttp(
      base,
      {
        method: 'POST',
        path: '/_platform/api/logout',
        headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      },
      '{}',
    );
    expect(response.status).toBe(500);
    const stale = Date.now() - 120000;
    database.prepare('UPDATE platform_sessions SET last_activity_at = ?').run(stale);
    const probeToken = createSession(database, userId, Date.now());
    const probe = await open(`platform_session=${probeToken}`, '/probe');

    database
      .prepare('DELETE FROM platform_sessions WHERE token_hash = ?')
      .run(createHash('sha256').update(probeToken).digest('hex'));
    await observeHttp(Promise.all([probe.closed, remote('/probe').closed]));

    await exchange(live, remote('/live'));
    expect(database.prepare('SELECT last_activity_at FROM platform_sessions').all()).toEqual([
      { last_activity_at: stale },
    ]);
  });
});

it.each(['expired', 'disabled', 'revoked'] as const)(
  'closes established channels after committed %s state',
  async (mode) => {
    await withSessionConnections(async ({ cookie, database, userId, open, remote }) => {
      const live = await open(cookie, '/live');

      if (mode === 'expired')
        database
          .prepare('UPDATE platform_sessions SET last_activity_at = ?')
          .run(Date.now() - 7 * 86400000 - 1);
      else if (mode === 'disabled')
        database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
      else deleteUserSessions(database, userId);

      await observeHttp(Promise.all([live.closed, remote('/live').closed]));
    });
  },
);

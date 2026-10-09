import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import {
  PUBLIC_ORIGIN,
  cookieHeaders,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
} from './auth-fixture.ts';
import { observeHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';
import type { GatewayUpstream } from '../src/gateway/index.ts';

// Per-run RFC6455 nonce, not a stored credential or secret-scan exemption.
const KEY = randomBytes(16).toString('base64');
const ACCEPT = createHash('sha1')
  .update(`${KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
  .digest('base64');
// Literal RFC6455 masked text "hi" and unmasked binary [0, 255]; the proxy never decodes frames.
const CLIENT_FRAME = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
const SERVER_FRAME = Buffer.from([0x82, 2, 0, 255]);
// Heads differ in opcode and payload from successors, so duplicate head bytes cannot stay aligned.
const CLIENT_HEAD = Buffer.from([0x82, 0x82, 5, 6, 7, 8, 0xfa, 6]);
const SERVER_HEAD = Buffer.from([0x81, 5, 104, 101, 108, 108, 111]);
const EXTENSION_OFFER = 'permessage-deflate; client_max_window_bits';
const EXTENSION_SELECTED = 'permessage-deflate; server_no_context_takeover';

type ReadPeer = (size: number | string) => Promise<Buffer>;
function reader(socket: Duplex, head = Buffer.alloc(0)): ReadPeer {
  let bytes: Buffer = head;
  let failed: Error | undefined;
  let notify: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 65536) failed = new Error('Unexpected test peer payload');
    notify?.();
  });
  socket.on('error', () => {
    failed = new Error('Test peer failed');
    notify?.();
  });
  socket.on('close', () => {
    failed = new Error('Test peer closed');
    notify?.();
  });
  return async (size) => {
    const pending = Promise.withResolvers<Buffer>();
    const check = () => {
      const length = typeof size === 'number' ? size : bytes.indexOf(size) + size.length;
      const available = typeof size === 'number' ? bytes.length >= size : bytes.includes(size);
      if (available) {
        const result = bytes.subarray(0, length);
        bytes = bytes.subarray(length);
        pending.resolve(result);
      } else if (failed !== undefined) pending.reject(failed);
    };
    notify = check;
    check();
    try {
      return await observeHttp(pending.promise);
    } finally {
      notify = undefined;
    }
  };
}

async function rejectedUpgrade(
  base: string,
  cookie: string,
  fields: readonly string[],
  path = '/ws',
): Promise<string> {
  const address = new URL(base);
  const socket = connect(Number(address.port), address.hostname);
  const read = reader(socket);
  const closed = once(socket, 'close');
  try {
    await once(socket, 'connect');
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n${fields.join('\r\n')}\r\n\r\n`,
    );
    const headers = (await read('\r\n\r\n')).toString();
    await observeHttp(closed);
    return headers;
  } finally {
    socket.destroy();
  }
}

it('streams both WebSocket frame directions with private handshake credentials', async () => {
  await withUpstream(
    (_request, response) => {
      response.writeHead(404).end();
    },
    async (target, server) => {
      const upstream = Promise.withResolvers<{
        socket: Duplex;
        read: ReadPeer;
        cookie: string | undefined;
        host: string | undefined;
        key: string | undefined;
        version: string | undefined;
        extensions: string | undefined;
      }>();
      server.on('upgrade', (request, socket, head) => {
        const acceptedKey = createHash('sha1')
          .update(
            `${request.headers['sec-websocket-key'] ?? ''}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
          )
          .digest('base64');
        socket.write(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptedKey}\r\nSec-WebSocket-Extensions: ${EXTENSION_SELECTED}\r\nSet-Cookie: dsh-auth=private\r\n\r\n`,
            ),
            SERVER_HEAD,
          ]),
        );
        upstream.resolve({
          socket,
          read: reader(socket, head),
          cookie: request.headers.cookie,
          host: request.headers.host,
          key: request.headers['sec-websocket-key'],
          version: request.headers['sec-websocket-version'],
          extensions: request.headers['sec-websocket-extensions'],
        });
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
              Buffer.concat([
                Buffer.from(
                  `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${PUBLIC_ORIGIN}\r\nConnection: Upgrade\r\nUpgrade: WebSocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: ${EXTENSION_OFFER}\r\nCookie: theme=dark; ${cookie}\r\n\r\n`,
                ),
                CLIENT_HEAD,
              ]),
            );
            const headers = (await read('\r\n\r\n')).toString();

            expect(headers).toMatch(/^HTTP\/1\.1 101 /);
            expect(
              headers
                .split('\r\n')
                .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))
                ?.split(': ')[1],
            ).toBe(ACCEPT);
            expect(headers.toLowerCase()).not.toContain('set-cookie');
            const peer = await observeHttp(upstream.promise);
            expect(peer.cookie).toBe(target.cookie);
            expect(peer.host).toBe('127.0.0.1:8080');
            expect(peer.key).toBe(KEY);
            expect(peer.version).toBe('13');
            expect(peer.extensions).toBe(EXTENSION_OFFER);
            expect(headers).toContain(`sec-websocket-extensions: ${EXTENSION_SELECTED}\r\n`);
            expect(await peer.read(CLIENT_HEAD.length)).toEqual(CLIENT_HEAD);
            expect(await read(SERVER_HEAD.length)).toEqual(SERVER_HEAD);
            client.write(CLIENT_FRAME.subarray(0, 3));
            expect(await peer.read(3)).toEqual(CLIENT_FRAME.subarray(0, 3));
            client.write(CLIENT_FRAME.subarray(3));
            expect(await peer.read(CLIENT_FRAME.length - 3)).toEqual(CLIENT_FRAME.subarray(3));
            peer.socket.write(SERVER_FRAME.subarray(0, 2));
            expect(await read(2)).toEqual(SERVER_FRAME.subarray(0, 2));
            peer.socket.write(SERVER_FRAME.subarray(2));
            expect(await read(2)).toEqual(SERVER_FRAME.subarray(2));
            client.write(CLIENT_FRAME);
            expect(await peer.read(CLIENT_FRAME.length)).toEqual(CLIENT_FRAME);
            peer.socket.write(SERVER_FRAME);
            expect(await read(SERVER_FRAME.length)).toEqual(SERVER_FRAME);
          } finally {
            client.destroy();
          }
        },
      );
    },
  );
});

it.each([
  [],
  ['Origin: null'],
  ['Origin: http://other.example'],
  ['Origin: https://127.0.0.1:8080'],
  ['Origin: http://127.0.0.1:8081'],
  [`Origin: ${PUBLIC_ORIGIN}`, 'Origin: http://other.example'],
  [`Origin: ${PUBLIC_ORIGIN}`, `Origin: ${PUBLIC_ORIGIN}`],
])('rejects an upgrade without exactly one configured Origin: %j', async (...origins) => {
  let resolutions = 0;
  let connections = 0;
  await withUpstream(
    (_request, response) => {
      response.end();
    },
    async (target, server) => {
      server.on('connection', () => {
        connections += 1;
      });
      await withForwardingApp(
        () => {
          resolutions += 1;
          return target;
        },
        async ({ base, cookie }) => {
          const headers = await rejectedUpgrade(base, cookie, ['Upgrade: websocket', ...origins]);

          expect(headers).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
          expect(headers).toContain('Content-Length: 0\r\n');
          expect(resolutions).toBe(0);
          expect(connections).toBe(0);
        },
      );
    },
  );
});

it.each(['h2c', 'websocket, h2c', 'websocket, websocket'])(
  'rejects unsupported Upgrade %s before resolving a destination',
  async (protocol) => {
    let resolutions = 0;
    await withForwardingApp(
      () => {
        resolutions += 1;
        return undefined;
      },
      async ({ base, cookie }) => {
        const headers = await rejectedUpgrade(base, cookie, [
          `Origin: ${PUBLIC_ORIGIN}`,
          `Upgrade: ${protocol}`,
        ]);

        expect(headers).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(resolutions).toBe(0);
      },
    );
  },
);

it.each(['client', 'app'])('releases a pending upstream handshake when %s closes', async (side) => {
  await withUpstream(
    (_request, response) => {
      response.end();
    },
    async (target, server) => {
      const accepted = Promise.withResolvers<Duplex>();
      server.on('upgrade', (_request, socket) => {
        socket.on('error', () => {
          socket.destroy();
        });
        socket.on('end', () => {
          socket.destroy();
        });
        socket.resume();
        accepted.resolve(socket);
      });
      await withForwardingApp(
        () => target,
        async ({ base, cookie, app }) => {
          const address = new URL(base);
          const client = connect(Number(address.port), address.hostname);
          try {
            await once(client, 'connect');
            client.write(
              `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${PUBLIC_ORIGIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`,
            );
            const upstream = await observeHttp(accepted.promise);
            const upstreamClosed = once(upstream, 'close');
            if (side === 'client') client.destroy();
            else await observeHttp(app.close());

            await observeHttp(upstreamClosed);
            expect(upstream.destroyed).toBe(true);
            if (side === 'client') expect((await app.inject('/healthz')).statusCode).toBe(200);
          } finally {
            client.destroy();
          }
        },
      );
    },
  );
});

it.each(['non101', 'wrong101', 'reset'])(
  'fails safely on upstream %s without leaking handshake credentials',
  async (mode) => {
    await withUpstream(
      (_request, response) => {
        response.end();
      },
      async (target, server) => {
        const closed = Promise.withResolvers<undefined>();
        server.on('upgrade', (_request, socket) => {
          socket.on('error', () => {
            socket.destroy();
          });
          socket.once('close', () => {
            closed.resolve(undefined);
          });
          socket.on('end', () => {
            socket.destroy();
          });
          socket.resume();
          if (mode === 'reset') socket.destroy();
          else if (mode === 'wrong101')
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nSet-Cookie: ${target.cookie}\r\n\r\n`,
            );
          else
            socket.end(
              `HTTP/1.1 403 Forbidden\r\nContent-Length: ${String(Buffer.byteLength(target.cookie))}\r\nSet-Cookie: ${target.cookie}\r\n\r\n${target.cookie}`,
            );
        });
        await withForwardingApp(
          () => target,
          async ({ base, cookie, lines, app }) => {
            const response = await rejectedUpgrade(base, cookie, [
              `Origin: ${PUBLIC_ORIGIN}`,
              'Upgrade: websocket',
            ]);
            await observeHttp(closed.promise);

            expect(response).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
            expect(response).not.toContain(target.cookie);
            expect(response.toLowerCase()).not.toContain('set-cookie');
            expect(lines.join('')).not.toContain(target.cookie);
            expect(lines.join('')).not.toContain(cookie.slice('platform_session='.length));
            expect(lines.join('')).toContain('Gateway WebSocket upstream failed');
            expect((await app.inject('/healthz')).statusCode).toBe(200);
          },
        );
      },
    );
  },
);

it.each(['client', 'upstream', 'app'])(
  'settles both upgraded peers when %s closes',
  async (side) => {
    await withUpstream(
      (_request, response) => {
        response.end();
      },
      async (target, server) => {
        const accepted = Promise.withResolvers<Duplex>();
        server.on('upgrade', (_request, socket) => {
          socket.on('error', () => {
            socket.destroy();
          });
          socket.on('end', () => {
            socket.destroy();
          });
          socket.resume();
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`,
          );
          accepted.resolve(socket);
        });
        await withForwardingApp(
          () => target,
          async ({ base, cookie, app }) => {
            const address = new URL(base);
            const client = connect(Number(address.port), address.hostname);
            const read = reader(client);
            try {
              await once(client, 'connect');
              client.write(
                `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${PUBLIC_ORIGIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`,
              );
              expect((await read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 101 /);
              const upstream = await observeHttp(accepted.promise);
              const closed = Promise.all([once(client, 'close'), once(upstream, 'close')]);
              if (side === 'client') client.destroy();
              else if (side === 'upstream') upstream.destroy();
              else await observeHttp(app.close());
              await observeHttp(closed);

              expect(client.destroyed).toBe(true);
              expect(upstream.destroyed).toBe(true);
              if (side !== 'app') expect((await app.inject('/healthz')).statusCode).toBe(200);
            } finally {
              client.destroy();
            }
          },
        );
      },
    );
  },
);

it('keeps two simultaneous users on their own WebSocket endpoint-cookie pairs despite forged authority', async () => {
  const selected: string[] = [];
  const targets = new Map<string, GatewayUpstream>();
  await withUpstream(
    (_request, response) => {
      response.end();
    },
    async (a, serverA) => {
      await withUpstream(
        (_request, response) => {
          response.end();
        },
        async (b, serverB) => {
          const observations = [serverA, serverB].map((server, index) => {
            const result = Promise.withResolvers<{
              cookie: string | undefined;
              host: string | undefined;
              path: string | undefined;
              protocol: string | undefined;
              hop: string | string[] | undefined;
              bytes: Buffer;
            }>();
            server.once('upgrade', (request, socket, head) => {
              const read = reader(socket, head);
              socket.on('end', () => {
                socket.destroy();
              });
              socket.write(
                `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade, X-Private\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${ACCEPT}\r\nSec-WebSocket-Protocol: selected\r\nX-Upstream: ${String(index)}\r\nX-Private: remove\r\nSet-Cookie: first=private\r\nSet-Cookie: second=private\r\n\r\n`,
              );
              void read(CLIENT_FRAME.length).then((bytes) => {
                result.resolve({
                  cookie: request.headers.cookie,
                  host: request.headers.host,
                  path: request.url,
                  protocol: request.headers['sec-websocket-protocol'],
                  hop: request.headers['x-hop'],
                  bytes,
                });
                socket.write(SERVER_FRAME);
              }, result.reject);
            });
            return result.promise;
          });
          await withForwardingApp(
            (id) => {
              selected.push(id);
              return targets.get(id);
            },
            async ({ base, app, cookie, userId }) => {
              const registration = await injectRegister(app, {
                email: 'ws-second@example.com',
                password: 'test-password',
              });
              const otherId = readPublicIdentity(registration.json<unknown>()).id;
              const otherCookie = `platform_session=${sessionCookieToken(cookieHeaders(registration))}`;
              targets.set(userId, a);
              targets.set(otherId, b);
              const path = `/ws/${otherId}/%2Fraw/../socket?user=${otherId}`;
              const authority = `${b.host}:${String(b.port)}`;
              const clients = new Set<Duplex>();
              try {
                await Promise.all(
                  [cookie, otherCookie].map(async (credential, index) => {
                    const address = new URL(base);
                    const client = connect(Number(address.port), address.hostname);
                    clients.add(client);
                    const read = reader(client);
                    await once(client, 'connect');
                    client.write(
                      `GET http://${authority}${path} HTTP/1.1\r\nHost: ${authority}\r\nX-Forwarded-Host: ${authority}\r\nX-User-Id: ${otherId}\r\nOrigin: ${PUBLIC_ORIGIN}\r\nConnection: Upgrade, Cookie, Host, X-Hop\r\nUpgrade: websocket\r\nX-Hop: remove\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: selected\r\nCookie: ${credential}\r\nCookie: dsh-auth=forged\r\n\r\n`,
                    );
                    const headers = (await read('\r\n\r\n')).toString();

                    expect(headers).toMatch(/^HTTP\/1\.1 101 /);
                    expect(headers).toContain(`x-upstream: ${String(index)}\r\n`);
                    expect(headers).toContain('sec-websocket-protocol: selected\r\n');
                    expect(headers.toLowerCase()).not.toContain('set-cookie');
                    expect(headers.toLowerCase()).not.toContain('x-private');
                    client.write(CLIENT_FRAME);
                    expect(await read(SERVER_FRAME.length)).toEqual(SERVER_FRAME);
                  }),
                );
                const observed = await observeHttp(Promise.all(observations));
                expect(observed).toEqual(
                  [a, b].map((target) => ({
                    cookie: target.cookie,
                    host: '127.0.0.1:8080',
                    path,
                    protocol: 'selected',
                    hop: undefined,
                    bytes: CLIENT_FRAME,
                  })),
                );
                expect(selected.toSorted()).toEqual([userId, otherId].toSorted());
              } finally {
                for (const client of clients) client.destroy();
              }
            },
          );
        },
      );
    },
  );
});

it.each(['missing', 'resolver', 'endpoint', 'refused'])(
  'rejects %s upgrade destinations without credential-bearing errors',
  async (mode) => {
    await withUpstream(
      (_request, response) => {
        response.end();
      },
      async (target, server) => {
        if (mode === 'refused') {
          const closed = once(server, 'close');
          server.close();
          await closed;
        }
        await withForwardingApp(
          () => {
            if (mode === 'missing') return undefined;
            if (mode === 'resolver') throw new Error(target.cookie);
            return mode === 'endpoint' ? { ...target, port: -1 } : target;
          },
          async ({ base, cookie, lines }) => {
            const response = await rejectedUpgrade(base, cookie, [
              `Origin: ${PUBLIC_ORIGIN}`,
              'Upgrade: websocket',
            ]);

            expect(response).toMatch(mode === 'missing' ? /^HTTP\/1\.1 503 / : /^HTTP\/1\.1 502 /);
            expect(response).not.toContain(target.cookie);
            expect(lines.join('')).not.toContain(target.cookie);
            expect(lines.join('')).not.toContain(cookie.slice('platform_session='.length));
          },
        );
      },
    );
  },
);

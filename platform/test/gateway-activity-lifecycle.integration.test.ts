import type { Duplex } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, writeSettings } from '../src/db/index.ts';
import { startupBarrier } from './container-start-fixture.ts';
import {
  activityUpgradeRequest,
  connectActivityPeer,
  observeActivity,
  seedActivityInstance,
  withGatewayActivityApp,
} from './gateway-activity-fixture.ts';
import { observeHttp, sendHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';

const NOW = 1_800_000_000_000;

it.each(['pending', 'established'] as const)(
  'counts an admitted %s WebSocket until close without treating idle time or bytes as new activity',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    try {
      await withGatewayActivityApp(async ({ app, database, config, base, port }) => {
        const user = await registerInstanceUser(base, config.publicUrl, `ws-${mode}@example.test`);
        await withUpstream(
          (_incoming, response) => response.end('healthy'),
          async (target, server) => {
            const accepted = Promise.withResolvers<Duplex>();
            server.on('upgrade', (_incoming, socket) => {
              socket.once('end', () => socket.end());
              if (mode === 'established')
                socket.write(
                  'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
                );
              accepted.resolve(socket);
            });
            seedActivityInstance(database, user.id, target);
            const peer = await connectActivityPeer(port);
            try {
              peer.socket.write(activityUpgradeRequest(port, user.cookie, config.publicUrl));
              const upstream = await observeHttp(accepted.promise);
              if (mode === 'established')
                expect((await peer.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 101 /);
              expect(app.getUserActivity(user.id)).toEqual({ liveCount: 1, lastActivityAt: NOW });
              await vi.advanceTimersByTimeAsync(5_000);
              if (mode === 'established') {
                upstream.write(Buffer.from([0x81, 0x01, 0x41]));
                expect(await peer.read(3)).toEqual(Buffer.from([0x81, 0x01, 0x41]));
              }
              expect(app.getUserActivity(user.id)).toEqual({ liveCount: 1, lastActivityAt: NOW });
              peer.socket.destroy();
              await observeHttp(peer.closed);
              await observeActivity(() => app.getUserActivity(user.id).liveCount === 0);
              expect(app.getUserActivity(user.id)).toEqual({
                liveCount: 0,
                lastActivityAt: NOW + 5_000,
              });
              await vi.advanceTimersByTimeAsync(60_000);
              expect(
                database
                  .prepare('SELECT last_activity_at FROM instances WHERE user_id = ?')
                  .get(user.id),
              ).toEqual({ last_activity_at: NOW + 5_000 });
            } finally {
              peer.socket.destroy();
            }
          },
        );
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(['http-abort', 'websocket-rejection'] as const)(
  'releases activity after an upstream %s and permits a later healthy request',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    try {
      await withGatewayActivityApp(async ({ app, database, config, base, port }) => {
        const user = await registerInstanceUser(base, config.publicUrl, `${mode}@example.test`);
        const download = Promise.withResolvers<ServerResponse>();
        const upgrade = Promise.withResolvers<Duplex>();
        await withUpstream(
          (incoming, response) => {
            if (incoming.url === '/healthy') response.end('healthy');
            else {
              response.writeHead(200, { 'content-length': '1000' }).write('prefix');
              download.resolve(response);
            }
          },
          async (target, server) => {
            server.on('upgrade', (_incoming, socket) => {
              socket.once('end', () => socket.end());
              upgrade.resolve(socket);
            });
            seedActivityInstance(database, user.id, target);
            const peer = await connectActivityPeer(port);
            try {
              peer.socket.write(
                mode === 'http-abort'
                  ? `GET /broken HTTP/1.1\r\nHost: localhost\r\nCookie: ${user.cookie}\r\n\r\n`
                  : activityUpgradeRequest(port, user.cookie, config.publicUrl),
              );
              if (mode === 'http-abort') {
                await observeHttp(download.promise);
                expect((await peer.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
                expect(await peer.read(6)).toEqual(Buffer.from('prefix'));
              } else await observeHttp(upgrade.promise);
              expect(app.getUserActivity(user.id)).toEqual({ liveCount: 1, lastActivityAt: NOW });
              await vi.advanceTimersByTimeAsync(1_000);
              if (mode === 'http-abort') (await download.promise).destroy();
              else {
                (await upgrade.promise).end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
                expect((await peer.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 502 /);
              }
              await observeHttp(peer.closed);
              await observeActivity(() => app.getUserActivity(user.id).liveCount === 0);
              expect(app.getUserActivity(user.id)).toEqual({
                liveCount: 0,
                lastActivityAt: NOW + 1_000,
              });
              expect(
                (
                  await sendHttp(base, { path: '/healthy', headers: { cookie: user.cookie } })
                ).body.toString(),
              ).toBe('healthy');
              expect(app.getUserActivity(user.id)).toEqual({
                liveCount: 0,
                lastActivityAt: NOW + 1_000,
              });
              await vi.advanceTimersByTimeAsync(60_000);
              expect(database.prepare('SELECT last_activity_at FROM instances').get()).toEqual({
                last_activity_at: NOW + 1_000,
              });
            } finally {
              peer.socket.destroy();
            }
          },
        );
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it('excludes anonymous, platform and rejected upgrades while keeping distinct users independent', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  try {
    await withGatewayActivityApp(async ({ app, database, config, base, port }) => {
      const a = await registerInstanceUser(base, config.publicUrl, 'activity-a@example.test');
      const b = await registerInstanceUser(base, config.publicUrl, 'activity-b@example.test');
      await withUpstream(
        (incoming, response) => {
          if (incoming.url === '/healthy') response.end('healthy');
          else response.writeHead(200, { 'content-length': '1000' }).write('prefix');
        },
        async (target) => {
          seedActivityInstance(database, a.id, target);
          seedActivityInstance(database, b.id, target);
          expect((await sendHttp(base, { path: '/anonymous' })).status).toBe(401);
          expect(
            (await sendHttp(base, { path: '/healthz', headers: { cookie: a.cookie } })).status,
          ).toBe(200);
          expect(
            (
              await sendHttp(base, {
                path: '/_platform/api/instance',
                headers: { cookie: a.cookie },
              })
            ).status,
          ).toBe(200);
          const rejected = await connectActivityPeer(port);
          try {
            rejected.socket.write(activityUpgradeRequest(port, a.cookie, 'http://foreign.invalid'));
            expect((await rejected.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 403 /);
            await observeHttp(rejected.closed);
          } finally {
            rejected.socket.destroy();
          }
          const malformed = await connectActivityPeer(port);
          try {
            malformed.socket.write(
              activityUpgradeRequest(port, a.cookie, config.publicUrl).replace(
                'Upgrade: websocket',
                'Upgrade: other',
              ),
            );
            expect((await malformed.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 400 /);
            await observeHttp(malformed.closed);
          } finally {
            malformed.socket.destroy();
          }
          expect(app.getUserActivity(a.id)).toEqual({ liveCount: 0, lastActivityAt: null });
          await vi.advanceTimersByTimeAsync(60_000);
          expect(
            database.prepare('SELECT last_activity_at FROM instances WHERE user_id = ?').get(a.id),
          ).toEqual({ last_activity_at: null });
          expect(app.getUserActivity(b.id)).toEqual({ liveCount: 0, lastActivityAt: null });
          const active = await connectActivityPeer(port);
          try {
            active.socket.write(
              `GET /held HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${a.cookie}\r\n\r\n`,
            );
            expect((await active.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
            expect(await active.read(6)).toEqual(Buffer.from('prefix'));
            expect(app.getUserActivity(a.id)).toEqual({
              liveCount: 1,
              lastActivityAt: NOW + 60_000,
            });
            expect(
              (
                await sendHttp(base, { path: '/healthy', headers: { cookie: b.cookie } })
              ).body.toString(),
            ).toBe('healthy');
            expect(app.getUserActivity(b.id)).toEqual({
              liveCount: 0,
              lastActivityAt: NOW + 60_000,
            });
            expect(app.getUserActivity(a.id)).toEqual({
              liveCount: 1,
              lastActivityAt: NOW + 60_000,
            });
            await app.disconnectUserConnections(b.id);
            expect(app.getUserActivity(a.id).liveCount).toBe(1);
            await app.disconnectUserConnections(a.id);
            await observeHttp(active.closed);
            expect(app.getUserActivity(a.id).liveCount).toBe(0);
          } finally {
            active.socket.destroy();
          }
        },
      );
    });
  } finally {
    vi.useRealTimers();
  }
});

it('keeps offline application observation independent without requiring an instance service or inventing rows', async () => {
  await withUpstream(
    (_incoming, response) => response.writeHead(200, { 'content-length': '1000' }).write('prefix'),
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ app, base, userId, cookie, database }) => {
          await withForwardingApp(
            () => target,
            async ({ app: isolated }) => {
              const port = Number(new URL(base).port);
              const peer = await connectActivityPeer(port);
              try {
                peer.socket.write(
                  `GET /offline HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie}\r\n\r\n`,
                );
                expect((await peer.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
                expect(await peer.read(6)).toEqual(Buffer.from('prefix'));
                expect(app.getUserActivity(userId).liveCount).toBe(1);
                expect(isolated.getUserActivity(userId)).toEqual({
                  liveCount: 0,
                  lastActivityAt: null,
                });
                await app.disconnectUserConnections(userId);
                await observeHttp(peer.closed);
                expect(app.getUserActivity(userId).liveCount).toBe(0);
                expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
              } finally {
                peer.socket.destroy();
              }
            },
          );
        },
      );
    },
  );
});

it('logs a fixed safe write failure without disrupting forwarding and persists dirty activity on the next normal tick', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  try {
    await withGatewayActivityApp(async ({ app, database, config, base, lines }) => {
      const user = await registerInstanceUser(
        base,
        config.publicUrl,
        'activity-storage@example.test',
      );
      await withUpstream(
        (_incoming, response) => response.end('healthy'),
        async (target) => {
          seedActivityInstance(database, user.id, target);
          expect((await sendHttp(base, { headers: { cookie: user.cookie } })).body.toString()).toBe(
            'healthy',
          );
          await vi.advanceTimersByTimeAsync(1_000);
          expect(database.prepare('SELECT last_activity_at FROM instances').get()).toEqual({
            last_activity_at: NOW,
          });
          database.exec(
            "CREATE TRIGGER reject_activity BEFORE UPDATE OF last_activity_at ON instances BEGIN SELECT RAISE(ABORT, 'private-write-diagnostic'); END",
          );
          await vi.advanceTimersByTimeAsync(59_000);
          expect((await sendHttp(base, { headers: { cookie: user.cookie } })).body.toString()).toBe(
            'healthy',
          );
          await vi.advanceTimersByTimeAsync(1_000);
          expect(app.getUserActivity(user.id)).toEqual({
            liveCount: 0,
            lastActivityAt: NOW + 60_000,
          });
          expect(database.prepare('SELECT last_activity_at FROM instances').get()).toEqual({
            last_activity_at: NOW,
          });
          const output = lines.join('');
          expect(output).toContain('Gateway activity persistence failure');
          expect(output).not.toContain('private-write-diagnostic');
          expect(output).not.toContain(user.cookie);
          expect(output).not.toContain(target.cookie);
          database.exec('DROP TRIGGER reject_activity');
          await vi.advanceTimersByTimeAsync(1_000);
          expect(database.prepare('SELECT last_activity_at FROM instances').get()).toEqual({
            last_activity_at: NOW + 60_000,
          });
        },
      );
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([59_999, 60_000])(
  'settles final response release before database close without bypassing the cap at %sms',
  async (elapsed) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const gate = startupBarrier();
    try {
      await withGatewayActivityApp(
        async ({ app, service, database, config, base, port, holdEngine, lines }) => {
          const a = await registerInstanceUser(
            base,
            config.publicUrl,
            'closing-start@example.test',
          );
          const b = await registerInstanceUser(base, config.publicUrl, 'closing-live@example.test');
          writeSettings(database, {
            modelBaseUrl: 'http://model.invalid/v1',
            modelApiKey: 'fixture-model-key',
            models: [{ name: 'office-model' }],
            defaultModel: 'office-model',
          });
          holdEngine((method, path) =>
            method === 'GET' && path.startsWith('/images/') ? gate.hold() : undefined,
          );
          const starting = service.start(a.id);
          await observeHttp(gate.reached);
          try {
            await withUpstream(
              (_incoming, response) =>
                response.writeHead(200, { 'content-length': '1000' }).write('prefix'),
              async (target) => {
                seedActivityInstance(database, b.id, target);
                const peer = await connectActivityPeer(port);
                try {
                  peer.socket.write(
                    `GET /closing HTTP/1.1\r\nHost: localhost\r\nCookie: ${b.cookie}\r\n\r\n`,
                  );
                  expect((await peer.read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
                  expect(await peer.read(6)).toEqual(Buffer.from('prefix'));
                  vi.setSystemTime(NOW + 1_000);
                  await service.flushActivity();
                  expect(
                    database
                      .prepare('SELECT last_activity_at FROM instances WHERE user_id = ?')
                      .get(b.id),
                  ).toEqual({ last_activity_at: NOW });
                  vi.setSystemTime(NOW + 1_000 + elapsed);
                  let settled = false;
                  const closing = app.close().then(() => {
                    settled = true;
                  });
                  await observeHttp(peer.closed);
                  await observeActivity(() => app.getUserActivity(b.id).liveCount === 0);
                  await expect(service.start(b.id)).rejects.toThrow('Instance service unavailable');
                  expect(app.getUserActivity(b.id)).toEqual({
                    liveCount: 0,
                    lastActivityAt: NOW + 1_000 + elapsed,
                  });
                  expect(settled).toBe(false);
                  expect(database.open).toBe(true);
                  const persisted = elapsed === 60_000 ? NOW + 61_000 : NOW;
                  await observeActivity(() => {
                    const row = database
                      .prepare<[string], { last_activity_at: number }>(
                        'SELECT last_activity_at FROM instances WHERE user_id = ?',
                      )
                      .get(b.id);
                    return row?.last_activity_at === persisted;
                  });
                  gate.release();
                  expect(await starting).toEqual({ status: 'starting', reason: 'starting' });
                  await observeHttp(closing);
                  expect(database.open).toBe(false);
                  await vi.advanceTimersByTimeAsync(120_000);
                  expect(lines.join('')).not.toContain('Gateway activity persistence failure');
                  const reopened = openDatabase(join(config.dataDir, 'platform.db'));
                  try {
                    expect(
                      reopened
                        .prepare('SELECT status,last_activity_at FROM instances WHERE user_id = ?')
                        .get(b.id),
                    ).toEqual({ status: 'running', last_activity_at: persisted });
                  } finally {
                    reopened.close();
                  }
                } finally {
                  peer.socket.destroy();
                }
              },
            );
          } finally {
            gate.release();
            await starting;
          }
        },
      );
    } finally {
      gate.release();
      vi.useRealTimers();
    }
  },
);

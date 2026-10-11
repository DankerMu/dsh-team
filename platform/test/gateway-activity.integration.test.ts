import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import type { InstanceService } from '../src/orchestrator/index.ts';
import { startupUnixOwnerFixture } from './container-start-fixture.ts';
import { observeHttp, reader, withUpstream } from './gateway-http-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';

const ADMITTED_AT = 1_800_000_000_000;

it('counts a streamed authenticated response until finish and persists its latest activity at the next allowed minute', async () => {
  let app: FastifyInstance | undefined;
  let client: Socket | undefined;
  let service: InstanceService | undefined;
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-gateway-activity-',
    users: {},
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  try {
    // Only wall time and intervals are controlled: socket deadlines and cleanup stay real.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(ADMITTED_AT);
    const config = instanceConfig(f.root, { dockerSocketPath: join(f.root, 'engine.sock') });
    service = createInstanceService({
      database: f.database,
      config,
      client: createDockerClient(config.dockerSocketPath),
    });
    app = await buildApp(config, f.database, undefined, undefined, service);
    const activityApp = app;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing application port');
    const user = await registerInstanceUser(base, config.publicUrl, 'activity@example.test');
    const pending = Promise.withResolvers<ServerResponse>();
    await withUpstream(
      (_incoming, response) => {
        response.writeHead(200, { 'content-length': '11' }).write('prefix');
        pending.resolve(response);
      },
      async (target) => {
        f.database
          .prepare(
            "INSERT INTO instances(user_id,status,upstream_host,upstream_port,dsh_cookie,last_started_at,last_error) VALUES (?, 'running', '127.0.0.1', ?, ?, 101, 'historical diagnostic')",
          )
          .run(user.id, target.port, target.cookie);
        const before = f.database
          .prepare<[string], Record<string, unknown>>('SELECT * FROM instances WHERE user_id = ?')
          .get(user.id);
        const select = f.database.prepare<[string], { last_activity_at: number | null }>(
          'SELECT last_activity_at FROM instances WHERE user_id = ?',
        );
        const persisted = () => select.get(user.id)?.last_activity_at;
        expect(persisted()).toBeNull();
        client = connect(port, '127.0.0.1');
        const peer = client;
        const read = reader(peer);
        await observeHttp(once(peer, 'connect'));
        peer.write(
          `GET /activity HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${user.cookie}\r\nConnection: keep-alive\r\n\r\n`,
        );
        const response = await observeHttp(pending.promise);
        try {
          expect((await read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 200 /);
          expect(await read(6)).toEqual(Buffer.from('prefix'));
          expect(activityApp.getUserActivity(user.id)).toEqual({
            liveCount: 1,
            lastActivityAt: ADMITTED_AT,
          });

          // Establish the throttle from a successful real row update, not a timer tick
          // or a seeded timestamp. The existing session interval also fires here.
          for (let ticks = 0; ticks < 60 && persisted() === null; ticks += 1)
            await vi.advanceTimersToNextTimerAsync();
          expect(persisted()).toBe(ADMITTED_AT);
          const writtenAt = Date.now();
          await vi.advanceTimersByTimeAsync(1);
          const releasedAt = writtenAt + 1;
          response.end('-done');
          expect(await read(5)).toEqual(Buffer.from('-done'));
          expect(activityApp.getUserActivity(user.id)).toEqual({
            liveCount: 0,
            lastActivityAt: releasedAt,
          });
          // The response finished, but the reusable TCP connection is still open.
          expect(peer.destroyed).toBe(false);
          expect(persisted()).toBe(ADMITTED_AT);

          await vi.advanceTimersByTimeAsync(59_998);
          expect(Date.now()).toBe(writtenAt + 59_999);
          expect(persisted()).toBe(ADMITTED_AT);
          await vi.advanceTimersByTimeAsync(1);
          expect(Date.now()).toBe(writtenAt + 60_000);
          expect(persisted()).toBe(releasedAt);
          expect(
            f.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(user.id),
          ).toEqual({
            ...before,
            last_activity_at: releasedAt,
          });
        } finally {
          response.end();
          peer.destroy();
        }
      },
    );
  } finally {
    client?.destroy();
    try {
      await app?.close();
    } finally {
      try {
        await service?.close();
      } finally {
        try {
          await f.close();
        } finally {
          vi.useRealTimers();
        }
      }
    }
  }
});

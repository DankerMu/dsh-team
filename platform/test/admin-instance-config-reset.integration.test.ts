import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import { administrator } from './admin-config-fixture.ts';
import { jsonRequestHeaders, PUBLIC_ORIGIN } from './auth-fixture.ts';
import {
  START_HELPER,
  START_USER,
  startupBarrier,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';

it.each(['connected', 'disconnected'] as const)(
  'settles accepted reset and audit before application/database close with a %s HTTP caller',
  async (caller) => {
    const f = await startupUnixOwnerFixture({
      rootPrefix: 'dsh-admin-reset-',
      users: { [START_USER]: 'reset-target@example.test' },
      userImage: 'image:test',
      subnetPool: '172.30.0.0/16',
      transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
    });
    const config = instanceConfig(f.root, {
      ...f.input.config,
      publicUrl: PUBLIC_ORIGIN,
      dockerSocketPath: join(f.root, 'engine.sock'),
    });
    const service = createInstanceService({
      database: f.database,
      config,
      client: createDockerClient(config.dockerSocketPath),
    });
    const gate = startupBarrier();
    let app: FastifyInstance | undefined;
    let closing: Promise<void> | undefined;
    try {
      app = await buildApp(config, f.database, undefined, undefined, service);
      const admin = await administrator(app, f.database);
      f.database
        .prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')")
        .run(START_USER);
      f.daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
        status: 200,
        document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': START_USER } },
      });
      f.hold((method, path) =>
        method === 'DELETE' && path === `/containers/${START_HELPER}?force=true`
          ? gate.hold()
          : undefined,
      );
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const sessions = f.database
        .prepare('SELECT * FROM platform_sessions ORDER BY token_hash')
        .all();
      const controller = new AbortController();
      const pending = fetch(`${base}/_platform/api/admin/instances/${START_USER}/reset-config`, {
        method: 'POST',
        headers: jsonRequestHeaders({ cookie: admin.cookie }),
        body: '{}',
        signal: controller.signal,
      }).then(async (response) => ({ status: response.status, body: await response.text() }));
      const observed = pending.catch((error: unknown) => {
        if (caller === 'disconnected' && error instanceof Error && error.name === 'AbortError')
          return undefined;
        throw error;
      });
      await gate.reached;
      if (caller === 'disconnected') {
        controller.abort();
        expect(await observed).toBeUndefined();
      }
      await expect(service.start(START_USER)).rejects.toThrow('Instance service unavailable');
      let closed = false;
      closing = app.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      expect(f.database.open).toBe(true);
      gate.release();
      if (caller === 'connected') expect(await observed).toEqual({ status: 204, body: '' });
      await closing;
      expect(f.database.open).toBe(false);
      expect(f.daemon.containers.size).toBe(0);
      const reopened = openDatabase(join(f.root, 'platform.db'));
      try {
        expect(
          reopened
            .prepare(
              "SELECT actor_email,target_email,target,details FROM audit_events WHERE event_type='instance.config-reset'",
            )
            .all(),
        ).toEqual([
          {
            actor_email: admin.user.email,
            target_email: 'reset-target@example.test',
            target: START_USER,
            details: '{}',
          },
        ]);
        expect(
          reopened.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
        ).toEqual(sessions);
        expect(
          reopened
            .prepare('SELECT status,container_id FROM instances WHERE user_id=?')
            .get(START_USER),
        ).toEqual({ status: 'stopped', container_id: null });
      } finally {
        reopened.close();
      }
    } finally {
      gate.release();
      await closing;
      await app?.close();
      await service.close();
      await f.close();
    }
  },
);

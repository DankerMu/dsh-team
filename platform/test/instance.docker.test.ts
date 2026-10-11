import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import { inspect, record, startupClient } from './container-start-docker-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('registers and logs in over HTTP, explicitly starts, reaches real DSH HTML and reuses one container', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const database = openDatabase(
        join(dirname(lifecycle.overlayDirectory), 'instance-platform.db'),
      );
      applyMigrations(database);
      const config = instanceConfig(dirname(lifecycle.overlayDirectory), {
        userImage: lifecycle.imageId,
        seccompProfilePath: lifecycle.seccomp,
        managedConfigDir: lifecycle.overlayDirectory,
        logLevel: 'info',
      });
      const transport = startupClient(lifecycle);
      const service = createInstanceService({ database, config, client: transport.client });
      const lines: string[] = [];
      const app = await buildApp(
        config,
        database,
        { write: (line) => lines.push(line) },
        undefined,
        service,
      );
      try {
        await service.reconcile();
        await app.listen({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${String(app.addresses()[0]?.port)}`;
        const user = await registerInstanceUser(
          base,
          config.publicUrl,
          'gateway-employee@example.test',
        );
        const sibling = await registerInstanceUser(
          base,
          config.publicUrl,
          'gateway-sibling@example.test',
        );
        for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
          lifecycle.registerResource('volume', name, { 'dsh-team.user': user.id });
        lifecycle.registerResource('container', `dsh-team-u-${user.id}`, {
          'dsh-team.user': user.id,
        });
        // Canonical stored settings feed the production composition; no provider request is needed.
        const modelKey = 'docker-instance-fixture-only-not-a-provider-key';
        writeSettings(database, {
          modelBaseUrl: 'http://model.invalid/v1',
          modelApiKey: modelKey,
          models: [{ name: 'office-model' }],
          defaultModel: 'office-model',
        });
        const headers = {
          cookie: user.cookie,
          origin: config.publicUrl,
          'content-type': 'application/json',
        };
        const before = transport.requests.length;
        const passive = await fetch(`${base}/_platform/api/instance`, {
          headers: { cookie: user.cookie },
        });
        expect(await passive.json()).toEqual({ status: 'stopped', reason: 'stopped' });
        const unavailable = await fetch(`${base}/`, {
          headers: { cookie: user.cookie, accept: 'application/json' },
        });
        expect(unavailable.status).toBe(503);
        await unavailable.arrayBuffer();
        expect(transport.requests.length).toBe(before);
        const anonymous = await fetch(`${base}/_platform/api/instance/start`, {
          method: 'POST',
          headers: { origin: config.publicUrl, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(anonymous.status).toBe(401);
        await anonymous.arrayBuffer();
        const starts = await Promise.all(
          Array.from({ length: 3 }, () =>
            fetch(`${base}/_platform/api/instance/start`, { method: 'POST', headers, body: '{}' }),
          ),
        );
        for (const response of starts) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'starting', reason: 'starting' });
        }
        const deadline = Date.now() + 90_000;
        for (;;) {
          const status = await fetch(`${base}/_platform/api/instance`, {
            headers: { cookie: user.cookie },
          });
          expect(status.status).toBe(200);
          const current = record(await status.json());
          expect(Object.keys(current).sort()).toEqual(['reason', 'status']);
          if (current.status === 'running') {
            expect(current.reason).toBeNull();
            break;
          }
          expect(current).toEqual({ status: 'starting', reason: 'starting' });
          if (Date.now() >= deadline)
            throw new Error('Instance did not reach authenticated readiness');
          await delay(100);
        }
        const row = record(
          database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id),
        );
        if (typeof row.container_id !== 'string' || typeof row.dsh_cookie !== 'string')
          throw new Error('Missing ready identity');
        const container = inspect(lifecycle, row.container_id);
        expect(container.Name).toBe(`/dsh-team-u-${user.id}`);
        expect(container.Image).toBe(lifecycle.imageId);
        expect(record(container.Config).Labels).toEqual({
          'dsh-team.user': user.id,
          'dsh-team.test-run': lifecycle.runId,
        });
        const gateway = await fetch(`${base}/`, {
          headers: { cookie: user.cookie, accept: 'text/html', 'x-user-id': sibling.id },
        });
        expect(gateway.status).toBe(200);
        expect(gateway.headers.get('content-type')).toContain('text/html');
        expect(gateway.headers.get('set-cookie')).toBeNull();
        const html = await gateway.text();
        expect(html).toMatch(/<!doctype html/i);
        expect(html).toMatch(/<script[^>]+src=/i);
        const siblingStatus = await fetch(`${base}/_platform/api/instance?userId=${user.id}`, {
          headers: { cookie: sibling.cookie, 'x-user-id': user.id },
        });
        expect(await siblingStatus.json()).toEqual({ status: 'stopped', reason: 'stopped' });
        const audits = database
          .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
          .all();
        const again = await fetch(`${base}/_platform/api/instance/start`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(await again.json()).toEqual({ status: 'running', reason: null });
        expect(database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id)).toEqual(
          row,
        );
        expect(
          database
            .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
            .all(),
        ).toEqual(audits);
        expect(
          transport.requests.filter(
            ({ method, path }) =>
              method === 'POST' && path === `/containers/create?name=dsh-team-u-${user.id}`,
          ),
        ).toHaveLength(1);
        const exposed = html + lines.join('') + JSON.stringify(audits);
        expect(exposed).not.toContain(row.dsh_cookie);
        expect(exposed).not.toContain(modelKey);
        return row.container_id;
      } finally {
        await app.close();
      }
    },
  );
});

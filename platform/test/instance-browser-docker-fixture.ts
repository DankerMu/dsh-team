import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import { inspectAsync, record, startupClient } from './container-start-docker-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** Capture the mapped public origin before construction; the caller owns app.close(). */
export async function startBrowserPlatform(lifecycle: UserImageLifecycle, host: string) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') throw new Error('Missing browser port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  const origin = `http://${host}:${String(port)}`;
  const base = `http://127.0.0.1:${String(port)}`;
  const root = dirname(lifecycle.overlayDirectory);
  const database = openDatabase(join(root, 'browser-platform.db'));
  applyMigrations(database);
  const config = instanceConfig(root, {
    publicUrl: origin,
    authority: `${host}:${String(port)}`,
    userImage: lifecycle.imageId,
    seccompProfilePath: lifecycle.seccomp,
    managedConfigDir: lifecycle.overlayDirectory,
  });
  const transport = startupClient(lifecycle);
  const service = createInstanceService({ database, config, client: transport.client });
  const app = await buildApp(config, database, undefined, undefined, service);
  try {
    await service.reconcile();
    await app.listen({ host: '127.0.0.1', port });
    return { app, database, base, origin };
  } catch (error) {
    await app.close();
    throw error;
  }
}

/**
 * Start one registered employee's instance through the platform API and wait until it runs: the
 * owned identities are registered first, then the ready container is proved to be this image's,
 * named, labelled and mounted on the employee's own home and work volumes.
 */
export async function startEmployeeInstance(
  lifecycle: UserImageLifecycle,
  base: string,
  origin: string,
  database: DatabaseHandle,
  user: { id: string; cookie: string },
): Promise<string> {
  const ownership = { 'dsh-team.user': user.id };
  for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
    await lifecycle.registerResourceAsync('volume', name, ownership);
  await lifecycle.registerResourceAsync('container', `dsh-team-u-${user.id}`, ownership);
  const response = await fetch(`${base}/_platform/api/instance/start`, {
    method: 'POST',
    headers: { cookie: user.cookie, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'starting', reason: 'starting' });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const status = await fetch(`${base}/_platform/api/instance`, {
      headers: { cookie: user.cookie },
    });
    expect(status.status).toBe(200);
    const state = record(await status.json());
    if (state.status === 'running') {
      expect(state.reason).toBeNull();
      break;
    }
    expect(state).toEqual({ status: 'starting', reason: 'starting' });
    if (Date.now() >= deadline) throw new Error('First-use instance readiness deadline');
    await delay(100);
  }
  const row = record(
    database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(user.id),
  );
  if (typeof row.container_id !== 'string') throw new Error('Missing ready container ID');
  const container = await inspectAsync(lifecycle, row.container_id);
  expect(container.Id).toBe(row.container_id);
  expect(container.Image).toBe(lifecycle.imageId);
  expect(container.Name).toBe(`/dsh-team-u-${user.id}`);
  expect(record(container.Config).Labels).toMatchObject({
    'dsh-team.user': user.id,
    'dsh-team.test-run': lifecycle.runId,
  });
  expect(container.Mounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'volume',
        Name: `dsh-team-home-${user.id}`,
        Destination: '/data/home',
        RW: true,
      }),
      expect.objectContaining({
        Type: 'volume',
        Name: `dsh-team-work-${user.id}`,
        Destination: '/data/work',
        RW: true,
      }),
    ]),
  );
  return row.container_id;
}

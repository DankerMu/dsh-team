import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import { startupClient } from './container-start-docker-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';
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

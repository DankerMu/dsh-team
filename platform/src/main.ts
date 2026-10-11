import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { applyMigrations, openDatabase, readSettings } from './db/index.ts';
import {
  createDockerClient,
  createInstanceService,
  validateSubnetPool,
} from './orchestrator/index.ts';
import type { InstanceService } from './orchestrator/index.ts';

const config = loadConfig(process.env);
const database = openDatabase(join(config.dataDir, 'platform.db'));
const runtime: {
  app: FastifyInstance | undefined;
  service: InstanceService | undefined;
  stopping: boolean;
  shutdown: Promise<void> | undefined;
} = { app: undefined, service: undefined, stopping: false, shutdown: undefined };
const startup = Promise.withResolvers<undefined>();

function closeRuntime(): Promise<void> {
  runtime.stopping = true;
  runtime.shutdown ??= (async () => {
    // Fence immediately, including a signal during reconciliation or application construction.
    await runtime.service?.close();
    await startup.promise;
    if (runtime.app === undefined) database.close();
    else await runtime.app.close();
  })();
  return runtime.shutdown;
}

async function listenIfOpen(app: FastifyInstance): Promise<void> {
  // Re-read signal-mutated state after asynchronous construction, outside its earlier narrowing.
  if (runtime.stopping) return;
  await app.listen({ host: config.host, port: config.port });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void closeRuntime().catch(() => {
      runtime.app?.log.error('Platform shutdown failed');
      process.exitCode = 1;
    });
  });
}
try {
  applyMigrations(database);
  validateSubnetPool(config.subnetPool, readSettings(database).maxRunningInstances);
  runtime.service = createInstanceService({
    client: createDockerClient(config.dockerSocketPath),
    database,
    config,
  });
  await runtime.service.reconcile();
  if (!runtime.stopping) {
    const app = await buildApp(config, database, undefined, undefined, runtime.service);
    runtime.app = app;
    await listenIfOpen(app);
  }
} catch (error) {
  startup.resolve(undefined);
  await closeRuntime();
  throw error;
}
startup.resolve(undefined);
if (runtime.stopping) await closeRuntime();

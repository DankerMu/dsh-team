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
    // Starting close fences admission synchronously; never wait for lifecycle work before
    // Fastify's preClose can tear down the gateway's existing connections.
    const drain = runtime.service?.close();
    const closingApp = runtime.app?.close();
    // Observe both promises immediately, even when startup has not yet settled.
    const settled = Promise.allSettled([drain, closingApp]);
    await startup.promise;
    const lateResults =
      closingApp === undefined ? await Promise.allSettled([runtime.app?.close()]) : [];
    const results = await settled;
    if (
      results.some((result) => result.status === 'rejected') ||
      lateResults.some((result) => result.status === 'rejected')
    )
      throw new Error('Platform shutdown failed');
    if (runtime.app === undefined) database.close();
  })();
  return runtime.shutdown;
}

async function listenIfOpen(app: FastifyInstance): Promise<void> {
  // Re-read signal-mutated state after asynchronous construction, outside its earlier narrowing.
  if (runtime.stopping) return;
  await app.listen({ host: config.host, port: config.port });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
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

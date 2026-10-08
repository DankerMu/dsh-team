import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { applyMigrations, openDatabase, readSettings } from './db/index.ts';
import { validateSubnetPool } from './orchestrator/index.ts';

const config = loadConfig(process.env);
const database = openDatabase(join(config.dataDir, 'platform.db'));
let app: FastifyInstance | undefined;
try {
  applyMigrations(database);
  validateSubnetPool(config.subnetPool, readSettings(database).maxRunningInstances);
  app = await buildApp(config, database);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app?.close();
    });
  }
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  if (app === undefined) {
    database.close();
  } else {
    await app.close();
  }
  throw error;
}

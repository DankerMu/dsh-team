import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);
const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({ host: config.host, port: config.port });

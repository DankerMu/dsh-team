import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const SILENT_CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'silent',
  dataDir: './data',
} as const;

function captureLog(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('buildApp', () => {
  it('serves the health route', async () => {
    const app = await buildApp(SILENT_CONFIG);

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    expect(response.statusCode).toBe(200);
  });

  it('answers 404 for an unknown route', async () => {
    const app = await buildApp(SILENT_CONFIG);

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });
    await app.close();

    expect(response.statusCode).toBe(404);
  });

  it('describes the health route in the OpenAPI document', async () => {
    const app = await buildApp(SILENT_CONFIG);
    await app.ready();

    const document = app.swagger();
    await app.close();

    expect(document.paths).toHaveProperty('/healthz');
  });

  it('writes structured JSON log lines at the configured level', async () => {
    const log = captureLog();
    const app = await buildApp({ ...SILENT_CONFIG, logLevel: 'info' }, log);

    app.log.debug('below the configured level');
    app.log.info('instance started');
    await app.close();

    expect(log.lines).toHaveLength(1);
    expect(JSON.parse(log.lines[0] ?? '')).toMatchObject({ level: 30, msg: 'instance started' });
  });

  it('redacts credentials before they reach the log', async () => {
    const log = captureLog();
    const app = await buildApp({ ...SILENT_CONFIG, logLevel: 'info' }, log);

    app.log.info({
      req: { headers: { authorization: 'Bearer launch-token', cookie: 'dsh=signed-cookie' } },
      user: { password: 'hunter2', token: 'opaque-token', apiKey: 'sk-model-key' },
    });
    await app.close();

    const written = log.lines.join('');
    for (const secret of [
      'launch-token',
      'signed-cookie',
      'hunter2',
      'opaque-token',
      'sk-model-key',
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(written).toContain('[redacted]');
  });
});

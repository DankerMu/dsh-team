import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyPluginCallback } from 'fastify';
import { buildApp } from './app.ts';
import { applyMigrations, openDatabase, readSettings } from './db/index.ts';

const SILENT_CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'silent',
  dataDir: './data',
  managedConfigDir: './data/managed-config',
  dockerSocketPath: '/var/run/docker.sock',
  userImage: 'dsh-team-user:local',
  seccompProfilePath: '/unused/seccomp.json',
  publicUrl: 'http://127.0.0.1:8080',
  authority: '127.0.0.1:8080',
  cookieSecure: false,
  trustedProxies: [],
} as const;

const healthFault = vi.hoisted(() => ({
  failWith: undefined as Error | undefined,
  closeHookRan: false,
}));

vi.mock('./health.ts', async (importOriginal) => {
  const actual = await importOriginal<{ healthRoutes: FastifyPluginCallback }>();
  const wrapped: FastifyPluginCallback = (app, options, done) => {
    const failure = healthFault.failWith;
    if (failure !== undefined) {
      app.addHook('onClose', (_instance, closeDone) => {
        healthFault.closeHookRan = true;
        closeDone();
      });
      done(failure);
      return;
    }
    actual.healthRoutes(app, options, done);
  };
  return { healthRoutes: wrapped };
});

function captureLog(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('buildApp', () => {
  afterEach(() => {
    healthFault.failWith = undefined;
    healthFault.closeHookRan = false;
  });

  it('serves the health route', async () => {
    const database = openDatabase(':memory:');
    applyMigrations(database);
    const app = await buildApp(SILENT_CONFIG, database);

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    expect(response.statusCode).toBe(200);
  });

  it('answers 404 for an unknown route', async () => {
    const database = openDatabase(':memory:');
    applyMigrations(database);
    const app = await buildApp(SILENT_CONFIG, database);

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });
    await app.close();

    expect(response.statusCode).toBe(404);
  });

  it('describes the health route in the OpenAPI document', async () => {
    const database = openDatabase(':memory:');
    applyMigrations(database);
    const app = await buildApp(SILENT_CONFIG, database);
    await app.ready();

    const document = app.swagger();
    await app.close();

    expect(document.paths).toHaveProperty('/healthz');
  });

  it('writes structured JSON log lines at the configured level', async () => {
    const log = captureLog();
    const database = openDatabase(':memory:');
    applyMigrations(database);
    const app = await buildApp({ ...SILENT_CONFIG, logLevel: 'info' }, database, log);

    app.log.debug('below the configured level');
    app.log.info('instance started');
    await app.close();

    expect(log.lines).toHaveLength(1);
    expect(JSON.parse(log.lines[0] ?? '')).toMatchObject({ level: 30, msg: 'instance started' });
  });

  it('redacts credentials before they reach the log', async () => {
    const log = captureLog();
    const database = openDatabase(':memory:');
    applyMigrations(database);
    const app = await buildApp({ ...SILENT_CONFIG, logLevel: 'info' }, database, log);

    app.log.info({
      user: {
        password: 'hunter2',
        currentPassword: 'current-password-marker',
        newPassword: 'new-password-marker',
        token: 'opaque-token',
        apiKey: 'sk-model-key',
        email: 'alice@example.com',
      },
    });
    await app.close();

    const written = log.lines.join('');
    expect(JSON.parse(log.lines[0] ?? '')).toMatchObject({
      user: {
        password: '[redacted]',
        currentPassword: '[redacted]',
        newPassword: '[redacted]',
        token: '[redacted]',
        apiKey: '[redacted]',
        email: 'alice@example.com',
      },
    });
    for (const secret of [
      'hunter2',
      'current-password-marker',
      'new-password-marker',
      'opaque-token',
      'sk-model-key',
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it('leaves the caller-owned database open after construction failure', async () => {
    const failure = new Error('health plugin refused');
    healthFault.failWith = failure;
    const database = openDatabase(':memory:');
    applyMigrations(database);

    try {
      await expect(buildApp(SILENT_CONFIG, database)).rejects.toBe(failure);
      expect(healthFault.closeHookRan).toBe(true);
      expect(database.open).toBe(true);
      expect(readSettings(database).idleMinutes).toBe(30);
    } finally {
      database.close();
    }
  });
});

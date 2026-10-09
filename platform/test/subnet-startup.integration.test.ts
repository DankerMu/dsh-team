import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an owned TCP port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function observeStartup(
  pool: string | undefined,
  maxRunningInstances?: number,
  environment: Readonly<Record<string, string>> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-subnet-'));
  try {
    const database = openDatabase(join(directory, 'platform.db'));
    try {
      applyMigrations(database);
      if (maxRunningInstances !== undefined) writeSettings(database, { maxRunningInstances });
    } finally {
      database.close();
    }
    const port = await unusedPort();
    const child = spawn(process.execPath, [mainPath], {
      cwd: directory,
      env: {
        PLATFORM_HOST: '127.0.0.1',
        PLATFORM_PORT: String(port),
        PLATFORM_LOG_LEVEL: 'silent',
        PLATFORM_PUBLIC_URL: `http://127.0.0.1:${String(port)}`,
        PLATFORM_DATA_DIR: directory,
        ...(pool === undefined ? {} : { PLATFORM_SUBNET_POOL: pool }),
        ...environment,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      // A broken startup must not leave a process behind, even if observation fails.
      timeout: 6000,
      killSignal: 'SIGKILL',
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(child, 'close');
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          await closed;
          return { exitCode: child.exitCode, stderr, health: null };
        }
        let response: Response | undefined;
        try {
          response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
            signal: AbortSignal.timeout(200),
          });
        } catch {
          // Connection refusal/timeouts are expected until the real main listens.
        }
        if (response !== undefined) {
          const body: unknown = await response.json();
          return { exitCode: child.exitCode, stderr, health: { status: response.status, body } };
        }
        await delay(20);
      }
      throw new Error(`Startup neither exited nor served health before its deadline: ${stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('subnet pool validation in the actual source process', () => {
  it('rejects a pool one subnet short of the persisted running limit before serving health', async () => {
    const result = await observeStartup('172.30.0.0/27', 3);

    expect(result.health).toBeNull();
    expect(result.exitCode, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.stderr).toContain('PLATFORM_SUBNET_POOL');
  }, 10000);

  it('serves health when the pool exactly fits the persisted running limit', async () => {
    const result = await observeStartup('172.30.0.0/27', 2);

    expect(result.exitCode).toBeNull();
    expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
    expect(result.stderr).toBe('');
  }, 10000);

  it('checks the canonical default running limit when SQLite has no override', async () => {
    const result = await observeStartup('172.30.0.0/23');

    expect(result.health).toBeNull();
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/PLATFORM_SUBNET_POOL.*maxRunningInstances=60/);
  }, 10000);

  it('uses the default pool only when the environment key is absent', async () => {
    const absent = await observeStartup(undefined, 4096);
    const empty = await observeStartup('', 1);

    expect(absent.health).toEqual({ status: 200, body: { status: 'ok' } });
    expect(absent.exitCode).toBeNull();
    expect(empty.health).toBeNull();
    expect(empty.exitCode).toBeGreaterThan(0);
    expect(empty.stderr).toContain('PLATFORM_SUBNET_POOL');
  }, 15000);

  it.each([
    ['PLATFORM_UPSTREAM_MODE', 'host'],
    ['PLATFORM_CONTAINER_NAME', '/dsh-team-platform'],
  ])(
    'rejects malformed %s before serving health',
    async (key, value) => {
      const result = await observeStartup(undefined, undefined, { [key]: value });

      expect(result.health).toBeNull();
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stderr).toContain(key);
    },
    10000,
  );

  it('network configuration serves health without resolving an absent platform or Docker socket', async () => {
    const result = await observeStartup(undefined, undefined, {
      PLATFORM_UPSTREAM_MODE: 'network',
      PLATFORM_CONTAINER_NAME: 'dsh-team-test-not-created',
      PLATFORM_DOCKER_SOCKET: '/absent/docker.sock',
    });

    expect(result.exitCode).toBeNull();
    expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
    expect(result.stderr).toBe('');
  }, 10000);
});

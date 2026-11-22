import { describe, expect, it } from 'vitest';
import { observeStartup, STARTUP_CASE_MS } from './main-startup-fixture.ts';

const STARTUP_CASE = { timeout: STARTUP_CASE_MS };

describe('subnet pool validation in the actual source process', STARTUP_CASE, () => {
  it('rejects a pool one subnet short of the persisted running limit before serving health', async () => {
    const result = await observeStartup('172.30.0.0/27', 3);

    expect(result.health).toBeNull();
    expect(result.exitCode, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.stderr).toContain('PLATFORM_SUBNET_POOL');
  });

  it('serves health when the pool exactly fits the persisted running limit', async () => {
    const result = await observeStartup('172.30.0.0/27', 2);

    expect(result.exitCode).toBeNull();
    expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
    expect(result.stderr).toBe('');
  });

  it('checks the canonical default running limit when SQLite has no override', async () => {
    const result = await observeStartup('172.30.0.0/23');

    expect(result.health).toBeNull();
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/PLATFORM_SUBNET_POOL.*maxRunningInstances=60/);
  });

  it(
    'uses the default pool only when the environment key is absent',
    async () => {
      const absent = await observeStartup(undefined, 4096);
      const empty = await observeStartup('', 1);

      expect(absent.health).toEqual({ status: 200, body: { status: 'ok' } });
      expect(absent.exitCode).toBeNull();
      expect(empty.health).toBeNull();
      expect(empty.exitCode).toBeGreaterThan(0);
      expect(empty.stderr).toContain('PLATFORM_SUBNET_POOL');
    },
    2 * STARTUP_CASE_MS,
  );

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
    STARTUP_CASE_MS,
  );

  it('fails before serving when real reconciliation cannot reach the configured Docker socket', async () => {
    const result = await observeStartup(undefined, undefined, {
      PLATFORM_UPSTREAM_MODE: 'network',
      PLATFORM_CONTAINER_NAME: 'dsh-team-test-not-created',
      PLATFORM_DOCKER_SOCKET: '/absent/docker.sock',
    });

    expect(result.health).toBeNull();
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain('Instance reconciliation failed');
  });

  it('does not listen while the real owner reconciliation is held at the Engine boundary', async () => {
    const result = await observeStartup(undefined, undefined, {}, async (url) => {
      await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toBeInstanceOf(Error);
    });

    expect(result.exitCode).toBeNull();
    expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
    expect(result.stderr).toBe('');
  });
  it('settles held startup reconciliation after SIGTERM without subsequently listening', async () => {
    const result = await observeStartup(undefined, undefined, {}, async (url, terminate) => {
      terminate();
      await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toBeInstanceOf(Error);
    });

    expect(result.exitCode).toBe(0);
    expect(result.health).toBeNull();
    expect(result.stderr).toBe('');
  });
});

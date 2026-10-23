import { expect, it } from 'vitest';
import { runWorkerProxyScenario } from './ci-vps-proxy-fixture.ts';

it('uses private host-local proxy transport for independent exact-owned image retirement', async () => {
  const result = await runWorkerProxyScenario('finalize-locked');

  expect(result).toMatchObject({
    exit: 0,
    receipt: { vpsCleanupComplete: true, failures: [] },
    imagePresent: false,
    removed: [`sha256:${'a'.repeat(64)}`],
  });
  expect(result.output.includes(result.canary)).toBe(false);
});

it('keeps host proxy values out of the actual worker driver while checkout git and its Docker client use them', async () => {
  const result = await runWorkerProxyScenario('execute');

  expect(result).toMatchObject({ exit: 0, receipt: { exitCode: 0 }, driverPassed: true });
  expect(result.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'git',
        // Vitest's matcher is an untyped expected-value sentinel, not observed data.
        args: expect.arrayContaining(['fetch']) as unknown,
        proxyInherited: true,
        keyPresent: false,
      }),
      expect.objectContaining({
        role: 'pnpm',
        args: ['install', '--frozen-lockfile'],
        proxyInherited: false,
        keyPresent: false,
      }),
      expect.objectContaining({
        role: 'pnpm',
        args: ['build'],
        proxyInherited: false,
        keyPresent: false,
      }),
      expect.objectContaining({
        role: 'pnpm',
        args: ['test:model'],
        proxyInherited: false,
        keyPresent: true,
      }),
      expect.objectContaining({
        role: 'docker',
        args: ['info'],
        proxyInherited: true,
        keyPresent: false,
      }),
    ]),
  );
  expect(result.output).toContain('model-client-boundary-ok');
  expect(result.output.includes(result.canary)).toBe(false);
});

it('preserves host-local proxy context through imported browser rescue before image retirement', async () => {
  const result = await runWorkerProxyScenario('browser-rescue');

  expect(result).toMatchObject({
    exit: 0,
    receipt: { vpsCleanupComplete: true, failures: [] },
    imagePresent: false,
    removed: [`sha256:${'a'.repeat(64)}`],
  });
  expect(result.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'docker',
        // Vitest's matcher is an untyped expected-value sentinel, not observed data.
        args: expect.arrayContaining(['container', 'inspect']) as unknown,
        keyPresent: false,
      }),
      expect.objectContaining({
        role: 'docker',
        // Vitest's matcher is an untyped expected-value sentinel, not observed data.
        args: expect.arrayContaining(['network', 'inspect']) as unknown,
        keyPresent: false,
      }),
    ]),
  );
  expect(result.output.includes(result.canary)).toBe(false);
});

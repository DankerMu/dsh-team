import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { runDockerVersion } from './docker-version-fixture.ts';

it('builds the user image and reports exactly DSH 0.2.0-rc.2 with owned-resource cleanup', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runDockerVersion((stdout) => {
    expect(stdout.replace(/\r?\n$/, '')).toBe('0.2.0-rc.2');
  });

  process.stdout.write(
    `Docker version verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} version=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

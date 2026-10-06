import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { assertDocxReadback, runUserImage } from './user-image-fixture.ts';
import { profileSeedOracle } from './profile-seed-fixture.ts';

it('builds the user image and reports exactly DSH 0.2.0-rc.2 with owned-resource cleanup', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('version', (stdout) => {
    expect(stdout.replace(/\r?\n$/, '')).toBe('0.2.0-rc.2');
  });

  process.stdout.write(
    `Docker version verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} version=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

it('saves and reopens exact Chinese DOCX content offline as the normal uid1001 user', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('offline-docx', assertDocxReadback);

  process.stdout.write(
    `Docker offline DOCX verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} network=none configuredUser=dsh ` +
      `readback=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

it('copies meaningful immutable Web profiles into a fresh named volume and preserves uid1001 edits on reuse', () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = runUserImage('profile-seed', profileSeedOracle());

  process.stdout.write(
    `Docker profile seed verified: run=${result.runId} image=${result.image} ` +
      `containers=${result.containers.join(',')} volume=${String(result.volume)} ` +
      `network=none configuredUser=dsh readback=${result.stdout.replace(/\r?\n$/, '')} cleanup=complete\n`,
  );
});

it('starts real DSH Web under shipped seccomp with separate volumes and unauthenticated HTTP401', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage('web-startup', (summary) => {
    const observed: unknown = JSON.parse(summary);
    expect(observed).toMatchObject({ tokenSeen: true, httpStatus: 401, telemetryDisabled: true });
  });

  process.stdout.write(
    `Docker Web startup verified: run=${result.runId} image=${result.image} ` +
      `container=${result.container} state=${String(result.volume)} work=${String(result.workVolume)} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

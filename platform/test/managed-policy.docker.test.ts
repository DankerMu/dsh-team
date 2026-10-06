import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { runManagedPolicyScenario } from './managed-policy-fixture.ts';

function requirePort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

it('enforces managed policy after employee edits, restart, and live readback', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      const observed: unknown = JSON.parse(summary);
      if (typeof observed !== 'object' || observed === null || Array.isArray(observed)) {
        throw new Error('Invalid managed policy summary');
      }
      // JSON summary fields are unknown until the port/path checks below.
      const record = observed as Record<string, unknown>;
      requirePort(record.startPort, 'startPort');
      requirePort(record.restartPort, 'restartPort');
      expect(typeof record.startScreenshot).toBe('string');
      expect(typeof record.restartScreenshot).toBe('string');
    },
    undefined,
    runManagedPolicyScenario,
  );

  process.stdout.write(
    `Docker managed policy verified: run=${result.runId} image=${result.image} ` +
      `state=${String(result.volume)} work=${String(result.workVolume)} cleanup=complete\n`,
  );
});

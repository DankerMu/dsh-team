import { arch, platform } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { runManagedPolicyScenario } from './managed-policy-fixture.ts';
import { managedPolicyEvidenceRoot } from './managed-policy-evidence.ts';

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

  let artifactPath = '';
  const scenario = (lifecycle: UserImageLifecycle): Promise<string> => {
    artifactPath = join(managedPolicyEvidenceRoot(lifecycle.runId), 'observations.json');
    return runManagedPolicyScenario(lifecycle);
  };

  try {
    const result = await runUserImage(
      'managed-policy',
      (summary) => {
        const observed: unknown = JSON.parse(summary);
        if (typeof observed !== 'object' || observed === null || Array.isArray(observed)) {
          throw new Error('Invalid managed policy summary');
        }
        const record = observed as Record<string, unknown>;
        requirePort(record.startPort, 'startPort');
        requirePort(record.restartPort, 'restartPort');
        expect(typeof record.startScreenshot).toBe('string');
        expect(typeof record.restartScreenshot).toBe('string');
        expect(typeof record.imageId).toBe('string');
        expect(record.controlRejected).toBe(true);
        expect(record.startObservation).toBeDefined();
        expect(record.restartObservation).toBeDefined();
        expect(record.controlObservation).toBeDefined();
        const retained = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        expect(retained.runId).toBe(record.runId);
        expect(retained.imageId).toBe(record.imageId);
        expect(retained.startObservation).toEqual(record.startObservation);
        expect(retained.restartObservation).toEqual(record.restartObservation);
        expect(retained.controlObservation).toEqual(record.controlObservation);
        expect(retained.startBrowser).toEqual(record.startBrowser);
        expect(retained.restartBrowser).toEqual(record.restartBrowser);
      },
      undefined,
      scenario,
    );

    process.stdout.write(`Docker managed policy success artifact=${artifactPath}\n`);
    process.stdout.write(
      `Docker managed policy verified: run=${result.runId} image=${result.image} ` +
        `state=${String(result.volume)} work=${String(result.workVolume)} cleanup=complete\n`,
    );
  } catch (error) {
    if (artifactPath !== '') {
      process.stdout.write(`Docker managed policy failure artifact=${artifactPath}\n`);
    }
    throw error;
  }
});

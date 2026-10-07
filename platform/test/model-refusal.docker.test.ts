import { arch, platform } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { modelRefusalEvidenceRoot, runModelRefusalScenario } from './model-refusal-fixture.ts';
import { remoteRecord } from './model-refusal-oracle.ts';

it('shows terminal managed model refusal without contacting the reachable employee address', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  let artifactPath = '';
  try {
    const result = await runUserImage(
      'managed-policy',
      (summary) => {
        const observed = remoteRecord(JSON.parse(summary));
        const retained = remoteRecord(JSON.parse(readFileSync(artifactPath, 'utf8')));
        expect(retained).toEqual(observed);
        expect(observed.accepted).toBe(true);
        expect(remoteRecord(observed.observation).accepted).toBe(true);
        expect(remoteRecord(remoteRecord(observed.observation).recorder).total).toBe(1);
        if (typeof observed.screenshot !== 'string')
          throw new Error('Missing model refusal screenshot');
        expect(readFileSync(observed.screenshot).subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
      },
      undefined,
      (lifecycle) => {
        artifactPath = join(modelRefusalEvidenceRoot(lifecycle.runId), 'observations.json');
        return runModelRefusalScenario(lifecycle);
      },
    );
    process.stdout.write(
      `Docker model refusal verified: run=${result.runId} image=${result.image} cleanup=complete artifact=${artifactPath}\n`,
    );
  } catch (error) {
    if (artifactPath)
      process.stdout.write(`Docker model refusal failure artifact=${artifactPath}\n`);
    throw error;
  }
});

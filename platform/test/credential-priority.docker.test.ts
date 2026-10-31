import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { runCredentialPriorityScenario } from './credential-priority-fixture.ts';

it('uses the platform-injected managed provider value over an employee credentials-file entry after restart', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        credentialFile: { uid: 1001, mode: '600' },
        total: 1,
        inflight: 0,
        observed: ['platform'],
      });
    },
    undefined,
    runCredentialPriorityScenario,
  );
  process.stdout.write(
    `Docker credential priority verified: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

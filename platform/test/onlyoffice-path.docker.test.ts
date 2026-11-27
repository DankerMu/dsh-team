import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { runOnlyofficePathScenario } from './onlyoffice-token-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('resolves session-relative ONLYOFFICE config and watch paths under the session directory and refuses the rest (#760)', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      // The scenario compares the start against its exact expectation; this pins the shape.
      expect(JSON.parse(summary)).toMatchObject({
        config: { relative: { status: 200, key: true, claim: true }, escaping: { status: 403 } },
        watch: { relative: { status: 200, changes: [true] }, escaping: { status: 403 } },
      });
    },
    undefined,
    runOnlyofficePathScenario,
  );

  process.stdout.write(
    `Docker ONLYOFFICE session-relative paths verified: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

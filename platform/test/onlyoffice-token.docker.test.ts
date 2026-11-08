import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { runOnlyofficeTokenScenario } from './onlyoffice-token-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

it('derives ONLYOFFICE file tokens and document keys only from the per-start secret and refuses everything without it', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }

  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      // The scenario compares each start against its exact expectation; this pins the shape.
      expect(JSON.parse(summary)).toMatchObject({
        absent: { secret: null, publicToken: { status: 403 }, registry: { k0: false } },
        present: {
          secretToken: { status: 200, matches: true },
          publicToken: { status: 403 },
          registry: { k0: false, k1: true },
        },
      });
    },
    undefined,
    runOnlyofficeTokenScenario,
  );

  // Evidence carries only the secret's SHA-256 prefix, never the secret.
  process.stdout.write(
    `Docker ONLYOFFICE token isolation verified: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

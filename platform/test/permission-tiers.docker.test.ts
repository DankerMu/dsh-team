import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { collectComposition, execScript } from './managed-policy-fixture.ts';
import { generateManagedConfig } from '../src/managed-config/index.ts';
import { permissionScenarioScript } from './permission-tiers-fixture.ts';
import { runPermissionBrowserScenario } from './permission-browser-fixture.mjs';

it('delivers an immutable exact-peer gate outside employee profiles', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const script = `
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
const root='/opt/dsh-team/permission-tiers';
for(const path of ['/opt','/opt/dsh-team',root,root+'/index.js',root+'/review.js',root+'/client.js',root+'/package.json']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.mode & 0o022,0);
  if(path.startsWith(root+'/')) assert.equal(stat.mode & 0o777,0o444);
}
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'],'0.2.0-rc.2');
const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
assert.equal(require('@deepseek-ai/dsh/package.json').version,'0.2.0-rc.2');
assert.throws(()=>writeFileSync(root+'/index.js','employee code'));
assert.throws(()=>writeFileSync(root+'/client.js','employee code'));
assert.throws(()=>renameSync(root+'/index.js',root+'/employee.js'));
assert.throws(()=>renameSync(root+'/client.js',root+'/employee-client.js'));
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,peer:'0.2.0-rc.2',uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({ immutable: true, peer: '0.2.0-rc.2', uid: 1001 });
    },
    undefined,
    (lifecycle) =>
      Promise.resolve(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-permission-trust`, script),
      ),
  );
});

it('authorizes real released tools through native approval, Auto protocol, child scope and final guards', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const host = readFileSync(new URL('./permission-tiers-host.js', import.meta.url), 'utf8');
  const revocationHost = readFileSync(
    new URL('./permission-tiers-revocation-host.mjs', import.meta.url),
    'utf8',
  );

  await runUserImage(
    'managed-policy',
    (stdout) => {
      const report: unknown = JSON.parse(stdout);
      expect(report).toEqual({
        passed: true,
        defaults: ['danger-full-access', 'approval', 'auto-review'],
        childApproval: true,
        protocol: true,
        stale: true,
        unload: true,
      });
    },
    undefined,
    async (lifecycle) => {
      const composition = await collectComposition(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-permission-compose`,
      );
      const overlays = (['yolo', 'approval', 'auto'] as const).map((defaultPermissionTier) => {
        const generated = generateManagedConfig({
          ...composition,
          defaultPermissionTier,
          modelSettings: {
            baseURL: 'http://127.0.0.1:9/v1',
            apiKeyEnv: 'DSH_TEAM_TEST_KEY',
            apiKeyConfigured: true,
            models: [{ name: 'fixture' }],
            defaultModel: 'fixture',
          },
        });
        if (generated.outcome !== 'configured')
          throw new Error('Permission fixture requires a configured overlay');
        return generated.content;
      });
      // Avoid putting three complete profile documents in one Linux argv element.
      const overlayFiles = overlays.map((content, index) => {
        const path = `/data/home/permission-overlay-${String(index)}.json`;
        execScript(
          lifecycle,
          `dsh-team-test-${lifecycle.runId}-permission-overlay-${String(index)}`,
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`,
        );
        return path;
      });
      return execScript(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-permission-behavior`,
        permissionScenarioScript(host, overlayFiles, revocationHost),
      );
    },
  );
});

it('enforces root and one-shot child reject, allow and cancel through the actual DSH browser UI', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const chromeBin = process.env.CHROME_BIN;
  if (chromeBin === undefined || chromeBin === '')
    throw new Error('CHROME_BIN is required for permission browser verification');
  const artifactRoot = join(process.cwd(), '.run', 'issue83');
  mkdirSync(artifactRoot, { recursive: true });
  const evidenceDirectory = mkdtempSync(join(artifactRoot, 'permission-browser-'));
  let runId: string | undefined;

  try {
    const result = await runUserImage(
      'managed-policy',
      (summary) => {
        const observed: unknown = JSON.parse(summary);
        expect(observed).toMatchObject({ status: 'PASS', scenarios: 6 });
      },
      undefined,
      async (lifecycle) => {
        runId = lifecycle.runId;
        return runPermissionBrowserScenario(lifecycle, { chromeBin, evidenceDirectory });
      },
    );
    writeFileSync(
      join(evidenceDirectory, 'lifecycle.json'),
      JSON.stringify(
        {
          status: 'PASS',
          runId: result.runId,
          cleanupComplete: true,
          ownerLabel: 'dsh-team.test-run',
          resources: {
            containers: result.containers,
            image: result.image,
            volume: result.volume,
            workVolume: result.workVolume,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    process.stdout.write(`Docker permission browser success artifact=${evidenceDirectory}\n`);
  } catch {
    writeFileSync(
      join(evidenceDirectory, 'lifecycle.json'),
      JSON.stringify(
        {
          status: 'FAIL',
          runId: runId ?? null,
          cleanupComplete: false,
          cleanupMeaning:
            'runUserImage attempted exact-label cleanup; parent must inspect owned inventory',
          ownerLabel: 'dsh-team.test-run',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    process.stdout.write(`Docker permission browser failure artifact=${evidenceDirectory}\n`);
    // Lifecycle errors can include raw Docker output; durable evidence is sanitized.
    throw new Error('Permission browser failed; see retained evidence and owned cleanup inventory');
  }
});

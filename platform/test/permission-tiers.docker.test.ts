import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { collectComposition, execScript } from './managed-policy-fixture.ts';
import { WEB_CONTAINER_ADDRESS } from './web-startup-fixture.ts';
import { generateManagedConfig } from '../src/managed-config/index.ts';
import { permissionScenarioScript } from './permission-tiers-fixture.ts';
import {
  runPermissionBrowserScenario,
  type PermissionBrowserSuite,
} from './permission-browser-fixture.mjs';
import { isolatedBrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import { DSH_ENGINES_PRELUDE } from './dsh-engines.ts';

it('delivers an immutable DSH-compatible gate outside employee profiles', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const script = `
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
${DSH_ENGINES_PRELUDE}
const root='/opt/dsh-team/permission-tiers';
for(const path of ['/opt','/opt/dsh-team',root,root+'/index.js',root+'/review.js',root+'/client.js',root+'/package.json']) {
  const stat=statSync(path); assert.equal(stat.uid,0); assert.equal(stat.mode & 0o022,0);
  if(path.startsWith(root+'/')) assert.equal(stat.mode & 0o777,0o444);
}
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'],undefined);
assert.equal(dshInstalled,'0.2.1-rc.2');
assert.equal(dshEnginesSatisfied(manifest.engines?.dsh),true);
assert.throws(()=>writeFileSync(root+'/index.js','employee code'));
assert.throws(()=>writeFileSync(root+'/client.js','employee code'));
assert.throws(()=>renameSync(root+'/index.js',root+'/employee.js'));
assert.throws(()=>renameSync(root+'/client.js',root+'/employee-client.js'));
assert.equal(process.getuid(),1001);
process.stdout.write(JSON.stringify({immutable:true,engines:manifest.engines.dsh,uid:1001}));
`;

  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toEqual({
        immutable: true,
        engines: '>=0.2.1-rc.2 <0.3.0',
        uid: 1001,
      });
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
          admin: false,
          instanceAddress: WEB_CONTAINER_ADDRESS,
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

const ONE_SHOT: PermissionBrowserSuite = {
  mode: 'one-shot',
  prompt: 'issue83-ui',
  title: 'issue83',
  overlay: 'uioracle0001',
  chrome: 'issue83-ui-chrome-',
  scenarios: (['root', 'delegate'] as const).flatMap((scope) =>
    (['reject', 'allow', 'cancel'] as const).map((action) => ({ scope, action })),
  ),
  limits: [
    'No real model calls; #84/#85 remain unproven.',
    'Auto selected only here; the continuable browser case (#391) covers the real Auto review allow.',
    'No administrator-default restart/resume/PTC/unload coverage in this browser oracle.',
  ],
};

// The rc.2 standard preset delegates with backgroundMode continuable; the owned
// issue391-ui protocol selects it through run_in_background: true.
const CONTINUABLE: PermissionBrowserSuite = {
  mode: 'continuable',
  prompt: 'issue391-ui',
  title: 'issue391',
  overlay: 'uioracle0391',
  chrome: 'issue391-ui-chrome-',
  scenarios: [
    { scope: 'delegate', name: 'reject', action: 'reject' },
    { scope: 'delegate', name: 'allow', action: 'allow' },
    { scope: 'delegate', name: 'cancel', action: 'cancel' },
    {
      scope: 'delegate',
      name: 'auto',
      action: 'allow',
      tier: 'Auto',
      unattended: true,
      child: { tier: 'auto-review', policy: 'ask' },
      reviews: 1,
    },
    {
      scope: 'delegate',
      name: 'yolo',
      action: 'allow',
      tier: 'Yolo',
      unattended: true,
      child: { tier: 'danger-full-access', policy: 'never' },
    },
    { scope: 'delegate', name: 'resume', action: 'allow', tier: '人工批准', resume: true },
  ],
  limits: [
    'No real model calls; #84/#85 remain unproven.',
    'Auto: the real production review request is answered allow by the owned protocol; deny/timeout review fallbacks belong to production Docker protocol tests.',
    'Parent-unavailable read-only takeover of a continuable child is not exercised: the root Session stays alive.',
  ],
};

/** One owned user-image lifecycle per browser case; durable evidence is sanitized. */
async function runBrowserCase(
  issue: string,
  prefix: string,
  suite: PermissionBrowserSuite,
): Promise<void> {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  isolatedBrowserRuntime();
  const artifactRoot = join(process.cwd(), '.run', issue);
  mkdirSync(artifactRoot, { recursive: true });
  const evidenceDirectory = mkdtempSync(join(artifactRoot, prefix));
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
        return runPermissionBrowserScenario(lifecycle, {
          runtime: isolatedBrowserRuntime(lifecycle.runId),
          evidenceDirectory,
          suite,
        });
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
}

it('enforces root and one-shot child reject, allow and cancel through the actual DSH browser UI', () =>
  runBrowserCase('issue83', 'permission-browser-', ONE_SHOT));

it('enforces continuable child reject, allow, cancel, Auto, Yolo and resume through the actual DSH browser UI', () =>
  runBrowserCase('issue391', 'permission-continuable-', CONTINUABLE));

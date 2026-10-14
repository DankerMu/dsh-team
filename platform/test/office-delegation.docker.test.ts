import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { collectComposition, execScript } from './managed-policy-fixture.ts';
import { generateManagedConfig } from '../src/managed-config/index.ts';
import { permissionScenarioScript } from './permission-tiers-fixture.ts';

it('selects genuine native writer children while preserving tiers, cold identity, siblings and lifecycle', async () => {
  const host = readFileSync(new URL('./office-delegation-host.mjs', import.meta.url), 'utf8');
  const evidence = join(process.cwd(), '.run', 'issue213');
  mkdirSync(evidence, { recursive: true });
  await runUserImage(
    'managed-policy',
    (stdout) => {
      expect(JSON.parse(stdout)).toMatchObject({
        passed: true,
        defaults: ['danger-full-access', 'approval', 'auto-review'],
      });
    },
    undefined,
    async (lifecycle) => {
      writeFileSync(join(evidence, 'probe-owner.json'), JSON.stringify({ runId: lifecycle.runId }));
      const composition = await collectComposition(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-office-compose`,
      );
      const overlayFiles = (['yolo', 'approval', 'auto'] as const).map(
        (defaultPermissionTier, index) => {
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
          if (generated.outcome !== 'configured') throw new Error('Missing owned office overlay');
          const path = `/data/home/office-overlay-${String(index)}.json`;
          execScript(
            lifecycle,
            `dsh-team-test-${lifecycle.runId}-office-overlay-${String(index)}`,
            `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(generated.content)});`,
          );
          return path;
        },
      );
      let outcome: { ok: true; value: string } | { ok: false; error: unknown };
      try {
        outcome = {
          ok: true,
          value: execScript(
            lifecycle,
            `dsh-team-test-${lifecycle.runId}-office-native`,
            permissionScenarioScript(host, overlayFiles, ''),
          ),
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        const report = execScript(
          lifecycle,
          `dsh-team-test-${lifecycle.runId}-office-evidence`,
          `import { existsSync, readFileSync } from 'node:fs';
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
process.stdout.write(JSON.stringify([0,1,2].map(index => ({
  result: read('/data/home/office-delegation-evidence-'+index+'.json'),
  failure: read('/data/home/office-delegation-failure-'+index+'.json'),
}))));`,
        );
        writeFileSync(join(evidence, `native-${lifecycle.runId}.json`), report, { mode: 0o600 });
        if (outcome.ok) {
          const rows: unknown = JSON.parse(report);
          expect(rows).toMatchObject(
            ['danger-full-access', 'approval', 'auto-review'].map((tier) => ({
              failure: null,
              result: {
                tier,
                writer: { preset: 'office-writer', permissions: tier },
                coldPreset: 'office-writer',
                resumePreset: 'office-writer',
                unavailable: ['missing', 'broken'],
              },
            })),
          );
          process.stdout.write(
            `Native office delegation verified: run=${lifecycle.runId} evidence=${evidence}\n`,
          );
        }
      } catch (error) {
        if (outcome.ok) throw error;
        process.stderr.write(
          'Office failure evidence persistence failed; original failure retained\n',
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  );
});

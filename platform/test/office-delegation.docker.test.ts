import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import { collectComposition, execScript } from './managed-policy-fixture.ts';
import { generateManagedConfig } from '../src/managed-config/index.ts';
import { permissionScenarioScript } from './permission-tiers-fixture.ts';
import { officeChildReady } from './office-writer-oracle.ts';
import { record } from './container-start-docker-fixture.ts';

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
          if (!Array.isArray(rows)) throw new Error('Missing native readiness observations');
          for (const row of rows) {
            const readiness = record(record(record(row).result).readiness);
            const pending = record(readiness.pending);
            const ready = record(readiness.ready);
            expect(officeChildReady(pending.identity, pending.agentAvailable)).toBe(false);
            expect(officeChildReady(ready.identity, ready.agentAvailable)).toBe(true);
            expect(readiness).toMatchObject({
              pendingPageRejected: true,
              wrongParentRejected: true,
              wrongModeRejected: true,
            });
          }
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

it('distinguishes settled preparation from a returned shell with a surviving writer', async () => {
  const observer = readFileSync(new URL('./office-model-observer.mjs', import.meta.url), 'utf8');
  const script = `
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const { apply } = await import('data:text/javascript;base64,' + Buffer.from(${JSON.stringify(observer)}).toString('base64'));
const control = '/data/home/process-proof-control.json';
const evidence = '/data/home/process-proof-evidence.json';
const document = '/data/home/process-proof-document';
const gate = '/data/home/process-proof-gate';
const ready = '/data/home/process-proof-ready';
const reader = "import {existsSync,readFileSync} from 'node:fs'; const path=" + JSON.stringify(document) +
  "; process.stdout.write(JSON.stringify(existsSync(path)?{status:'present',content:readFileSync(path,'utf8')}:{status:'missing'}));";
const parent = {header:{id:'general'}};
const child = {header:{id:'writer',origin:'subagent',parentSession:'general'}};
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Owned process fixture did not settle');
    await delay(10);
  }
}
async function scenario(background) {
  writeFileSync(control, JSON.stringify({nonce:background?'background':'settled',reader}));
  let emit;
  apply({on(_name, listener) {emit=listener;}}, {control,evidence});
  emit(parent,{type:'user/message',seq:0,data:{source:{kind:'user'}}});
  emit(parent,{type:'tool/call',seq:1,data:{name:'bash',callId:'prepare'}});
  const descendant = "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(ready) +
    ",'ready');const timer=setInterval(()=>{if(fs.existsSync(" + JSON.stringify(gate) +
    ")){fs.writeFileSync(" + JSON.stringify(document) + ",'parent descendant bytes');clearInterval(timer);setInterval(()=>{},1000);}},10);";
  const command = background ? process.execPath + ' -e ' + JSON.stringify(descendant) + ' &' : 'true';
  const result = spawnSync('/bin/sh', ['-c', command], {stdio:'ignore',timeout:5000});
  if (result.status !== 0) throw new Error('Owned parent shell failed');
  if (background) await until(()=>existsSync(ready));
  emit(parent,{type:'tool/result',seq:2,data:{message:{toolCallId:'prepare'}}});
  emit(child,{type:'turn/start',seq:3,data:{}});
  if (background) {
    writeFileSync(gate,'release');
    await until(()=>existsSync(document));
  } else writeFileSync(document,'child bytes');
  emit(child,{type:'turn/end',seq:4,data:{}});
  const proof = JSON.parse(readFileSync(evidence,'utf8'));
  unlinkSync(document);
  return proof;
}
// These controlled event inputs qualify the observer's real process boundary,
// not native Agent behavior; the separate native/model cases prove that layer.
process.stdout.write(JSON.stringify({pid:process.pid,settled:await scenario(false),background:await scenario(true)}));
`;
  await runUserImage(
    'managed-policy',
    () => undefined,
    undefined,
    (lifecycle) => {
      const result: unknown = JSON.parse(
        execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-process-proof`, script),
      );
      expect(result).toMatchObject({
        pid: 1,
        settled: {
          confounded: false,
          before: { status: 'missing' },
          after: { status: 'present', content: 'child bytes' },
        },
        background: {
          confounded: true,
          before: { status: 'missing' },
          after: { status: 'present', content: 'parent descendant bytes' },
        },
      });
      return Promise.resolve(JSON.stringify(result));
    },
  );
});

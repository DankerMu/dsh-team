import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import {
  collectComposition,
  execScript,
  lifecycleWebNetwork,
  migrationOverlayInput,
} from './managed-policy-fixture.ts';
import { webAddress } from './web-startup-fixture.ts';
import { generateManagedConfig } from '../src/managed-config/index.ts';
import { permissionScenarioScript } from './permission-tiers-fixture.ts';
import {
  officeChildReady,
  officeDocxEvidence,
  officeTurnEvidence,
} from './office-writer-oracle.ts';
import { officeDocxReadScript } from './office-docx-fixture.ts';
import { record } from './container-start-docker-fixture.ts';
import type { OfficeOutcome } from './office-delegation-outcome.ts';
import { settleOfficeEvidence } from './office-delegation-outcome.ts';

it('selects genuine native writer children while preserving tiers, cold identity, siblings and lifecycle', async () => {
  const host = readFileSync(new URL('./office-delegation-host.mjs', import.meta.url), 'utf8');
  const construction = readFileSync(
    new URL('./office-construction-native.mjs', import.meta.url),
    'utf8',
  );
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
      execScript(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-construction-controls`,
        `import { writeFileSync } from 'node:fs'; writeFileSync('/data/home/office-construction-native.mjs', ${JSON.stringify(construction)});`,
      );
      // The scenario launches DSH Web itself, one tier after another, at this network's +2.
      const network = lifecycleWebNetwork(lifecycle, 'office');
      const overlayFiles = (['yolo', 'approval', 'auto'] as const).map(
        (defaultPermissionTier, index) => {
          const generated = generateManagedConfig({
            ...migrationOverlayInput(composition),
            admin: false,
            instanceAddress: webAddress(network),
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
      let outcome: OfficeOutcome<string>;
      try {
        outcome = {
          ok: true,
          value: execScript(
            lifecycle,
            `dsh-team-test-${lifecycle.runId}-office-native`,
            permissionScenarioScript(host, overlayFiles, ''),
            network,
          ),
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return settleOfficeEvidence(outcome, () => {
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
          expect(record(rows[0]).result).toMatchObject({
            constructionFailures: {
              rejectedPaths: 7,
              sentinelUnchanged: true,
              outsideAbsent: true,
              cancelledBeforeBody: true,
            },
          });
          for (const row of rows) {
            const readiness = record(record(record(row).result).readiness);
            const created = record(readiness.created);
            const ready = record(readiness.ready);
            expect(officeChildReady(created.identity, created.agentAvailable)).toBe(true);
            expect(officeChildReady(ready.identity, ready.agentAvailable)).toBe(true);
            expect(readiness).toMatchObject({
              createdPageAccepted: true,
              wrongParentRejected: true,
              wrongModeRejected: true,
            });
          }
          process.stdout.write(
            `Native office delegation verified: run=${lifecycle.runId} evidence=${evidence}\n`,
          );
        }
      });
    },
  );
});

it('rejects a native writer that only copies a complete parent-authored notice', async () => {
  const host = readFileSync(new URL('./office-delegation-host.mjs', import.meta.url), 'utf8');
  const observer = readFileSync(new URL('./office-model-observer.mjs', import.meta.url), 'utf8');
  const scenario = readFileSync(
    new URL('./office-delegation-copy-host.mjs', import.meta.url),
    'utf8',
  );
  const evidence = join(process.cwd(), '.run', 'issue217');
  mkdirSync(evidence, { recursive: true });
  await runUserImage(
    'managed-policy',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const composition = await collectComposition(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-copy-compose`,
      );
      const results: { copied: boolean; accepted: boolean }[] = [];
      for (const copied of [false, true]) {
        // Each native instance binds its own owned network's +2 (DSH 0.2.1).
        const network = lifecycleWebNetwork(lifecycle, `copy-${String(copied)}`);
        const generated = generateManagedConfig({
          ...migrationOverlayInput(composition),
          admin: false,
          instanceAddress: webAddress(network),
          defaultPermissionTier: 'yolo',
          modelSettings: {
            baseURL: 'http://127.0.0.1:9/v1',
            apiKeyEnv: 'DSH_TEAM_TEST_KEY',
            apiKeyConfigured: true,
            models: [{ name: 'fixture' }],
            defaultModel: 'fixture',
          },
        });
        if (generated.outcome !== 'configured')
          throw new Error('Missing owned copy-control overlay');
        const marker = `office-copy-${lifecycle.runId}-${String(copied)}`;
        const notice = {
          path: `/data/work/${marker}.docx`,
          title: '关于消防演练的通知',
          addressee: '研发部全体同事',
          matter: `演练编号：${marker}；周五下午在一楼大厅集合`,
          issuer: '行政办公室',
          date: '2026年10月13日',
        };
        const config = { nonce: marker, notice, copied, reader: officeDocxReadScript(notice.path) };
        execScript(
          lifecycle,
          `dsh-team-test-${lifecycle.runId}-copy-setup-${String(copied)}`,
          `
import {writeFileSync} from 'node:fs';
const rows=JSON.parse(${JSON.stringify(generated.content)});
rows.push({id:'session-title-llm',disabled:true},{id:'otel',disabled:true},
  {insert:[{id:'office-copy-fixture',name:'/data/home/office-copy-host.mjs'}]});
writeFileSync('/data/home/office-copy-overlay.json',JSON.stringify(rows));
writeFileSync('/data/home/office-copy-host.mjs',${JSON.stringify(host)});
writeFileSync('/data/home/office-copy-scenario.mjs',${JSON.stringify(scenario)});
writeFileSync('/data/home/office-copy-observer.mjs',${JSON.stringify(observer)});
writeFileSync('/data/home/office-copy-control.json',${JSON.stringify(JSON.stringify(config))});
`,
        );
        const container = `dsh-team-test-${lifecycle.runId}-copy-native-${String(copied)}`;
        lifecycle.registerContainer(container);
        expect(
          lifecycle.command(
            [
              'create',
              '--name',
              container,
              '--label',
              `dsh-team.test-run=${lifecycle.runId}`,
              '--user',
              '1001',
              '--network',
              network.name,
              '--ip',
              webAddress(network),
              '--mount',
              `type=volume,source=${lifecycle.stateVolume},target=/data/home`,
              '--env',
              'DSH_TEAM_TEST_KEY=owned-nonsecret',
              '--env',
              'DSH_TEAM_PERMISSION_INDEX=0',
              '--env',
              `DSH_TEAM_PERMISSION_NONCE=${lifecycle.runId}`,
              '--env',
              'DSH_TEAM_OFFICE_COPY_COUNTER=1',
              lifecycle.imageId,
              'dsh',
              '--profile',
              'web',
              '--patch',
              '/data/home/office-copy-overlay.json',
              '--no-open',
              '--trusted-host',
              'office-copy.test:3080',
            ],
            15000,
          ).status,
        ).toBe(0);
        expect(lifecycle.command(['start', container], 15000).status).toBe(0);
        const trigger = `
import {request} from 'node:http';
const deadline=Date.now()+12000;
await new Promise((resolve,reject)=>{
 const attempt=()=>{
  const req=request({host:'127.0.0.1',port:3081,path:'/run',method:'POST',
    headers:{authorization:'Bearer '+${JSON.stringify(lifecycle.runId)}}},res=>{
    res.resume();res.on('end',()=>res.statusCode===202?resolve():reject(new Error('Copy control refused')));
  });
  req.on('error',error=>{if(error.code==='ECONNREFUSED'&&Date.now()<deadline)setTimeout(attempt,25);else reject(new Error('Copy control unavailable'));});
  req.setTimeout(1000,()=>req.destroy(new Error('Copy control request deadline')));req.end();
 };attempt();
});`;
        expect(
          lifecycle.command(
            ['exec', container, 'node', '--input-type=module', '-e', trigger],
            20000,
          ).status,
        ).toBe(0);
        const stopped = lifecycle.command(['wait', container], 60000);
        const output = execScript(
          lifecycle,
          `dsh-team-test-${lifecycle.runId}-copy-read-${String(copied)}`,
          `
import {existsSync,readFileSync} from 'node:fs';
const file=${JSON.stringify(stopped.stdout.trim() === '0' ? '/data/home/office-copy-report.json' : '/data/home/office-copy-failure.json')};
process.stdout.write(existsSync(file)?readFileSync(file,'utf8'):'{}');`,
        );
        if (stopped.status !== 0 || stopped.stdout.trim() !== '0') {
          writeFileSync(join(evidence, 'native-copy-failure.json'), output);
          throw new Error('Native copy control failed before oracle adjudication');
        }
        const captured: unknown = JSON.parse(output);
        const input = record(captured);
        const contribution = record(record(input.delegation).contribution);
        const artifact = officeDocxEvidence(input.artifact, notice);
        if (copied) {
          expect(contribution).not.toHaveProperty('receipt');
        } else {
          const boundary = officeDocxEvidence(contribution.artifact, notice);
          expect(contribution).toMatchObject({
            nonce: marker,
            receipt: {
              path: notice.path,
              uid: 1001,
              sha256: boundary.sha256,
              bytes: boundary.bytes,
            },
          });
          expect(artifact.sha256).not.toBe(boundary.sha256);
        }
        expect(input.preparedSha256).toBe(copied ? artifact.sha256 : null);
        let accepted = true;
        try {
          // Native controller JSON is untyped; the actual oracle validates every consumed field.
          officeTurnEvidence(captured as Parameters<typeof officeTurnEvidence>[0]);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'office-child-contribution')
            throw error;
          accepted = false;
        }
        results.push({ copied, accepted });
        writeFileSync(join(evidence, 'native-copy-counterexample.json'), JSON.stringify(results));
      }
      expect(results).toEqual([
        { copied: false, accepted: true },
        { copied: true, accepted: false },
      ]);
      return JSON.stringify(results);
    },
  );
});

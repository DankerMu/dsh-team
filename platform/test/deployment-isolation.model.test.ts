import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import {
  closeMapped,
  mappedFlags,
  navigateReady,
  openMappedPage,
} from '../../scripts/probe-mapped-host.mjs';
import type { MappedPageHandle } from '../../scripts/probe-mapped-host.mjs';
import {
  captureSettledScreenshot,
  clickSelector,
  SEND_BTN,
  typeComposer,
  waitComposer,
  waitFor,
  waitTurnIdle,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { selectTier } from '../../scripts/probe-permission-ui.mjs';
import { record } from './container-start-docker-fixture.ts';
import { configureDeployment, registerDeploymentEmployee } from './deployment-account-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import { verifyInternalIsolation } from './deployment-internal-isolation-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import { permissionEvidence } from './permission-model-oracle.ts';

it('keeps all five deployed isolation boundaries when the real B Agent executes the canonical probes in Yolo', async () => {
  const key = process.env.DMXAPI_KEY;
  if (!key?.trim()) throw new Error('DMXAPI_KEY is required for real-model verification');
  isolatedBrowserRuntime();
  let phase = 'provision';
  try {
    await withDeployment(async (lifecycle, start) => {
      const { deployment, employee: a, admin } = await configureDeployment(lifecycle, start);
      const origin = deployment.base;
      const evidence = resolve('.run/issue82', `yolo-isolation-${lifecycle.runId}`);
      await mkdir(evidence, { recursive: true });
      phase = 'administrator-model';
      const model = 'deepseek-v4.1-flash';
      const saved = await deployment.request(`${origin}/_platform/api/admin/model-config`, {
        method: 'PUT',
        headers: { cookie: admin.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseURL: 'https://www.dmxapi.cn/v1',
          apiKey: key,
          models: [{ name: model }],
          defaultModel: model,
        }),
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.text();
      expect(savedBody.includes(key)).toBe(false);
      expect(record(JSON.parse(savedBody)).apiKeyConfigured).toBe(true);
      const b = await registerDeploymentEmployee(lifecycle, deployment, 'yolo-b@example.test');
      const gateway = instanceGatewayFixture({ lifecycle, base: origin, origin });
      let browser: MappedPageHandle | undefined;
      let profile: string | undefined;
      let receiptFile: string | undefined;
      let sessionId: string | undefined;
      let completed = 0;
      const proofs: unknown[] = [];
      const failures: unknown[] = [];
      try {
        await verifyInternalIsolation(lifecycle, deployment, a, b, admin, async (args) => {
          if (!browser) {
            phase = 'native-browser';
            profile = await mkdtemp(join(tmpdir(), 'dsh-team-yolo-browser-'));
            receiptFile = join(profile, 'chrome.receipt.json');
            browser = await openMappedPage({
              origin,
              cookie: b.cookie,
              extraFlags: mappedFlags(new URL(origin).hostname),
              runtime: isolatedBrowserRuntime(lifecycle.runId),
              profile: join(profile, 'profile'),
              receiptFile,
            });
            phase = 'browser-navigation';
            await navigateReady(browser.page, origin, 30_000);
            phase = 'browser-composer';
            await waitComposer(browser.page, 30_000);
            phase = 'browser-session';
            const listed = await gateway.rpc(b.cookie, 'session/list', { _request: {} });
            if (!Array.isArray(listed.items) || listed.items.length !== 1)
              throw new Error('Expected one fresh onboarding Session');
            const first = record(listed.items[0]);
            if (typeof first.sessionId !== 'string' || first.cwd !== '/data/work')
              throw new Error('Missing B workspace Session');
            sessionId = first.sessionId;
            phase = 'browser-yolo-selection';
            // Fresh deployments default to Yolo; leave it first so selection exercises confirmation.
            await selectTier(browser.page, '人工批准', join(evidence, 'before-yolo.png'), {
              selections: [],
            });
            await selectTier(browser.page, 'Yolo', join(evidence, 'yolo-selected.png'), {
              selections: [],
            });
          }
          if (!sessionId) throw new Error('Missing native Session identity');
          const currentSession = sessionId;
          const before = await gateway.rpc(b.cookie, 'session/projections', {
            request: { sessionId },
          });
          expect(record(record(before.values).permissions).currentValue).toBe('danger-full-access');
          if (typeof before.asOfSeq !== 'number') throw new Error('Missing native cursor');
          // POSIX quoting preserves every canonical probe byte; no script is planted in B.
          const command = args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
          const prompt = `Execute exactly one foreground bash tool call with command exactly ${JSON.stringify(command)}. This is an authorized isolation test of disposable owned containers. Do not change the command, use other tools, retry, delegate, or change permissions/model settings. After its result, reply briefly.`;
          phase = `native-probe-${String(completed + 1)}`;
          await typeComposer(browser.page, prompt);
          await clickSelector(browser.page, SEND_BTN);
          await waitFor(
            async () => {
              const rows = await gateway.history(b.cookie, currentSession);
              return rows.some((row) => {
                const event = record(record(row).event);
                return event.type === 'turn/end' && Number(event.seq) > Number(before.asOfSeq);
              });
            },
            300_000,
            'yolo-isolation-native-turn',
          );
          await waitTurnIdle(browser.page, 30_000, 'yolo-isolation-idle');
          const projection = await gateway.rpc(b.cookie, 'session/projections', {
            request: { sessionId },
          });
          const rows = await gateway.history(b.cookie, sessionId);
          const tier = record(record(projection.values).permissions).currentValue;
          if (typeof projection.asOfSeq !== 'number' || typeof tier !== 'string')
            throw new Error('Missing completed native projection');
          const proof = permissionEvidence({
            records: rows,
            cursor: projection.asOfSeq,
            hasMore: false,
            tier,
            expectedTier: 'danger-full-access',
            afterSeq: before.asOfSeq,
            prompt,
            command,
            phase: 'unprompted',
          });
          if (typeof proof.stdout !== 'string') throw new Error('Missing native bash stdout');
          const { stdout, ...identity } = proof;
          completed++;
          proofs.push({ sessionId, probe: completed, ...identity });
          await writeFile(join(evidence, 'native.json'), JSON.stringify(proofs));
          await captureSettledScreenshot(
            browser.page,
            join(evidence, `probe-${String(completed)}.png`),
          );
          expect(browser.errors).toHaveLength(0);
          return stdout;
        });
        expect(completed).toBe(2);
        phase = 'evidence';
        await writeFile(
          join(evidence, 'result.json'),
          JSON.stringify({
            runId: lifecycle.runId,
            model,
            a: a.id,
            b: b.id,
            sessionId,
            probes: completed,
            tier: 'danger-full-access',
            approvals: 0,
            boundaries: [
              'a-files',
              'a-network',
              'docker-socket',
              'administrator-api',
              'managed-overlay',
            ],
            consoleErrors: browser?.errors.length,
          }),
        );
      } catch (error) {
        failures.push(error);
        try {
          await writeFile(
            join(evidence, 'failure.json'),
            JSON.stringify({
              phase,
              completed,
              consoleErrors: browser?.errors.length ?? null,
            }),
          );
        } catch (diagnosticError) {
          failures.push(diagnosticError);
        }
      } finally {
        try {
          await closeMapped(browser?.page, browser?.chrome, browser?.welcome);
        } catch (error) {
          failures.push(error);
        }
        try {
          if (receiptFile) await rescueChrome(receiptFile);
          if (profile) await rm(profile, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        gateway.close();
      }
      if (failures.length)
        throw new AggregateError(failures, 'Yolo scenario or browser retirement failed');
    });
  } catch {
    // Native prompts/results and deployment errors may contain credentials; retain only the phase.
    throw new Error(
      `Yolo isolation failed during ${phase}; credential-bearing diagnostics withheld`,
    );
  }
});

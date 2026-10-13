import { randomUUID } from 'node:crypto';
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
import {
  captureSettledScreenshot,
  clickAllowOnce,
  clickSelector,
  SEND_BTN,
  typeComposer,
  waitComposer,
  waitFor,
  waitTurnIdle,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { record } from './container-start-docker-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import { runPermissionModelScenario } from './permission-model-fixture.mjs';
import { installAutoReviewObserver } from './permission-model-observer-fixture.ts';
import { runOfficeWriterScenario } from './office-writer-model-fixture.mjs';
import { runUserImage } from './user-image-fixture.ts';

it('lets a fresh employee use the administrator model to create exact workspace bytes without personal model settings', async () => {
  const key = process.env.DMXAPI_KEY;
  if (!key?.trim()) throw new Error('DMXAPI_KEY is required for real-model verification');
  isolatedBrowserRuntime();
  let phase = 'provision';
  try {
    await runUserImage(
      'container-start',
      () => undefined,
      undefined,
      async (lifecycle) => {
        const host = 'dsh-team-real-model.invalid';
        const { app, database, base, origin } = await startBrowserPlatform(lifecycle, host);
        const gateway = instanceGatewayFixture({ base, origin, lifecycle });
        const evidence = resolve('.run/issue82', `model-${lifecycle.runId}`);
        let profile: string | undefined;
        let receiptFile: string | undefined;
        let browser: Awaited<ReturnType<typeof openMappedPage>> | undefined;
        try {
          profile = await mkdtemp(join(tmpdir(), 'dsh-team-model-browser-'));
          receiptFile = join(profile, 'chrome.receipt.json');
          phase = 'administrator-configuration';
          await mkdir(evidence, { recursive: true });
          const admin = await registerInstanceUser(base, origin, 'model-admin@example.test');
          database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
          const model = 'deepseek-v4.1-flash';
          const saved = await fetch(`${base}/_platform/api/admin/model-config`, {
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

          // Ordering is intentional: no employee or personal model state exists before admin save.
          phase = 'employee-startup';
          const employee = await registerInstanceUser(base, origin, 'model-employee@example.test');
          const ownership = { 'dsh-team.user': employee.id };
          lifecycle.registerResource('container', `dsh-team-u-${employee.id}`, ownership);
          for (const name of [`dsh-team-home-${employee.id}`, `dsh-team-work-${employee.id}`])
            lifecycle.registerResource('volume', name, ownership);
          expect(await gateway.state(employee.cookie, true)).toEqual({
            status: 'starting',
            reason: 'starting',
          });
          await gateway.ready(employee.cookie);
          const currentContainer = () => {
            const id = record(
              database
                .prepare('SELECT container_id FROM instances WHERE user_id=?')
                .get(employee.id),
            ).container_id;
            if (typeof id !== 'string') throw new Error('Missing model acceptance instance');
            return id;
          };
          let containerId = currentContainer();
          phase = 'auto-observer-setup';
          const reviewObserver = await installAutoReviewObserver((script) =>
            gateway.exec(containerId, script),
          );
          // Complete fixture-only profile installation before any browser attaches.
          const restarted = await fetch(
            `${base}/_platform/api/admin/instances/${employee.id}/restart`,
            {
              method: 'POST',
              headers: { cookie: admin.cookie, origin, 'content-type': 'application/json' },
              body: '{}',
            },
          );
          expect(restarted.status).toBe(200);
          expect(await restarted.json()).toEqual({
            userId: employee.id,
            status: 'starting',
            reason: 'starting',
          });
          await gateway.ready(employee.cookie);
          const replacement = currentContainer();
          expect(replacement).not.toBe(containerId);
          containerId = replacement;
          reviewObserver.observation();
          const marker = `model-proof-${randomUUID()}`;
          const path = `/data/work/${marker}.txt`;
          const expected = `DSH real tool proof ${randomUUID()}`;
          const observeFile = (file: string, contents: string) =>
            record(
              JSON.parse(
                gateway.exec(
                  containerId,
                  `import {existsSync,statSync,readFileSync} from 'node:fs';
const path=${JSON.stringify(file)}, expected=Buffer.from(${JSON.stringify(contents)},'utf8');
const exists=existsSync(path);
const exact=exists && statSync(path).isFile() && statSync(path).size===expected.length && readFileSync(path).equals(Buffer.from(${JSON.stringify(contents)},'utf8'));
process.stdout.write(JSON.stringify({exists,exact}));`,
                ),
              ),
            );
          const observe = (contents: string) => observeFile(path, contents);
          expect(observe(expected)).toEqual({ exists: false, exact: false });
          phase = 'native-browser';
          browser = await openMappedPage({
            origin,
            cookie: employee.cookie,
            extraFlags: mappedFlags(host),
            runtime: isolatedBrowserRuntime(lifecycle.runId),
            profile: join(profile, 'profile'),
            receiptFile,
          });
          const { page } = browser;
          await navigateReady(page, origin, 30_000);
          await waitComposer(page, 30_000);
          await captureSettledScreenshot(page, join(evidence, 'before-task.png'));
          await typeComposer(
            page,
            `Use a real file-writing tool to create ${path} containing exactly ${JSON.stringify(expected)} without a newline. Do not change model settings. Do not only describe the operation. After the tool succeeds, reply OK.`,
          );
          phase = 'real-model-tool';
          await clickSelector(page, SEND_BTN);
          await waitFor(
            async () => {
              await clickAllowOnce(page, marker);
              return observe(expected).exact === true;
            },
            300_000,
            'real-model-workspace-file',
          );
          await waitTurnIdle(page, 60_000, 'real-model-turn-idle');
          expect(observe(expected)).toEqual({ exists: true, exact: true });
          // Qualify the exact-byte oracle without creating a file on behalf of the Agent.
          expect(observe(`${expected}\n`)).toEqual({ exists: true, exact: false });
          expect(browser.errors.length).toBe(0);
          await captureSettledScreenshot(page, join(evidence, 'completed-task.png'));
          phase = 'real-permission-tiers';
          await runPermissionModelScenario({
            page,
            origin,
            cookie: employee.cookie,
            evidence,
            observe: observeFile,
            model,
            reviewObserver,
          });
          phase = 'office-writer-docx';
          await runOfficeWriterScenario({
            page,
            rpc: (method, args) => gateway.rpc(employee.cookie, method, args),
            exec: (script) => gateway.exec(containerId, script),
            evidence,
          });
          phase = 'browser-health';
          await writeFile(
            join(evidence, 'browser-health.json'),
            JSON.stringify({
              count: browser.errors.length,
              classes: browser.errors.map((value) =>
                typeof value === 'string' &&
                [
                  'error',
                  'TypeError',
                  'ReferenceError',
                  'SyntaxError',
                  'net::ERR_ABORTED',
                  'net::ERR_CONNECTION_CLOSED',
                  'net::ERR_CONNECTION_RESET',
                ].includes(value)
                  ? value
                  : 'other',
              ),
            }),
          );
          expect(browser.errors.length).toBe(0);
          phase = 'evidence';
          await writeFile(
            join(evidence, 'result.json'),
            JSON.stringify({
              runId: lifecycle.runId,
              model,
              employeeId: employee.id,
              adminSavedBeforeRegistration: true,
              personalModelConfiguration: false,
              absentBefore: true,
              exactFileAfter: true,
              wrongContentRejected: true,
              consoleErrors: 0,
            }),
          );
          phase = 'cleanup';
          return 'Real model tool wrote exact employee workspace bytes';
        } finally {
          try {
            await closeMapped(browser?.page, browser?.chrome, browser?.welcome);
          } finally {
            try {
              if (receiptFile) await rescueChrome(receiptFile);
              if (profile) await rm(profile, { recursive: true, force: true });
            } finally {
              gateway.close();
              await app.close();
            }
          }
        }
      },
    );
  } catch {
    // Real credentials may appear in dependency/expectation errors; never hand those objects to Vitest.
    throw new Error(
      `Real-model acceptance failed during ${phase}; credential-bearing diagnostics withheld`,
    );
  }
});

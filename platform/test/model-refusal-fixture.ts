import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { generateManagedConfig, writeManagedConfig } from '../src/managed-config/index.ts';
import { captureModelRefusal } from '../../scripts/probe-model-refusal.mjs';
import type { ModelPromptEvidence } from '../../scripts/probe-model-refusal.mjs';
import { mappedFlags, mappedRpc } from '../../scripts/probe-mapped-host.mjs';
import {
  collectComposition,
  execScript,
  MANAGED_BOOT_ROSTER,
  qualifyHostSession,
  waitObservation,
} from './managed-policy-fixture.ts';
import { employeeHomePatch } from './managed-policy-employee-edit.ts';
import { execWebScript, runWebStartup } from './web-startup-fixture.ts';
import type { WebContainer } from './web-startup-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { assertModelRefusal, modelRefusalTurn, remoteRecord } from './model-refusal-oracle.ts';
import type { ModelRefusalObservation } from './model-refusal-oracle.ts';

const HOST = 'dsh-team-managed.invalid';
const KEY_ENV = 'DMXAPI_KEY';
const KEY = 'test-owned-nonsecret';
const LEDGER = '/data/home/model-refusal-ledger.json';
const PLUGIN_DIR = '/data/home/profiles/web/node_modules/@dsh-team';

export function modelRefusalEvidenceRoot(runId: string): string {
  return join(process.cwd(), '.run', 'issue33', `model-refusal-${runId}`);
}

function prepareScript(recorder: string, observer: string): string {
  return `
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { load, dump } = require('js-yaml');
const reserve = async () => {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  await promise;
  return server;
};
const alternate = await reserve();
const refusing = await reserve();
const alternatePort = alternate.address().port;
const refusalPort = refusing.address().port;
const employee = ${JSON.stringify(employeeHomePatch(KEY_ENV, 'ALTERNATE_ADDRESS'))}.replaceAll('ALTERNATE_ADDRESS', 'http://127.0.0.1:' + alternatePort + '/v1');
writeFileSync('/data/home/cordis.patch.yml', employee);
mkdirSync(${JSON.stringify(PLUGIN_DIR)}, { recursive: true });
writeFileSync(${JSON.stringify(`${PLUGIN_DIR}/model-refusal-recorder.js`)}, ${JSON.stringify(recorder)});
writeFileSync(${JSON.stringify(`${PLUGIN_DIR}/managed-policy-observer.js`)}, ${JSON.stringify(observer)});
const patch = '/data/home/profiles/web/cordis.patch.yml';
const rows = load(readFileSync(patch, 'utf8')) ?? [];
if (!Array.isArray(rows)) throw new Error('Invalid profile patch');
rows.push({ insert: [
  { id: 'model-refusal-recorder', name: ${JSON.stringify(`${PLUGIN_DIR}/model-refusal-recorder.js`)}, config: { port: alternatePort, ledger: ${JSON.stringify(LEDGER)} } },
  { id: 'managed-policy-observer', name: ${JSON.stringify(`${PLUGIN_DIR}/managed-policy-observer.js`)} }
] });
writeFileSync(patch, dump(rows, { lineWidth: -1 }));
await Promise.all([alternate, refusing].map(server => {
  const { promise, resolve } = Promise.withResolvers();
  server.close(resolve); return promise;
}));
process.stdout.write(JSON.stringify({ alternatePort, refusalPort, employeeSha256: createHash('sha256').update(readFileSync('/data/home/cordis.patch.yml')).digest('hex') }));
`;
}

function rpcValue(response: unknown): Record<string, unknown> {
  const result = remoteRecord(response);
  if (result.ok !== true || result.status !== 200) throw new Error('Model refusal RPC failed');
  return remoteRecord(result.value);
}

interface RefusalInstance {
  container: WebContainer;
  managedURL: string;
  alternateURL: string;
  employeeSha256: unknown;
}

async function prepareRefusalInstance(
  lifecycle: UserImageLifecycle,
  acquired: Record<string, unknown>,
  persist: () => string,
): Promise<RefusalInstance> {
  const setup = remoteRecord(
    JSON.parse(
      execScript(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-refusal-setup`,
        prepareScript(
          readFileSync(new URL('./model-refusal-recorder.js', import.meta.url), 'utf8'),
          readFileSync(new URL('./managed-policy-observer.js', import.meta.url), 'utf8'),
        ),
      ),
    ),
  );
  for (const key of ['alternatePort', 'refusalPort']) {
    const value = setup[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Invalid owned endpoint port');
  }
  const managedURL = `http://127.0.0.1:${String(setup.refusalPort)}/v1`;
  const alternateURL = `http://127.0.0.1:${String(setup.alternatePort)}/v1`;
  acquired.endpoints = { managedURL, alternateURL, employeeSha256: setup.employeeSha256 };
  persist();
  const composition = await collectComposition(
    lifecycle,
    `dsh-team-test-${lifecycle.runId}-refusal-read`,
  );
  const generated = generateManagedConfig({
    ...composition,
    modelSettings: {
      baseURL: managedURL,
      apiKeyEnv: KEY_ENV,
      apiKeyConfigured: true,
      models: [{ name: 'alpha' }, { name: 'beta' }],
      defaultModel: 'beta',
    },
    defaultPermissionTier: 'yolo',
  });
  if (generated.outcome !== 'configured') throw new Error('Managed refusal configuration missing');
  const overlay = await writeManagedConfig(
    lifecycle.overlayDirectory,
    'modelrefusal',
    generated.content,
  );
  const container: WebContainer = {
    container: `dsh-team-test-${lifecycle.runId}-refusal`,
    imageId: lifecycle.imageId,
    runId: lifecycle.runId,
    stateVolume: lifecycle.stateVolume,
    workVolume: lifecycle.workVolume,
    overlay,
    seccomp: lifecycle.seccomp,
    trustedHost: HOST,
    env: { [KEY_ENV]: KEY },
  };
  lifecycle.registerContainer(container.container);
  return { container, managedURL, alternateURL, employeeSha256: setup.employeeSha256 };
}

async function qualifyRefusalInstance(
  lifecycle: UserImageLifecycle,
  instance: RefusalInstance,
  acquired: Record<string, unknown>,
  persist: () => string,
  remaining: () => number,
): Promise<{ origin: string; cookie: string; workspace: { available: true; workBound: true } }> {
  acquired.phase = 'startup';
  persist();
  const startup = remoteRecord(
    JSON.parse(await runWebStartup(lifecycle.command, instance.container)),
  );
  acquired.startup = startup;
  persist();
  const name = instance.container.container;
  const policy = remoteRecord(await waitObservation(lifecycle.command, name, remaining));
  const models = remoteRecord(policy.models);
  acquired.effective = models;
  persist();
  if (models.intranetAddress !== instance.managedURL || models.defaultModel !== 'beta')
    throw new Error('Effective managed provider mismatch');
  const logs = lifecycle.command(['logs', '--tail', '50', name], remaining());
  if (logs.status !== 0 || logs.error !== undefined)
    throw new Error('Model refusal launch unavailable');
  if (typeof startup.hostPort !== 'number')
    throw new Error('Invalid model refusal host publication');
  const host = await qualifyHostSession(startup.hostPort, logs.stdout);
  const catalog = rpcValue(await mappedRpc(host.origin, host.cookie, 'session/modelCatalog', {}));
  const selected = remoteRecord(catalog.default);
  acquired.catalog = { default: selected, providers: catalog.routableProviders };
  persist();
  if (
    !Array.isArray(catalog.routableProviders) ||
    catalog.routableProviders.length !== 1 ||
    catalog.routableProviders[0] !== 'intranet' ||
    !Array.isArray(catalog.failures) ||
    catalog.failures.length !== 0
  )
    throw new Error('Unexpected effective provider catalog');
  if (selected.provider !== 'intranet' || selected.model !== 'beta')
    throw new Error('Invalid managed default');
  return host;
}

function qualifyRefusalEndpoints(
  lifecycle: UserImageLifecycle,
  instance: RefusalInstance,
  acquired: Record<string, unknown>,
  persist: () => string,
  readLedger: () => Record<string, unknown>,
): void {
  const control = remoteRecord(
    JSON.parse(
      execWebScript(
        lifecycle.command,
        instance.container,
        `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let refusal = false;
try { await fetch(${JSON.stringify(instance.managedURL)}, { signal: AbortSignal.timeout(3000) }); }
catch (error) { refusal = error.cause?.code === 'ECONNREFUSED'; }
const response = await fetch(${JSON.stringify(instance.alternateURL.replace('/v1', '/owned-control'))}, { signal: AbortSignal.timeout(3000) });
await response.arrayBuffer();
const employeeSha256 = createHash('sha256').update(readFileSync('/data/home/cordis.patch.yml')).digest('hex');
process.stdout.write(JSON.stringify({ refusal, controlStatus: response.status, employeeSha256, credentialValid: process.env.${KEY_ENV} === ${JSON.stringify(KEY)} }));`,
      ),
    ),
  );
  acquired.control = control;
  const ledger = readLedger();
  acquired.ledger = ledger;
  persist();
  if (
    control.refusal !== true ||
    control.credentialValid !== true ||
    control.controlStatus !== 204 ||
    ledger.total !== 1 ||
    ledger.inflight !== 0
  )
    throw new Error('Owned endpoint control failed');
  if (control.employeeSha256 !== instance.employeeSha256)
    throw new Error('Persisted employee alternate configuration changed');
}

function requestWorkFinished(observed: ModelRefusalObservation | undefined): boolean {
  if (observed?.turn.terminalSeq == null) return false;
  return (
    !observed.running &&
    observed.recorder.inflight === 0 &&
    observed.accepted &&
    observed.visibleError
  );
}

export async function runModelRefusalScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const reviewedHead = process.env.GITHUB_SHA ?? process.env.DSH_TEAM_REVIEWED_HEAD ?? '';
  if (!/^[0-9a-f]{40}$/.test(reviewedHead))
    throw new Error('Model refusal evidence requires reviewed head');
  const root = modelRefusalEvidenceRoot(lifecycle.runId);
  mkdirSync(root, { recursive: true });
  const screenshot = join(root, 'session-error.png');
  const acquired: Record<string, unknown> = {
    runId: lifecycle.runId,
    imageId: lifecycle.imageId,
    reviewedHead,
    screenshot,
  };
  const persist = (): string => {
    const summary = JSON.stringify(acquired);
    writeFileSync(join(root, 'observations.json'), summary);
    return summary;
  };
  persist();
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-model-refusal-'));
  const started = performance.now();
  // One scenario deadline bounds preparation, startup, prompt and terminal observation.
  const remaining = (): number => {
    const left = 180_000 - (performance.now() - started);
    if (left <= 0) throw new Error('Model refusal scenario deadline exceeded');
    return Math.floor(left);
  };
  let container: WebContainer | undefined;
  let baseline = 0;
  let controlStatus = 0;
  let final: ModelRefusalObservation | undefined;
  const readLedger = (): Record<string, unknown> => {
    if (container === undefined) throw new Error('Model refusal container missing');
    return remoteRecord(
      JSON.parse(
        execWebScript(
          lifecycle.command,
          container,
          `import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(LEDGER)}, 'utf8'));`,
        ),
      ),
    );
  };
  try {
    const chromeBin = process.env.CHROME_BIN;
    if (!chromeBin) throw new Error('CHROME_BIN is required for model refusal verification');
    acquired.phase = 'prepare';
    persist();
    const instance = await prepareRefusalInstance(lifecycle, acquired, persist);
    container = instance.container;
    const { origin, cookie, workspace } = await qualifyRefusalInstance(
      lifecycle,
      instance,
      acquired,
      persist,
      remaining,
    );
    const sample = async (prompt: ModelPromptEvidence): Promise<boolean> => {
      acquired.prompt = prompt;
      persist();
      if (prompt.sessionId && prompt.requestId) {
        const projection = rpcValue(
          await mappedRpc(origin, cookie, 'session/projections', {
            request: { sessionId: prompt.sessionId },
          }),
        );
        const page = rpcValue(
          await mappedRpc(origin, cookie, 'session/page', {
            request: {
              address: { kind: 'session', sessionId: prompt.sessionId },
              throughSeq: projection.asOfSeq,
              maxMessages: 10,
            },
          }),
        );
        if (!Array.isArray(page.records) || page.hasMore !== false)
          throw new Error('Incomplete owned Session history');
        const turn = modelRefusalTurn(page.records, prompt.requestId);
        const values = remoteRecord(projection.values);
        const used = remoteRecord(remoteRecord(values.modelSelection).lastUsed ?? {});
        const inbox = remoteRecord(values.inbox);
        const list = rpcValue(await mappedRpc(origin, cookie, 'session/list', { _request: {} }));
        if (!Array.isArray(list.items)) throw new Error('Invalid Session status');
        const session = list.items
          .map(remoteRecord)
          .find((row) => row.sessionId === prompt.sessionId);
        const empty = ['next-turn', 'next-step'].every(
          (key) => Array.isArray(inbox[key]) && inbox[key].length === 0,
        );
        const ledger = readLedger();
        final = {
          accepted: prompt.accepted,
          promptCount: prompt.promptCount,
          sessionId: prompt.sessionId,
          requestId: prompt.requestId,
          turn,
          running: session?.running !== false || !empty,
          usedProvider: typeof used.provider === 'string' ? used.provider : '',
          usedModel: typeof used.model === 'string' ? used.model : '',
          visibleError: prompt.visibleError,
          recorder: {
            baseline,
            total: Number(ledger.total),
            inflight: Number(ledger.inflight),
            overflow: ledger.overflow !== false,
            controlStatus,
          },
        };
        acquired.observation = final;
        acquired.ledger = ledger;
      }
      persist();
      remaining();
      return requestWorkFinished(final);
    };
    acquired.phase = 'prompt';
    persist();
    await captureModelRefusal({
      origin,
      cookie,
      workspace,
      extraFlags: mappedFlags(HOST),
      expectedHost: HOST,
      expectedRoster: MANAGED_BOOT_ROSTER,
      chromeBin,
      profile: work,
      pidFile: join(work, 'chrome.pid'),
      screenshot,
      browserMs: remaining(),
      beforeSubmit: () => {
        qualifyRefusalEndpoints(lifecycle, instance, acquired, persist, readLedger);
        baseline = 1;
        controlStatus = 204;
        acquired.baseline = baseline;
        persist();
        remaining();
      },
      observe: sample,
      retain: async (prompt, screenshotCaptured) => {
        acquired.prompt = prompt;
        acquired.screenshotCaptured = screenshotCaptured;
        persist();
        await sample(prompt);
      },
    });
    acquired.phase = 'terminal';
    persist();
    if (final === undefined) throw new Error('No accepted model refusal observation');
    assertModelRefusal(final);
    acquired.accepted = true;
    return persist();
  } catch (error) {
    if (container !== undefined) {
      try {
        acquired.ledger = readLedger();
      } catch {
        acquired.ledgerReadFailed = true;
      }
    }
    acquired.failed = true;
    persist();
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { readPrivateJsonFile } from '../../scripts/docker-proxy-environment.mjs';
import { SEED_DATASETS, readSeedDatasets } from '../../scripts/seed-stack.mjs';
import {
  STACK_CONFIG_RELATIVE_PATH,
  configuredStack,
} from '../../scripts/test-stack-prerequisites.mjs';
import {
  prepareDeploymentAccounts,
  registerDeploymentEmployee,
} from './deployment-account-fixture.ts';
import {
  buildPlatformImage,
  platformImageId,
  pollHealth,
  writeComposeConfiguration,
  writeModelProviderOverride,
} from './deployment-compose-fixture.ts';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  acquireDeploymentLock,
  drainDeploymentPlatform,
  output,
  OWNER_LABEL,
} from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import {
  notConfiguredPanel,
  panelNeedles,
  restoredPanel,
  unavailablePanel,
} from './knowledge-panel-stack-fixture.ts';
import type { PanelSessionEvidence } from './knowledge-panel-stack-fixture.ts';
import { awaitLocalModelReady, privatePlatformRead } from './local-model-readiness.ts';
import {
  comparableRagflowStack,
  configureRagflow,
  duringRagflowOutage,
  instanceProxy,
  proxyAfterRestore,
  proxyWhileDown,
  ragflowOutage,
  ragflowStackSnapshot,
} from './ragflow-stack-fixture.ts';
import { converseInWorkbench, until } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

type Stack = NonNullable<ReturnType<typeof configuredStack>>;
const PLATFORM = 'dsh-team-platform';

/** The RAGFlow origin and key come only from the private file; nothing here may print them. */
function privateStack(): Stack {
  let config: Parameters<typeof configuredStack>[0];
  try {
    config = readPrivateJsonFile(
      join(homedir(), STACK_CONFIG_RELATIVE_PATH),
      process.getuid?.() ?? -1,
    );
  } catch {
    config = 'invalid';
  }
  const stack = configuredStack(config);
  if (stack === undefined) throw new Error('Private stack configuration unavailable');
  return stack;
}

/** Read-only GETs; an unreadable or incomplete seed fails the case and is never seeded here. */
async function seedSnapshot(stack: Stack) {
  try {
    return await readSeedDatasets(stack);
  } catch (error) {
    // SeedFailure lines name only datasets and files.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    throw new Error(`Seeded RAGFlow data unreadable; run pnpm seed:stack first (${reason})`, {
      cause: error,
    });
  }
}

/** Docker Desktop's socket group, observed through the same source/target bind compose uses. */
async function socketGroup(run: DockerOutput, lifecycle: UserImageLifecycle, image: string) {
  const probe = `dsh-team-test-${lifecycle.runId}-socket-probe`;
  const gid = await run([
    'run',
    '--rm',
    '--name',
    probe,
    '--label',
    `${OWNER_LABEL}=${lifecycle.runId}`,
    '--network',
    'none',
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--entrypoint',
    'stat',
    image,
    '-c',
    '%g',
    '/var/run/docker.sock',
  ]);
  if (!/^\d+\r?\n?$/.test(gid)) throw new Error('Docker socket group probe malformed');
  return Number(gid.trim());
}

interface Timings {
  userImageBuildMs?: number;
  platformImageBuildMs?: number;
}

type RagflowStack = Awaited<ReturnType<typeof ragflowStackSnapshot>>;

/** The 「知识库」 panel's three observed sessions, kept apart from the conversation's. */
interface PanelEvidence {
  notConfigured: PanelSessionEvidence;
  unavailable?: PanelSessionEvidence;
  restored?: PanelSessionEvidence;
}

interface ConversationEvidence {
  browser?: StackBrowserEvidence;
  panel?: PanelEvidence;
  provider?: Record<string, unknown>;
  proxy?: Awaited<ReturnType<typeof proxyWhileDown>> &
    Awaited<ReturnType<typeof proxyAfterRestore>>;
  ragflow?: { before: RagflowStack; after: RagflowStack };
}

/** The private RAGFlow test stack and its seed snapshot taken before any Docker work. */
interface RagflowContext {
  stack: Stack;
  seed: Awaited<ReturnType<typeof seedSnapshot>>;
}

/** The owned deterministic provider's script for one run; every value is a nonsecret nonce. */
function ownedModel(runId: string) {
  const name = 'owned-stack-model';
  return {
    name,
    provider: {
      key: randomUUID(),
      model: name,
      marker: `stack-marker-${randomUUID()}`,
      reply: `stack-reply-${randomUUID()}`,
      script: { path: `/data/work/stack-${runId}.txt`, content: `stack-content-${randomUUID()}\n` },
    },
  };
}

const PASSWORD = 'instance-acceptance-password';

/** Starts one employee's instance through the platform API and waits until it is running. */
async function startInstance(lifecycle: UserImageLifecycle, base: string, cookie: string) {
  const gateway = instanceGatewayFixture({ lifecycle, base, origin: base });
  try {
    await gateway.state(cookie, true);
    // Bounds only the poll: the platform's own 60s limits decide whether the start succeeds.
    await gateway.ready(cookie, 180_000);
  } finally {
    gateway.close();
  }
}

/** One employee's panel browser session; screenshots share the run's report directory. */
function panelSession(lifecycle: UserImageLifecycle, base: string, email: string): StackSession {
  const directory = join(lifecycle.repositoryRoot, 'reports/stack', lifecycle.runId);
  return { base, directory, email, password: PASSWORD, timeout: 60_000 };
}

/**
 * Before RAGFlow is configured, a second employee's panel shows 「知识库未配置」. Its browser has
 * closed before the administrator disables the account (disabling drops the user's WebSockets);
 * 204 arrives only after the instance is retired, so the running counts later stay unchanged.
 */
async function unconfiguredEmployeePanel(
  lifecycle: UserImageLifecycle,
  administrator: { base: string; cookie: string },
  stack: Stack,
): Promise<PanelSessionEvidence> {
  const { base } = administrator;
  const second = await registerDeploymentEmployee(
    lifecycle,
    { base, request: fetch },
    'knowledge@deployment.example.test',
  );
  await startInstance(lifecycle, base, second.cookie);
  const needles = await panelNeedles(lifecycle.commandAsync, second.id, stack);
  const panel = await notConfiguredPanel(panelSession(lifecycle, base, second.email), needles);
  const disabled = await fetch(`${base}/_platform/api/admin/users/${second.id}/status`, {
    method: 'PUT',
    headers: { origin: base, cookie: administrator.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
  await disabled.arrayBuffer();
  expect(disabled.status).toBe(204);
  return panel;
}

const PROVIDER_HEALTH =
  "const r=await fetch('http://127.0.0.1:3099/health');process.stdout.write(await r.text());";

/**
 * Real gateway, real model-config and real DSH: one employee message through Chromium makes the
 * owned provider script a `write` call, then the reply; the file and counters are read back.
 * Login, instance start and the conversation run while RAGFlow is really stopped; the proxy is
 * then called from inside the instance during the outage and again after RAGFlow is back.
 */
async function converse(
  lifecycle: UserImageLifecycle,
  run: DockerOutput,
  target: { base: string; directory: string; dataDir: string; compose: string[] },
  model: ReturnType<typeof ownedModel>,
  context: { evidence: ConversationEvidence; ragflow: RagflowContext },
): Promise<void> {
  const { evidence, ragflow } = context;
  const { base } = target;
  const { provider } = model;
  const platformRead = (script: string) =>
    privatePlatformRead(async (args) => ({ stdout: await run(args) }), script);
  await run([
    'exec',
    '--detach',
    PLATFORM,
    'node',
    '/verification/model.ts',
    '/verification/model.json',
  ]);
  await awaitLocalModelReady(platformRead);
  const { employee, admin } = await prepareDeploymentAccounts(
    lifecycle,
    { ...target, request: fetch },
    {
      settings: {
        baseURL: `http://${PLATFORM}:3099/v1`,
        models: [{ name: model.name }],
        defaultModel: model.name,
      },
      apiKey: provider.key,
    },
  );
  const administrator = { base, cookie: admin.cookie };
  const panel: PanelEvidence = {
    notConfigured: await unconfiguredEmployeePanel(lifecycle, administrator, ragflow.stack),
  };
  evidence.panel = panel;
  const baseURL = await configureRagflow(administrator, ragflow.stack);
  const outage = ragflowOutage(run, ragflow.stack, ragflow.seed);
  await duringRagflowOutage(outage, async () => {
    await workbenchTurn(lifecycle, run, { base, employee, model, evidence });
    const call = await instanceProxy(lifecycle.commandAsync, employee.id);
    const down = await proxyWhileDown(administrator, baseURL, call);
    // The saved RAGFlow address, its key, the instance token and the platform address reach no
    // page resource of the panel sessions; the values stay in memory.
    const needles = await panelNeedles(lifecycle.commandAsync, employee.id, ragflow.stack);
    // Compared as a boolean so a failure prints neither value.
    expect(needles.ragflowBaseUrl === baseURL).toBe(true);
    const session = panelSession(lifecycle, base, employee.email);
    panel.unavailable = await unavailablePanel(session, needles);
    evidence.proxy = { ...down, ...(await proxyAfterRestore(administrator, outage, call)) };
    // Browsing ignores the retrieval threshold proxyAfterRestore has just saved.
    panel.restored = await restoredPanel(session, needles);
  });
}

/** The existing gateway admission and workbench conversation for one registered employee. */
async function workbenchTurn(
  lifecycle: UserImageLifecycle,
  run: DockerOutput,
  turn: {
    base: string;
    employee: { id: string; email: string; cookie: string };
    model: ReturnType<typeof ownedModel>;
    evidence: ConversationEvidence;
  },
): Promise<void> {
  const { base, employee, evidence } = turn;
  const { provider } = turn.model;
  const platformRead = (script: string) =>
    privatePlatformRead(async (args) => ({ stdout: await run(args) }), script);
  const timeout = 120_000;
  await startInstance(lifecycle, base, employee.cookie);
  evidence.browser = await converseInWorkbench({
    base,
    directory: join(lifecycle.repositoryRoot, 'reports/stack', lifecycle.runId),
    email: employee.email,
    password: PASSWORD,
    message: `${provider.marker} 请按脚本写入文件`,
    reply: provider.reply,
    timeout,
    // Tool-call round, tool-result round and the title request: the write has landed by then.
    turnComplete: () =>
      until(
        async () => {
          const { requests, toolResults } = await platformRead(PROVIDER_HEALTH);
          return Number(toolResults) >= 1 && Number(requests) >= 3;
        },
        timeout,
        'provider turn',
      ),
  });
  const read = ['exec', '--user', '1001', `dsh-team-u-${employee.id}`, 'cat', provider.script.path];
  expect(await run(read)).toBe(provider.script.content);
  evidence.provider = await platformRead(PROVIDER_HEALTH);
}

async function composeScenario(
  lifecycle: UserImageLifecycle,
  timings: Timings,
  context: { evidence: ConversationEvidence; ragflow: RagflowContext },
): Promise<string> {
  const { evidence } = context;
  const { runId } = lifecycle;
  const run: DockerOutput = async (args, timeout = 30_000) =>
    output(await lifecycle.commandAsync(args, timeout), args);
  const ownership = { [OWNER_LABEL]: runId };
  const image = `dsh-team-test-${runId}:platform`;
  const project = `dsh-team-test-${runId}`;
  const network = `${project}_default`;
  // Compose binds source and target identically: Docker Desktop needs the resolved host path.
  // The lifecycle's private directory outlives this case: `finish()` removes it only after the
  // exact-owned retirement, so an undrained platform never loses its bind sources while alive.
  const directory = realpathSync(dirname(lifecycle.overlayDirectory));
  let submitted = false;
  let ragflowBefore: RagflowStack | undefined;
  const failures: unknown[] = [];
  try {
    ragflowBefore = await ragflowStackSnapshot(run);
    const existing = await lifecycle.commandAsync(['container', 'inspect', PLATFORM], 30_000);
    if (!isAbsentResource(existing, 'container', PLATFORM))
      throw new Error(
        'Platform container already exists or absence is unproven; refusing deployment',
      );
    for (const [kind, name] of [
      ['image', image],
      ['container', `dsh-team-test-${runId}-socket-probe`],
      ['container', PLATFORM],
      ['network', network],
    ] as const)
      await lifecycle.registerResourceAsync(kind, name, ownership);
    const started = performance.now();
    await buildPlatformImage(run, runId, image);
    timings.platformImageBuildMs = Math.round(performance.now() - started);
    const imageId = await platformImageId(run, image);
    const dockerGid = await socketGroup(run, lifecycle, imageId);
    const dataDir = join(directory, 'platform-data');
    const managedDir = join(directory, 'managed');
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(managedDir, { mode: 0o700 });
    const model = ownedModel(runId);
    // A running platform cannot gain bind mounts: the provider joins before `compose up`.
    const provider = await writeModelProviderOverride(
      lifecycle.repositoryRoot,
      directory,
      model.provider,
    );
    const { base, compose } = await writeComposeConfiguration({
      repositoryRoot: lifecycle.repositoryRoot,
      directory,
      dataDir,
      managedDir,
      port: await unusedPort(),
      userImage: lifecycle.imageId,
      platformImage: imageId,
      dockerGid,
      runId,
      project,
      network,
      overrides: [provider],
    });
    submitted = true;
    await run([...compose, 'up', '-d', '--no-build', '--pull', 'never'], 120_000);
    await pollHealth(fetch, base, 60_000);
    await converse(lifecycle, run, { base, directory, dataDir, compose }, model, context);
  } catch (error) {
    failures.push(error);
  }
  // Drain this run's verified platform by exact-ID SIGTERM before exact-owned removal.
  if (submitted) {
    try {
      await drainDeploymentPlatform(lifecycle.commandAsync, runId);
    } catch (error) {
      failures.push(error);
    }
  }
  // Read-only: the stack's state after this case's own stop/start has settled.
  if (ragflowBefore !== undefined) {
    try {
      evidence.ragflow = { before: ragflowBefore, after: await ragflowStackSnapshot(run) };
    } catch (error) {
      failures.push(error);
    }
  }
  // The original failure stays first; drainage and inspection failures follow it.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Local stack deployment and drainage failed');
  return 'verified';
}

it('builds both images, starts the delivered compose platform, converses through the real workbench and reads the seeded stack', async () => {
  const stack = privateStack();
  const before = await seedSnapshot(stack);
  expect(before).toEqual(
    SEED_DATASETS.map(({ name, files }) => ({
      name,
      files: files.map((file) => ({ name: file, status: 'COMPLETED' })),
    })),
  );
  const timings: Timings = {};
  const evidence: ConversationEvidence = {};
  // Held from before fixed-name admission through exact-owned teardown.
  const release = await acquireDeploymentLock();
  try {
    const started = performance.now();
    await runUserImage(
      'container-start',
      () => undefined,
      undefined,
      (lifecycle) => {
        timings.userImageBuildMs = Math.round(performance.now() - started);
        return composeScenario(lifecycle, timings, {
          evidence,
          ragflow: { stack, seed: before },
        });
      },
    );
  } finally {
    await release();
  }
  expect(await seedSnapshot(stack)).toEqual(before);
  const { browser, provider, proxy, ragflow, panel } = evidence;
  if (browser === undefined || provider === undefined || proxy === undefined)
    throw new Error('Conversation evidence missing');
  if (panel?.unavailable === undefined || panel.restored === undefined)
    throw new Error('Knowledge panel evidence missing');
  if (ragflow === undefined) throw new Error('RAGFlow test stack evidence missing');
  // IDs, states and volumes unchanged; only ragflow-cpu's StartedAt and RestartCount may move
  // (`docker start` resets the latter).
  expect(comparableRagflowStack(ragflow.after)).toEqual(comparableRagflowStack(ragflow.before));
  expect(ragflow.after.service('ragflow-cpu').state).toBe('running');
  expect(browser.screenshots).toEqual(['login.png', 'workbench.png', 'reply.png']);
  expect({
    consoleErrors: browser.consoleErrors,
    pageErrors: browser.pageErrors,
    failedRequests: browser.failedRequests,
    externalRequests: browser.externalRequests,
  }).toEqual({ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] });
  expect(browser.requests).toBeGreaterThan(0);
  expect(browser.websockets).toBeGreaterThan(0);
  // Tool-call round, tool-result round and the title request, all marked by the message.
  expect(provider).toMatchObject({ ready: true });
  expect(provider.requests).toBeGreaterThanOrEqual(3);
  expect(provider.toolResults).toBeGreaterThanOrEqual(1);
  expect(provider.markedRequests).toBeGreaterThanOrEqual(3);
  const sessions = [panel.notConfigured, panel.unavailable, panel.restored];
  for (const session of sessions)
    expect({
      consoleErrors: session.browser.consoleErrors,
      pageErrors: session.browser.pageErrors,
      failedRequests: session.browser.failedRequests,
      externalRequests: session.browser.externalRequests,
    }).toEqual({ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] });
  const panelSteps = sessions.flatMap(({ steps }) => steps);
  expect(panelSteps.map(({ step, state, screenshot }) => [step, state, screenshot])).toEqual([
    ['not-configured', 'not-configured', 'kb-not-configured.png'],
    ['unavailable', 'failed', 'kb-unavailable.png'],
    ['datasets', 'list', 'kb-datasets.png'],
    ['files', 'list', 'kb-files.png'],
    ['filter', 'list', 'kb-filter.png'],
    ['no-match', 'no-match', 'kb-no-match.png'],
  ]);
  expect(panelSteps.map(({ files }) => files)).toEqual([0, 0, 0, 2, 1, 0]);
  const panelScreenshots = sessions.flatMap(({ browser: observed }) => observed.screenshots);
  expect(panelScreenshots).toEqual(panelSteps.map(({ screenshot }) => screenshot));
  process.stdout.write(
    `${JSON.stringify({
      stackEvidence: {
        ...timings,
        datasets: 3,
        files: 6,
        screenshots: browser.screenshots,
        browserRequests: browser.requests,
        websockets: browser.websockets,
        consoleErrors: browser.consoleErrors.length,
        externalRequests: browser.externalRequests.length,
        provider: {
          requests: provider.requests,
          toolResults: provider.toolResults,
          markedRequests: provider.markedRequests,
        },
        proxy,
        panel: { steps: panelSteps, screenshots: panelScreenshots },
      },
    })}\n`,
  );
});

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readPrivateJsonFile } from '../../scripts/docker-proxy-environment.mjs';
import { SEED_DATASETS, readSeedDatasetIds, readSeedDatasets } from '../../scripts/seed-stack.mjs';
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
  containerDocument,
  drainDeploymentPlatform,
  output,
  OWNER_LABEL,
  record,
} from './docker-cleanup.ts';
import { createDockerCommands, isAbsentResource } from './docker-command.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import { instanceGatewayFixture } from './instance-gateway-docker-fixture.ts';
import {
  notConfiguredPanel,
  panelNeedles,
  restoredPanel,
  unavailablePanel,
} from './knowledge-panel-stack-fixture.ts';
import type { PanelSessionEvidence } from './knowledge-panel-stack-fixture.ts';
import { scopeScenario } from './knowledge-scope-stack-fixture.ts';
import type { ScopeEvidence } from './knowledge-scope-stack-fixture.ts';
import { searchScenario } from './knowledge-search-stack-fixture.ts';
import type { SearchEvidence } from './knowledge-search-stack-fixture.ts';
import { awaitLocalModelReady, privatePlatformRead } from './local-model-readiness.ts';
import { mappedSessionRpc } from './owned-completion-fixture.ts';
import {
  comparableRagflowStack,
  configureRagflow,
  duringRagflowOutage,
  instanceProxy,
  MISSING_ID,
  POLICIES,
  proxyAfterRestore,
  proxyWhileDown,
  ragflowOutage,
  ragflowStackSnapshot,
  restoreRetrievalDefaults,
  SEARCH_QUESTION,
} from './ragflow-stack-fixture.ts';
import { converseInWorkbench, until } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

type Stack = NonNullable<ReturnType<typeof configuredStack>>;
const PLATFORM = 'dsh-team-platform';
const DOCUMENT_SERVER = 'dsh-team-documentserver';
const FIXED_CONTAINERS = [
  [PLATFORM, 'Platform'],
  [DOCUMENT_SERVER, 'Document Server'],
] as const;

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
async function seedRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    // SeedFailure lines name only datasets and files.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    throw new Error(`Seeded RAGFlow data unreadable; run pnpm seed:stack first (${reason})`, {
      cause: error,
    });
  }
}
const seedSnapshot = (stack: Stack) => seedRead(() => readSeedDatasets(stack));

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
  scope?: ScopeEvidence & { forbiddenRequests: unknown };
  search?: SearchEvidence & { provider: Record<string, unknown> };
  /** The delivered Document Server's anonymous volumes, checked absent after retirement. */
  documentServerVolumes?: readonly string[];
}

/**
 * The delivered Document Server runs the real image without a host publication; only started,
 * never awaited or contacted. Returns its anonymous (image `VOLUME`) volume names.
 */
async function documentServerVolumes(lifecycle: UserImageLifecycle): Promise<string[]> {
  const server = containerDocument(
    await lifecycle.commandAsync(['container', 'inspect', DOCUMENT_SERVER], 30_000),
  );
  expect(record(server.State).Running).toBe(true);
  expect(record(server.Config).Image).toBe('onlyoffice/documentserver:9.4.0');
  expect(record(record(server.HostConfig).PortBindings ?? {})).toEqual({});
  // The image's EXPOSE 80/443 leave null entries, which are not published host ports.
  for (const binding of Object.values(record(record(server.NetworkSettings).Ports ?? {})))
    expect(binding, 'Document Server effective publication').toBeNull();
  const mounts: unknown = server.Mounts;
  if (!Array.isArray(mounts)) throw new Error('Document Server mounts unavailable');
  return (mounts as unknown[])
    .map((mount) => record(mount))
    .filter((mount) => mount.Type === 'volume')
    .map(({ Name }) => {
      if (typeof Name !== 'string' || Name === '') throw new Error('Anonymous volume unnamed');
      return Name;
    });
}

/** After the lifecycle's own exact retirement, `--volumes` must have taken each one with it. */
async function expectVolumesRetired(volumes: readonly string[]): Promise<void> {
  const config = await mkdtemp(join(tmpdir(), 'dsh-team-test-docker-'));
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const { command } = createDockerCommands(root, config, true);
    for (const volume of volumes)
      expect(
        isAbsentResource(command(['volume', 'inspect', volume], 30_000), 'volume', volume),
        'Document Server anonymous volume retired',
      ).toBe(true);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}

/** The private RAGFlow test stack and its seed snapshot taken before any Docker work. */
interface RagflowContext {
  stack: Stack;
  seed: Awaited<ReturnType<typeof seedSnapshot>>;
  /** The seed dataset IDs in seed order; not secret. */
  seedIds: readonly { name: string; id: string }[];
}

/**
 * The owned deterministic provider's script for one run; every value is a nonsecret nonce. The
 * scope lane holds its first marked turn and counts requests carrying any `forbidden` string: the
 * command name, its summary text and the seed dataset IDs must never reach the model. The search
 * lane's marked turn makes the general office Agent delegate and the writer child search.
 */
function ownedModel(runId: string, seedIds: readonly { id: string }[]) {
  const name = 'owned-stack-model';
  return {
    name,
    provider: {
      key: randomUUID(),
      model: name,
      marker: `stack-marker-${randomUUID()}`,
      reply: `stack-reply-${randomUUID()}`,
      script: { path: `/data/work/stack-${runId}.txt`, content: `stack-content-${randomUUID()}\n` },
      hold: `stack-hold-${randomUUID()}`,
      forbidden: ['kb-scope', '知识库范围', ...seedIds.map(({ id }) => id)],
      delegation: { childMarker: `stack-child-${randomUUID()}`, question: SEARCH_QUESTION },
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
const PROVIDER_RELEASE =
  "const r=await fetch('http://127.0.0.1:3099/release',{method:'POST'});process.stdout.write(await r.text());";

/** The administrator restart of one employee's instance, awaited until it runs again. */
async function restartInstance(
  lifecycle: UserImageLifecycle,
  administrator: { base: string; cookie: string },
  employee: { id: string; cookie: string },
) {
  const { base } = administrator;
  const restarted = await fetch(`${base}/_platform/api/admin/instances/${employee.id}/restart`, {
    method: 'POST',
    headers: { origin: base, cookie: administrator.cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  expect({ status: restarted.status, body: await restarted.json() }).toEqual({
    status: 200,
    body: { userId: employee.id, status: 'starting', reason: 'starting' },
  });
  const gateway = instanceGatewayFixture({ lifecycle, base, origin: base });
  try {
    await gateway.ready(employee.cookie, 180_000);
  } finally {
    gateway.close();
  }
}

/**
 * The composer scope lane after the panel: the owned provider holds one turn so the scope can
 * change while it runs; nothing of the scope may reach the model.
 */
async function scopeLane(
  lifecycle: UserImageLifecycle,
  platformRead: (script: string) => Promise<Record<string, unknown>>,
  lane: {
    administrator: { base: string; cookie: string };
    employee: { id: string; email: string; cookie: string };
    model: ReturnType<typeof ownedModel>;
    ragflow: RagflowContext;
  },
): Promise<NonNullable<ConversationEvidence['scope']>> {
  const { administrator, employee, ragflow } = lane;
  const { base } = administrator;
  const [first, second] = ragflow.seedIds;
  if (first === undefined || second === undefined) throw new Error('Seed dataset IDs missing');
  const scope = await scopeScenario({
    session: panelSession(lifecycle, base, employee.email),
    rpc: mappedSessionRpc(base, employee.cookie),
    seeds: { first: first.id, second: second.id, firstName: first.name },
    hold: {
      nonce: lane.model.provider.hold,
      held: async () => Number((await platformRead(PROVIDER_HEALTH)).held),
      release: async () => {
        expect((await platformRead(PROVIDER_RELEASE)).released).toBe(1);
      },
    },
    needles: () => panelNeedles(lifecycle.commandAsync, employee.id, ragflow.stack),
    restart: () => restartInstance(lifecycle, administrator, employee),
  });
  const { forbiddenRequests } = await platformRead(PROVIDER_HEALTH);
  expect(forbiddenRequests).toBe(0);
  return { ...scope, forbiddenRequests };
}

/**
 * The retrieval lane after the scope lane, same employee: the retrieval defaults come back first
 * (proxyAfterRestore saved threshold 1), then the delegated child searches the root's two-ID scope.
 * The provider saw no scope text or dataset ID, one delegation and one search.
 */
async function searchLane(
  lifecycle: UserImageLifecycle,
  platformRead: (script: string) => Promise<Record<string, unknown>>,
  lane: {
    administrator: { base: string; cookie: string };
    employee: { id: string; email: string; cookie: string };
    model: ReturnType<typeof ownedModel>;
    ragflow: RagflowContext;
  },
): Promise<NonNullable<ConversationEvidence['search']>> {
  const { administrator, employee, ragflow } = lane;
  await restoreRetrievalDefaults(administrator);
  const policies = ragflow.seedIds.find(({ name }) => name === POLICIES);
  if (policies === undefined) throw new Error('Seed policies dataset ID missing');
  const search = await searchScenario({
    session: panelSession(lifecycle, administrator.base, employee.email),
    rpc: mappedSessionRpc(administrator.base, employee.cookie),
    policies,
    missingId: MISSING_ID,
    ids: [...ragflow.seedIds.map(({ id }) => id), MISSING_ID],
    childMarker: lane.model.provider.delegation.childMarker,
    needles: () => panelNeedles(lifecycle.commandAsync, employee.id, ragflow.stack),
  });
  const provider = await platformRead(PROVIDER_HEALTH);
  expect({
    forbiddenRequests: provider.forbiddenRequests,
    delegations: provider.delegations,
    searches: provider.searches,
  }).toEqual({ forbiddenRequests: 0, delegations: 1, searches: 1 });
  return { ...search, provider };
}

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
    // RAGFlow is back, so the scope popover lists the seed libraries.
    evidence.scope = await scopeLane(lifecycle, platformRead, {
      administrator,
      employee,
      model,
      ragflow,
    });
    evidence.search = await searchLane(lifecycle, platformRead, {
      administrator,
      employee,
      model,
      ragflow,
    });
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
    for (const [name, subject] of FIXED_CONTAINERS) {
      const existing = await lifecycle.commandAsync(['container', 'inspect', name], 30_000);
      if (!isAbsentResource(existing, 'container', name))
        throw new Error(
          `${subject} container already exists or absence is unproven; refusing deployment`,
        );
    }
    for (const [kind, name] of [
      ['image', image],
      ['container', `dsh-team-test-${runId}-socket-probe`],
      ['container', PLATFORM],
      ['container', DOCUMENT_SERVER],
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
    const model = ownedModel(runId, context.ragflow.seedIds);
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
    evidence.documentServerVolumes = await documentServerVolumes(lifecycle);
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
  // Before compose: the provider's forbidden strings are bound into the platform container.
  const seedIds = await seedRead(() => readSeedDatasetIds(stack));
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
          ragflow: { stack, seed: before, seedIds },
        });
      },
    );
  } finally {
    await release();
  }
  expect(await seedSnapshot(stack)).toEqual(before);
  const { browser, provider, proxy, ragflow, panel, scope, search } = evidence;
  // The real image declares VOLUMEs; the fonts bind replaces only one of them.
  const volumes = evidence.documentServerVolumes ?? [];
  expect(volumes.length).toBeGreaterThan(0);
  await expectVolumesRetired(volumes);
  if (browser === undefined || provider === undefined || proxy === undefined)
    throw new Error('Conversation evidence missing');
  if (panel?.unavailable === undefined || panel.restored === undefined)
    throw new Error('Knowledge panel evidence missing');
  if (ragflow === undefined) throw new Error('RAGFlow test stack evidence missing');
  if (scope === undefined) throw new Error('Knowledge scope evidence missing');
  if (search === undefined) throw new Error('Knowledge search evidence missing');
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
  for (const observed of scope.sessions)
    expect({
      consoleErrors: observed.consoleErrors,
      pageErrors: observed.pageErrors,
      failedRequests: observed.failedRequests,
      externalRequests: observed.externalRequests,
    }).toEqual({ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] });
  const restored = { button: '知识库：1 个', selected: 1, snapshot: 1 };
  const none = { button: '知识库：不检索', selected: 0, snapshot: 'all' };
  expect(scope.steps).toEqual([
    {
      step: 'default',
      button: '知识库：全部',
      selected: 'all',
      snapshot: null,
      screenshot: 'scope-default.png',
    },
    { step: 'running', ...restored, screenshot: 'scope-running.png' },
    { step: 'next-turn', ...restored },
    { step: 'second-session', ...none },
    { step: 'first-session', ...restored },
    { step: 'third-session', button: '知识库：全部', selected: 'all', snapshot: null },
    { step: 'browse', ...restored },
    { step: 'reload-first', ...restored },
    { step: 'reload-second', ...none },
    { step: 'relogin-first', ...restored },
    { step: 'relogin-second', ...none },
    { step: 'restart-first', ...restored, screenshot: 'scope-restored.png' },
    { step: 'restart-second', ...none },
  ]);
  const scopeScreenshots = scope.sessions.flatMap(({ screenshots }) => screenshots);
  expect(scopeScreenshots).toEqual([
    'scope-default.png',
    'scope-running.png',
    'scope-restored.png',
  ]);
  expect({
    consoleErrors: search.browser.consoleErrors,
    pageErrors: search.browser.pageErrors,
    failedRequests: search.browser.failedRequests,
    externalRequests: search.browser.externalRequests,
  }).toEqual({ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] });
  expect(search.browser.screenshots).toEqual(['search-sources.png']);
  expect(search.facts).toMatchObject({ result: 'ok', datasetNames: [POLICIES], excluded: 1 });
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
        scope: {
          steps: scope.steps,
          screenshots: scopeScreenshots,
          forbiddenRequests: scope.forbiddenRequests,
        },
        search: {
          result: search.facts.result,
          chunks: search.facts.chunks,
          datasetNames: search.facts.datasetNames,
          excluded: search.facts.excluded,
          screenshot: search.screenshot,
          elapsedMs: search.elapsedMs,
          waitLimitMs: search.waitLimitMs,
        },
      },
    })}\n`,
  );
});

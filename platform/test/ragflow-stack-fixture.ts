import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { SEED_DATASETS, readSeedDatasets } from '../../scripts/seed-stack.mjs';
import { probeRagflowVersion } from '../../scripts/test-stack.mjs';
import { EXPECTED_RAGFLOW_VERSION } from '../../scripts/test-stack-prerequisites.mjs';
import type { ConfiguredStack } from '../../scripts/test-stack-prerequisites.mjs';
import { RAGFLOW_VERSION_SCHEMA } from '../src/ragflow-proxy/index.ts';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { record } from './docker-cleanup.ts';

/** The single closed result set the proxy routes declare. */
const RESULTS = RAGFLOW_VERSION_SCHEMA.properties.result.enum;
type RagflowResult = (typeof RESULTS)[number];
// A fixed test constant, not employee input: it may appear in the script text.
const QUESTION = '报销需要提交哪些材料';
const HEX_ID = /^[0-9a-f]{32}$/;
const SEED_FILES: readonly string[] = SEED_DATASETS.flatMap(({ files }) => files);
const PLATFORM = 'dsh-team-platform';
const RAGFLOW_PROJECT = 'ragflow-rc2';
const RAGFLOW_SERVICE = 'ragflow-cpu';
const RAGFLOW_CONTAINER = `${RAGFLOW_PROJECT}-${RAGFLOW_SERVICE}-1`;
const RAGFLOW_SERVICES = [RAGFLOW_SERVICE, 'infinity', 'mysql', 'minio', 'nats', 'kvrocks'];
const RECOVERY = `docker start ${RAGFLOW_CONTAINER}`;
const RESTORE_DEADLINE_MS = 300_000;

export type InstanceCall =
  | { readonly kind: 'version' }
  | { readonly kind: 'datasets' }
  | { readonly kind: 'documents'; readonly datasetId: string; readonly keywords?: string }
  | { readonly kind: 'retrieval'; readonly datasetIds: readonly string[] };
type Kind = InstanceCall['kind'];

interface CallFacts<K extends Kind> {
  readonly kind: K;
  /** Null when no HTTP response arrived. */
  readonly status: number | null;
  /** Null unless HTTP 200 carried a result from the closed set. */
  readonly result: RagflowResult | null;
}
interface FactsByKind {
  version: CallFacts<'version'> & { readonly version: string | null };
  datasets: CallFacts<'datasets'> & {
    readonly datasets: number | null;
    readonly seeds: readonly { readonly name: string; readonly id: string }[];
  };
  documents: CallFacts<'documents'> & {
    readonly total: number | null;
    readonly documents: number | null;
    /** Seed file names only; every other name is counted in `others`. */
    readonly files: readonly string[];
    readonly others: number;
  };
  retrieval: CallFacts<'retrieval'> & {
    readonly chunks: number | null;
    /** Chunks whose dataset is a seed dataset and whose document is one of its seed files. */
    readonly seedChunks: number;
    readonly excluded: readonly string[] | null;
  };
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableCount = (value: unknown) => value === null || isCount(value);
const isHexId = (value: unknown) => typeof value === 'string' && HEX_ID.test(value);
function isSeedEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const { name, id } = value as { name?: unknown; id?: unknown };
  return (
    isDeepStrictEqual(keys, ['id', 'name']) &&
    SEED_DATASETS.some((seed) => seed.name === name) &&
    isHexId(id)
  );
}

/** What the script prints before any response arrives; the parser requires exactly these keys. */
const DEFAULTS = {
  version: { version: null },
  datasets: { datasets: null, seeds: [] },
  documents: { total: null, documents: null, files: [], others: 0 },
  retrieval: { chunks: null, seedChunks: 0, excluded: null },
} as const;
const VALIDATORS: { [K in Kind]: Record<keyof (typeof DEFAULTS)[K], (value: unknown) => boolean> } =
  {
    version: { version: (value) => value === null || value === EXPECTED_RAGFLOW_VERSION },
    datasets: {
      datasets: nullableCount,
      seeds: (value) => Array.isArray(value) && value.every(isSeedEntry),
    },
    documents: {
      total: nullableCount,
      documents: nullableCount,
      files: (value) =>
        Array.isArray(value) &&
        value.every((name: unknown) => SEED_FILES.some((file) => file === name)),
      others: isCount,
    },
    retrieval: {
      chunks: nullableCount,
      seedChunks: isCount,
      excluded: (value) => value === null || (Array.isArray(value) && value.every(isHexId)),
    },
  };

/**
 * The platform container reaches the loopback-published RAGFlow API through Docker Desktop's
 * host name; only the host changes. The message never names the address.
 */
export function platformRagflowUrl(url: string): string {
  const match = /^(https?:\/\/)(?:127\.0\.0\.1|\[::1\])((?::\d{1,5})?)$/.exec(url);
  if (match === null) throw new Error('RAGFlow origin is not a literal loopback origin');
  return `${String(match[1])}host.docker.internal${String(match[2])}`;
}

function callRequest(call: InstanceCall) {
  switch (call.kind) {
    case 'version':
    case 'datasets':
      return { path: call.kind, method: 'GET' };
    case 'documents': {
      const keywords =
        call.keywords === undefined ? '' : `&keywords=${encodeURIComponent(call.keywords)}`;
      return {
        path: `datasets/${call.datasetId}/documents?page=1&page_size=10${keywords}`,
        method: 'GET',
      };
    }
    case 'retrieval':
      return {
        path: 'retrieval',
        method: 'POST',
        body: { question: QUESTION, datasetIds: call.datasetIds },
      };
  }
}

/**
 * The `node --input-type=module -e` program for one proxy call from inside an employee instance:
 * argv carries only the platform address and port, the token comes from the platform-injected
 * environment. On every path it prints one JSON line of allowlisted facts (fixed keys, HTTP
 * status, closed-set result, counts, 32-hex IDs, seed names) and exits 0; bodies, chunk content,
 * exception text and the token never reach its output.
 */
export function instanceScript(call: InstanceCall): string {
  const facts = { kind: call.kind, status: null, result: null, ...DEFAULTS[call.kind] };
  return `
const call = ${JSON.stringify(callRequest(call))};
const facts = ${JSON.stringify(facts)};
const results = ${JSON.stringify(RESULTS)};
const seeds = ${JSON.stringify(SEED_DATASETS)};
const seedFiles = seeds.flatMap((seed) => seed.files);
const hex = /^[0-9a-f]{32}$/;
const record = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
const list = (value) => (Array.isArray(value) ? value.map(record) : undefined);
const isId = (value) => typeof value === 'string' && hex.test(value);
const project = {
  version(body) {
    facts.version = body.version === ${JSON.stringify(EXPECTED_RAGFLOW_VERSION)} ? body.version : null;
  },
  datasets(body) {
    const datasets = list(body.datasets);
    facts.datasets = datasets === undefined ? null : datasets.length;
    facts.seeds = (datasets ?? [])
      .filter((item) => seeds.some((seed) => seed.name === item.name) && isId(item.id))
      .map((item) => ({ name: item.name, id: item.id }));
  },
  documents(body) {
    const documents = list(body.documents);
    facts.total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    facts.documents = documents === undefined ? null : documents.length;
    facts.files = (documents ?? []).map((item) => item.name).filter((name) => seedFiles.includes(name));
    facts.others = (documents ?? []).length - facts.files.length;
  },
  retrieval(body) {
    const chunks = list(body.chunks);
    facts.chunks = chunks === undefined ? null : chunks.length;
    facts.seedChunks = (chunks ?? []).filter((chunk) =>
      seeds.some((seed) => seed.name === chunk.datasetName && seed.files.includes(chunk.documentName)),
    ).length;
    facts.excluded = Array.isArray(body.excluded) && body.excluded.every(isId) ? body.excluded : null;
  },
};
try {
  const host = process.argv[1];
  const port = process.argv[2];
  const headers = { authorization: 'Bearer ' + process.env.DSH_TEAM_INSTANCE_TOKEN };
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch('http://' + host + ':' + port + '/_platform/instance-api/ragflow/' + call.path, {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
  });
  facts.status = response.status;
  if (response.status === 200) {
    const body = record(await response.json());
    if (results.includes(body.result)) {
      facts.result = body.result;
      project[facts.kind](body);
    }
  } else await response.body?.cancel();
} catch {
  // Transport, deadline and body failures keep the facts gathered so far; no text survives.
}
process.stdout.write(JSON.stringify(facts) + '\\n');
`;
}

/** One line of exactly the kind's keys and value domains; anything else fails, never a result. */
export function parseInstanceOutput<K extends Kind>(stdout: string, kind: K): FactsByKind[K] {
  const malformed = new Error('Instance proxy call output malformed');
  if (!/^[^\n]+\n$/.test(stdout)) throw malformed;
  let facts: Record<string, unknown>;
  try {
    facts = record(JSON.parse(stdout));
  } catch {
    throw malformed;
  }
  const validators: Record<string, (value: unknown) => boolean> = VALIDATORS[kind];
  const keys = ['kind', 'status', 'result', ...Object.keys(validators)].sort();
  const status = facts.status;
  if (
    !isDeepStrictEqual(Object.keys(facts).sort(), keys) ||
    facts.kind !== kind ||
    !(
      status === null ||
      (Number.isSafeInteger(status) && Number(status) >= 100 && Number(status) <= 599)
    ) ||
    !(facts.result === null || RESULTS.some((result) => result === facts.result)) ||
    !Object.entries(validators).every(([key, valid]) => valid(facts[key]))
  )
    throw malformed;
  // Every key and value domain of FactsByKind[K] was checked above.
  return facts as unknown as FactsByKind[K];
}

/** A JSON object member, or undefined when `value` is not an object. */
function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  // Checked to be a non-array object; Docker JSON members are read as unknown.
  return (value as Record<string, unknown>)[key];
}

/** The platform's endpoint on one employee's bridge (+3) and its listening port. */
export function platformEndpoint(
  document: { readonly networks: unknown; readonly env: unknown },
  employeeId: string,
): { host: string; port: number } {
  const host = member(member(document.networks, `dsh-team-net-${employeeId}`), 'IPAddress');
  const address = typeof host === 'string' ? /^(?:\d{1,3}\.){3}(\d{1,3})$/.exec(host) : null;
  const env: unknown[] = Array.isArray(document.env) ? document.env : [];
  const port = env
    .map((entry) => /^PLATFORM_PORT=([1-9]\d{0,4})$/.exec(String(entry)))
    .find((match) => match !== null);
  if (address === null || Number(address[1]) % 16 !== 3 || port === undefined)
    throw new Error('Platform endpoint on the employee bridge unavailable');
  return { host: address[0], port: Number(port[1]) };
}

interface StackContainer {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly restartCount: number;
  readonly startedAt: string;
  readonly project: string;
  readonly service: string;
}
interface RagflowStack {
  readonly containers: readonly StackContainer[];
  readonly volumes: readonly string[];
  readonly service: (service: string) => StackContainer;
}

const STACK_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},' +
  '"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},' +
  '"project":{{json (index .Config.Labels "com.docker.compose.project")}},' +
  '"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';

function stackContainer(line: string): StackContainer {
  const value = record(JSON.parse(line));
  const { id, name, state, restartCount, startedAt, project, service } = value;
  if (
    typeof id !== 'string' ||
    typeof state !== 'string' ||
    !Number.isSafeInteger(restartCount) ||
    typeof startedAt !== 'string' ||
    typeof project !== 'string' ||
    typeof service !== 'string' ||
    name !== `/${RAGFLOW_PROJECT}-${service}-1`
  )
    throw new Error('RAGFlow container identity mismatch');
  const count = Number(restartCount);
  return { id, name: name.slice(1), state, restartCount: count, startedAt, project, service };
}

/**
 * The stop target: the named container's inspection must carry this stack's compose project and
 * the `ragflow-cpu` service labels and be running; anything else stops nothing.
 */
export function verifiedRagflowContainer(inspection: string): StackContainer {
  let container: StackContainer | undefined;
  try {
    container = stackContainer(inspection);
  } catch {
    // Malformed inspection: the same fixed refusal below.
    container = undefined;
  }
  if (
    container?.project !== RAGFLOW_PROJECT ||
    container.service !== RAGFLOW_SERVICE ||
    container.name !== RAGFLOW_CONTAINER ||
    container.state !== 'running'
  )
    throw new Error('RAGFlow container identity mismatch; nothing stopped');
  return container;
}

/** Exactly the six compose services of the local test stack, plus its labelled volume names. */
export function parseRagflowStack(inspection: string, volumes: string): RagflowStack {
  let containers: StackContainer[];
  try {
    containers = inspection.trimEnd().split('\n').map(stackContainer);
  } catch (error) {
    throw new Error('RAGFlow test stack inspection malformed', { cause: error });
  }
  const services = containers.map(({ service }) => service).sort();
  if (
    !isDeepStrictEqual(services, [...RAGFLOW_SERVICES].sort()) ||
    containers.some(({ project }) => project !== RAGFLOW_PROJECT)
  )
    throw new Error('RAGFlow test stack inspection malformed');
  return {
    containers,
    volumes: volumes.split('\n').filter((name) => name !== ''),
    service: (service) => {
      const found = containers.find((container) => container.service === service);
      if (found === undefined) throw new Error('RAGFlow test stack inspection malformed');
      return found;
    },
  };
}

/**
 * IDs, states and volumes must not change; the other five containers also keep their restart
 * count and start time. ragflow-cpu is restarted by this case, and `docker start` resets its
 * RestartCount (observed 5 to 0 on Docker Desktop), so both are excluded for it alone.
 */
export function comparableRagflowStack(stack: RagflowStack) {
  return {
    containers: [...stack.containers]
      .sort((left, right) => left.service.localeCompare(right.service))
      .map(({ startedAt, restartCount, ...container }) =>
        container.service === RAGFLOW_SERVICE
          ? container
          : { ...container, restartCount, startedAt },
      ),
    volumes: [...stack.volumes].sort(),
  };
}

/** Read-only inspection of the local RAGFlow test stack (never `docker ps`: not a read verb). */
export async function ragflowStackSnapshot(run: DockerOutput): Promise<RagflowStack> {
  const label = `label=com.docker.compose.project=${RAGFLOW_PROJECT}`;
  const names = await run([
    'container',
    'ls',
    '--all',
    '--filter',
    label,
    '--format',
    '{{.Names}}',
  ]);
  const listed = names.split('\n').filter((name) => name !== '');
  const inspection = await run(['container', 'inspect', '--format', STACK_FORMAT, ...listed]);
  const volumes = await run(['volume', 'ls', '--filter', label, '--format', '{{.Name}}']);
  return parseRagflowStack(inspection, volumes);
}

type SeedSnapshot = Awaited<ReturnType<typeof readSeedDatasets>>;

/** The version probe, bounded by `deadlineMs` through the end of its body. */
async function ragflowReady(stack: ConfiguredStack, deadlineMs: number): Promise<boolean> {
  const fact = await probeRagflowVersion(stack.ragflowUrl, deadlineMs);
  if (fact === 'unreachable' || fact.status !== 200) return false;
  try {
    const document = record(JSON.parse(fact.body));
    return document.code === 0 && document.data === EXPECTED_RAGFLOW_VERSION;
  } catch {
    // A warming server may answer an unparseable body; the next poll decides.
    return false;
  }
}

/**
 * The seed snapshot, or undefined while a restarted RAGFlow still fails the read or has not
 * answered within `remainingMs`; the read itself has no signal, so the wait is a race.
 */
async function seedWhenWarm(
  stack: ConfiguredStack,
  remainingMs: number,
): Promise<SeedSnapshot | undefined> {
  const read = readSeedDatasets(stack);
  // A read that loses the race still settles later; its failure is already accounted for.
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, remainingMs);
  });
  try {
    return await Promise.race([read, expired]);
  } catch {
    // Warm-up failures are retried within the restore deadline; the deadline error is final.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Restore polling bounds: production uses the 300s deadline at a 1s interval. */
interface RestoreTiming {
  readonly deadlineMs: number;
  readonly intervalMs: number;
}

/**
 * Polls until the version is ready and the seed snapshot reads; every probe, read and sleep is
 * bounded by the time left before `deadline`, so the wait never outlives it.
 */
async function awaitRestored(
  stack: ConfiguredStack,
  seed: SeedSnapshot,
  deadline: number,
  timing: RestoreTiming,
): Promise<void> {
  const seconds = String(Math.round(timing.deadlineMs / 1_000));
  const remaining = () => deadline - performance.now();
  let seedUnreadable = false;
  for (;;) {
    if (remaining() <= 0)
      throw new Error(
        seedUnreadable
          ? `RAGFlow version ready but seed snapshot unreadable within ${seconds}s`
          : `RAGFlow version not ready within ${seconds}s`,
      );
    // AbortSignal.timeout rejects a fractional delay, which the probe would report as unreachable.
    if (await ragflowReady(stack, Math.max(1, Math.floor(Math.min(5_000, remaining()))))) {
      const snapshot = await seedWhenWarm(stack, Math.max(0, remaining()));
      // A successful but different snapshot is a real change, not warm-up.
      if (snapshot !== undefined && !isDeepStrictEqual(snapshot, seed))
        throw new Error('RAGFlow seed snapshot changed');
      if (snapshot !== undefined) return;
      seedUnreadable = true;
    } else seedUnreadable = false;
    await delay(Math.max(0, Math.min(timing.intervalMs, remaining())));
  }
}

/**
 * A real outage of the identity-checked `ragflow-cpu` container (user-authorized 2026-11-03):
 * `docker stop` and `docker start` of its captured ID only. `restore()` performs the start and
 * the bounded readiness wait once; later calls resolve undefined without touching Docker. The
 * deadline runs from before `docker start`, whose own 60s CLI bound lies inside it.
 */
export function ragflowOutage(
  run: DockerOutput,
  stack: ConfiguredStack,
  seed: SeedSnapshot,
  timing: RestoreTiming = { deadlineMs: RESTORE_DEADLINE_MS, intervalMs: 1_000 },
) {
  let id: string | undefined;
  let restored = false;
  async function start(container: string): Promise<number> {
    const started = performance.now();
    try {
      await run(['start', container], 60_000);
      await awaitRestored(stack, seed, started + timing.deadlineMs, timing);
    } catch (error) {
      // Our own reasons and the redacted CLI failure name no address, key or body.
      const reason = error instanceof Error ? error.message : 'unknown failure';
      throw new Error(`RAGFlow restore failed (${reason}); recover manually with: ${RECOVERY}`, {
        cause: error,
      });
    }
    return Math.round(performance.now() - started);
  }
  return {
    async stop(): Promise<void> {
      const inspection = ['container', 'inspect', '--format', STACK_FORMAT, RAGFLOW_CONTAINER];
      const current = verifiedRagflowContainer(await run(inspection));
      process.stderr.write(
        `test:stack stopping RAGFlow container ${RAGFLOW_CONTAINER} (${current.id}); ` +
          `restore manually with ${RECOVERY}\n`,
      );
      // A CLI timeout may still have stopped it: restoration keys on submission, not success.
      id = current.id;
      await run(['stop', current.id], 60_000);
    },
    async restore(): Promise<number | undefined> {
      if (id === undefined || restored) return undefined;
      restored = true;
      return start(id);
    },
  };
}

type Outage = ReturnType<typeof ragflowOutage>;

/** Runs `body` inside a stopped-RAGFlow window whose restoration also runs on failure. */
export async function duringRagflowOutage<T>(outage: Outage, body: () => Promise<T>): Promise<T> {
  const failures: unknown[] = [];
  let value: T | undefined;
  try {
    await outage.stop();
    value = await body();
  } catch (error) {
    failures.push(error);
  }
  try {
    await outage.restore();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'RAGFlow outage case and restore failed');
  // Without a failure the body has returned its value.
  return value as T;
}

/** Proxy calls from inside one employee instance to the platform on that instance's bridge. */
export async function instanceProxy(run: DockerOutput, employeeId: string) {
  const document = record(
    JSON.parse(
      await run([
        'container',
        'inspect',
        '--format',
        '{"networks":{{json .NetworkSettings.Networks}},"env":{{json .Config.Env}}}',
        PLATFORM,
      ]),
    ),
  );
  const endpoint = platformEndpoint({ networks: document.networks, env: document.env }, employeeId);
  return async <C extends InstanceCall>(call: C): Promise<FactsByKind[C['kind']]> => {
    const exec = ['exec', '--user', '1001', `dsh-team-u-${employeeId}`, 'node'];
    const script = ['--input-type=module', '-e', instanceScript(call)];
    const stdout = await run([...exec, ...script, endpoint.host, String(endpoint.port)], 30_000);
    return parseInstanceOutput<C['kind']>(stdout, call.kind);
  };
}

interface Administrator {
  readonly base: string;
  readonly cookie: string;
}

/** Same-origin administrator JSON request; the response body is never logged. */
async function adminJson(
  target: Administrator,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${target.base}/_platform/api/admin/${path}`, {
    method,
    headers: {
      origin: target.base,
      cookie: target.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

type InstanceProxy = Awaited<ReturnType<typeof instanceProxy>>;
const MISSING_ID = '0'.repeat(32);
const POLICIES = 'dsh-team-seed-policies';
const DEFAULT_RETRIEVAL = {
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
};

/**
 * The administrator saves the platform-side RAGFlow address and the private key; the connection
 * test is the positive control for the `host.docker.internal` path. The key is only in the body.
 */
export async function configureRagflow(admin: Administrator, stack: ConfiguredStack) {
  const baseURL = platformRagflowUrl(stack.ragflowUrl);
  const saved = await adminJson(admin, 'PUT', 'ragflow-config', {
    baseURL,
    apiKey: stack.ragflowApiKey,
  });
  expect(saved).toEqual({
    status: 200,
    body: { baseURL, apiKeyConfigured: true, runningInstances: 0 },
  });
  const tested = await adminJson(admin, 'POST', 'ragflow-config/test', {});
  expect(tested).toEqual({
    status: 200,
    body: { result: 'ok', version: EXPECTED_RAGFLOW_VERSION },
  });
  return baseURL;
}

/** While RAGFlow is stopped: the settings page still reads, everything reaching RAGFlow is unavailable. */
export async function proxyWhileDown(admin: Administrator, baseURL: string, call: InstanceProxy) {
  const config = await adminJson(admin, 'GET', 'ragflow-config');
  expect(config).toEqual({ status: 200, body: { baseURL, apiKeyConfigured: true } });
  const tested = await adminJson(admin, 'POST', 'ragflow-config/test', {});
  expect(tested).toEqual({ status: 200, body: { result: 'unavailable' } });
  // Any well-formed ID will do: both calls fail on their way to RAGFlow.
  const facts = [
    await call({ kind: 'version' }),
    await call({ kind: 'datasets' }),
    await call({ kind: 'documents', datasetId: MISSING_ID }),
    await call({ kind: 'retrieval', datasetIds: [MISSING_ID] }),
  ];
  for (const fact of facts) expect(fact).toMatchObject({ status: 200, result: 'unavailable' });
  return {
    downResults: Object.fromEntries(facts.map(({ kind, result }) => [kind, result])),
    adminDown: { configStatus: config.status, testResult: member(tested.body, 'result') },
  };
}

/** Seed dataset IDs by name from the instance's dataset list: exactly one per seed name. */
async function seedIds(call: InstanceProxy): Promise<Map<string, string>> {
  const datasets = await call({ kind: 'datasets' });
  expect(datasets).toMatchObject({ status: 200, result: 'ok' });
  const ids = new Map<string, string>();
  for (const { name } of SEED_DATASETS) {
    const matches = datasets.seeds.filter((seed) => seed.name === name);
    expect(matches.length, name).toBe(1);
    ids.set(name, String(matches[0]?.id));
  }
  return ids;
}

async function seedDocuments(call: InstanceProxy, ids: Map<string, string>) {
  const totals: (number | null)[] = [];
  for (const seed of SEED_DATASETS) {
    const page = await call({ kind: 'documents', datasetId: String(ids.get(seed.name)) });
    expect({ ...page, files: [...page.files].sort() }, seed.name).toEqual({
      kind: 'documents',
      status: 200,
      result: 'ok',
      total: 2,
      documents: 2,
      files: [...seed.files].sort(),
      others: 0,
    });
    totals.push(page.total);
  }
  const policies = String(ids.get(POLICIES));
  const keywords = await call({ kind: 'documents', datasetId: policies, keywords: 'expense' });
  expect(keywords).toEqual({
    kind: 'documents',
    status: 200,
    result: 'ok',
    total: 1,
    documents: 1,
    files: ['expense-policy.txt'],
    others: 0,
  });
  return { documentsTotals: totals, keywordsTotal: keywords.total };
}

/**
 * After `ragflow-cpu` is back: the proxy's first requests to the real rc2. Retrieval is paid
 * (user-accepted 2026-11-03) and limited to these three calls.
 */
export async function proxyAfterRestore(admin: Administrator, outage: Outage, call: InstanceProxy) {
  const ragflowRestartMs = await outage.restore();
  if (ragflowRestartMs === undefined) throw new Error('RAGFlow was not stopped by this case');
  const version = await call({ kind: 'version' });
  expect(version).toEqual({
    kind: 'version',
    status: 200,
    result: 'ok',
    version: EXPECTED_RAGFLOW_VERSION,
  });
  const ids = await seedIds(call);
  const documents = await seedDocuments(call, ids);
  const all = [...ids.values()];
  const retrieval = await call({ kind: 'retrieval', datasetIds: all });
  expect(retrieval).toMatchObject({ status: 200, result: 'ok', excluded: [] });
  expect(retrieval.chunks).toBeGreaterThanOrEqual(1);
  expect(retrieval.seedChunks).toBe(retrieval.chunks);
  // The passing scope plus a fake ID: a narrower scope may legitimately find no chunk.
  const excluded = await call({ kind: 'retrieval', datasetIds: [...all, MISSING_ID] });
  expect(excluded).toMatchObject({ status: 200, result: 'ok', excluded: [MISSING_ID] });
  expect(excluded.seedChunks).toBe(excluded.chunks);
  expect(await adminJson(admin, 'GET', 'retrieval-config')).toEqual({
    status: 200,
    body: DEFAULT_RETRIEVAL,
  });
  const strict = { ...DEFAULT_RETRIEVAL, retrievalSimilarityThreshold: 1 };
  expect(await adminJson(admin, 'PUT', 'retrieval-config', strict)).toEqual({
    status: 200,
    body: { ...strict, runningInstances: 1 },
  });
  // Neither the instance nor the platform restarts: the saved threshold applies to the next call.
  const thresholded = await call({ kind: 'retrieval', datasetIds: all });
  expect(thresholded).toMatchObject({ status: 200, result: 'no-results' });
  return {
    version: version.version,
    seedDatasets: ids.size,
    ...documents,
    retrieval: { result: retrieval.result, chunks: retrieval.chunks },
    excluded: excluded.excluded?.length ?? 0,
    thresholdResult: thresholded.result,
    ragflowRestartMs,
  };
}

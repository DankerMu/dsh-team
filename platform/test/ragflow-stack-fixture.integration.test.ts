import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { SEED_DATASETS, readSeedDatasets } from '../../scripts/seed-stack.mjs';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import type { AsyncDockerCommand, DockerCommandResult } from './docker-command.ts';
import {
  comparableRagflowStack,
  duringRagflowOutage,
  instancePlatformEndpoint,
  instanceScript,
  parseInstanceOutput,
  parseRagflowStack,
  platformEndpoint,
  platformRagflowUrl,
  ragflowOutage,
  verifiedRagflowContainer,
} from './ragflow-stack-fixture.ts';
import type { InstanceCall } from './ragflow-stack-fixture.ts';

const TOKEN = 'a'.repeat(64);
const SECRET = 'planted-secret-chunk-content';
const POLICIES = '1'.repeat(32);
const PRODUCTS = '2'.repeat(32);
const MISSING = '0'.repeat(32);
const servers: { close: () => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.restoreAllMocks();
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** A loopback stand-in for the platform: answers each request with `answer`'s status and text. */
async function stubPlatform(answer: (url: string) => { status: number; body: string }) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const { status, body } = answer(request.url ?? '');
      response.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, seen };
}

/** The in-instance script under the real Node, with the token only in its environment. */
async function runScript(call: InstanceCall, port: number) {
  const args = ['--input-type=module', '-e', instanceScript(call), '127.0.0.1', String(port)];
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH ?? '', DSH_TEAM_INSTANCE_TOKEN: TOKEN },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { args, code, stdout, stderr };
}

function expectNoLeak(run: Awaited<ReturnType<typeof runScript>>) {
  expect(run.code).toBe(0);
  expect(run.stderr).toBe('');
  expect(`${run.args.join(' ')}${run.stdout}`).not.toContain(TOKEN);
  expect(run.stdout).not.toContain(SECRET);
}

const json = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });

it.each([
  ['http://127.0.0.1:19380', 'http://host.docker.internal:19380'],
  ['http://[::1]:19380', 'http://host.docker.internal:19380'],
  ['https://127.0.0.1:9443', 'https://host.docker.internal:9443'],
  ['http://127.0.0.1', 'http://host.docker.internal'],
])('rewrites the loopback RAGFlow origin %s for the platform container', (url, expected) => {
  const rewritten = platformRagflowUrl(url);

  expect(rewritten).toBe(expected);
});

it.each(['http://localhost:19380', 'http://10.0.0.1:19380', 'http://127.0.0.1:19380/api', ''])(
  'refuses to rewrite a non-loopback or non-origin address %j without naming it',
  (url) => {
    const rewrite = () => platformRagflowUrl(url);

    expect(rewrite).toThrow(/^RAGFlow origin is not a literal loopback origin$/);
  },
);

it('reports version and dataset facts over the declared routes with the environment token', async () => {
  const stub = await stubPlatform((url) =>
    url.endsWith('/version')
      ? json({ result: 'ok', version: 'v1.0.0-rc2', note: SECRET })
      : json({
          result: 'ok',
          datasets: [
            { id: POLICIES, name: 'dsh-team-seed-policies' },
            { id: PRODUCTS, name: SECRET },
            { id: 'not-hex', name: 'dsh-team-seed-minutes' },
            { id: [PRODUCTS], name: 'dsh-team-seed-products' },
          ],
        }),
  );

  const version = await runScript({ kind: 'version' }, stub.port);
  const datasets = await runScript({ kind: 'datasets' }, stub.port);

  expectNoLeak(version);
  expectNoLeak(datasets);
  expect(parseInstanceOutput(version.stdout, 'version')).toEqual({
    kind: 'version',
    status: 200,
    result: 'ok',
    version: 'v1.0.0-rc2',
  });
  expect(parseInstanceOutput(datasets.stdout, 'datasets')).toEqual({
    kind: 'datasets',
    status: 200,
    result: 'ok',
    datasets: 4,
    seeds: [{ name: 'dsh-team-seed-policies', id: POLICIES }],
  });
  expect(stub.seen).toEqual(
    ['version', 'datasets'].map((path) => ({
      method: 'GET',
      url: `/_platform/instance-api/ragflow/${path}`,
      authorization: `Bearer ${TOKEN}`,
      contentType: undefined,
      body: '',
    })),
  );
});

it('reports document totals and only seed file names for a keyword page', async () => {
  const stub = await stubPlatform(() =>
    json({
      result: 'ok',
      total: 3,
      documents: [
        { id: POLICIES, name: 'expense-policy.txt' },
        { id: PRODUCTS, name: SECRET },
      ],
    }),
  );

  const run = await runScript(
    { kind: 'documents', datasetId: POLICIES, keywords: 'expense & co' },
    stub.port,
  );

  expectNoLeak(run);
  expect(parseInstanceOutput(run.stdout, 'documents')).toEqual({
    kind: 'documents',
    status: 200,
    result: 'ok',
    total: 3,
    documents: 2,
    files: ['expense-policy.txt'],
    others: 1,
  });
  expect(stub.seen.map(({ method, url }) => ({ method, url }))).toEqual([
    {
      method: 'GET',
      url: `/_platform/instance-api/ragflow/datasets/${POLICIES}/documents?page=1&page_size=10&keywords=expense%20%26%20co`,
    },
  ]);
});

it('reports retrieval counts and exclusions without chunk content', async () => {
  const stub = await stubPlatform(() =>
    json({
      result: 'ok',
      excluded: [MISSING],
      chunks: [
        {
          content: SECRET,
          datasetName: 'dsh-team-seed-policies',
          documentName: 'expense-policy.txt',
        },
        {
          content: SECRET,
          datasetName: 'dsh-team-seed-policies',
          documentName: 'product-catalog.txt',
        },
        { content: SECRET, datasetName: SECRET, documentName: 'expense-policy.txt' },
      ],
    }),
  );

  const run = await runScript({ kind: 'retrieval', datasetIds: [POLICIES, MISSING] }, stub.port);

  expectNoLeak(run);
  expect(parseInstanceOutput(run.stdout, 'retrieval')).toEqual({
    kind: 'retrieval',
    status: 200,
    result: 'ok',
    chunks: 3,
    seedChunks: 1,
    excluded: [MISSING],
  });
  expect(stub.seen).toEqual([
    {
      method: 'POST',
      url: '/_platform/instance-api/ragflow/retrieval',
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
      body: JSON.stringify({ question: '报销需要提交哪些材料', datasetIds: [POLICIES, MISSING] }),
    },
  ]);
});

it.each([
  ['a rejected token', { status: 401, body: JSON.stringify({ message: SECRET }) }, 401],
  ['an unparseable body', { status: 200, body: `not json ${SECRET}` }, 200],
  ['a result outside the closed set', json({ result: SECRET, excluded: [SECRET] }), 200],
])('keeps only the HTTP status for %s', async (_name, answer, status) => {
  const stub = await stubPlatform(() => answer);

  const run = await runScript({ kind: 'retrieval', datasetIds: [POLICIES] }, stub.port);

  expectNoLeak(run);
  expect(parseInstanceOutput(run.stdout, 'retrieval')).toEqual({
    kind: 'retrieval',
    status,
    result: null,
    chunks: null,
    seedChunks: 0,
    excluded: null,
  });
});

it('reports an unreachable platform without a status and still exits 0', async () => {
  const stub = await stubPlatform(() => json({}));
  servers.splice(0).forEach((server) => {
    server.close();
  });

  const run = await runScript({ kind: 'version' }, stub.port);

  expectNoLeak(run);
  expect(parseInstanceOutput(run.stdout, 'version')).toEqual({
    kind: 'version',
    status: null,
    result: null,
    version: null,
  });
});

const VERSION_FACTS = { kind: 'version', status: 200, result: 'ok', version: 'v1.0.0-rc2' };
const DOCUMENT_FACTS = {
  kind: 'documents',
  status: 200,
  result: 'ok',
  total: 2,
  documents: 2,
  files: ['expense-policy.txt'],
  others: 0,
};

it.each([
  ['empty output', ''],
  ['a missing line break', JSON.stringify(VERSION_FACTS)],
  ['two lines', `${JSON.stringify(VERSION_FACTS)}\n${JSON.stringify(VERSION_FACTS)}\n`],
  ['non-JSON output', 'instance call failed\n'],
  ['an array', '[]\n'],
  ['another kind', `${JSON.stringify({ ...DOCUMENT_FACTS })}\n`],
  ['an extra key', `${JSON.stringify({ ...VERSION_FACTS, body: SECRET })}\n`],
  ['a missing key', `${JSON.stringify({ kind: 'version', status: 200, result: 'ok' })}\n`],
  ['a non-integer status', `${JSON.stringify({ ...VERSION_FACTS, status: '200' })}\n`],
  ['an out-of-range status', `${JSON.stringify({ ...VERSION_FACTS, status: 99 })}\n`],
  ['a result outside the set', `${JSON.stringify({ ...VERSION_FACTS, result: 'fine' })}\n`],
  ['an unexpected version', `${JSON.stringify({ ...VERSION_FACTS, version: 'v1.0.1' })}\n`],
])('rejects version output with %s', (_name, stdout) => {
  const parse = () => parseInstanceOutput(stdout, 'version');

  expect(parse).toThrow(/^Instance proxy call output malformed$/);
});

it.each([
  ['a negative total', { total: -1 }],
  ['a fractional count', { documents: 1.5 }],
  ['a non-seed file name', { files: ['notes.txt'] }],
  ['a null others count', { others: null }],
])('rejects document output with %s', (_name, change) => {
  const parse = () =>
    parseInstanceOutput(`${JSON.stringify({ ...DOCUMENT_FACTS, ...change })}\n`, 'documents');

  expect(parse).toThrow(/^Instance proxy call output malformed$/);
});

it.each([
  ['a non-hex excluded ID', { excluded: ['xyz'] }],
  ['a non-seed dataset', { seeds: [{ name: 'other', id: POLICIES }] }],
  ['a non-hex dataset ID', { seeds: [{ name: 'dsh-team-seed-policies', id: 'abc' }] }],
  ['an extra seed key', { seeds: [{ name: 'dsh-team-seed-policies', id: POLICIES, x: 1 }] }],
])('rejects dataset and retrieval output with %s', (_name, change) => {
  const datasets = { kind: 'datasets', status: 200, result: 'ok', datasets: 1, seeds: [] };
  const retrieval = { kind: 'retrieval', status: 200, result: 'ok', chunks: 1, seedChunks: 1 };
  const [kind, facts] =
    'excluded' in change ? (['retrieval', retrieval] as const) : (['datasets', datasets] as const);

  const parse = () =>
    parseInstanceOutput(`${JSON.stringify({ excluded: [], ...facts, ...change })}\n`, kind);

  expect(parse).toThrow(/^Instance proxy call output malformed$/);
});

it('reads the platform endpoint on the employee bridge and its configured port', () => {
  const document = {
    networks: {
      'dsh-team-test-run_default': { IPAddress: '172.18.0.2' },
      'dsh-team-net-7': { IPAddress: '172.30.0.19' },
    },
    env: ['PATH=/usr/bin', 'PLATFORM_PORT=41234', 'PLATFORM_HOST=0.0.0.0'],
  };

  const endpoint = platformEndpoint(document, '7');

  expect(endpoint).toEqual({ host: '172.30.0.19', port: 41234 });
});

it('reads the endpoint from one inspection of the live platform container', async () => {
  const calls: (readonly string[])[] = [];
  const command: AsyncDockerCommand = (args) => {
    calls.push(args);
    const networks = { 'dsh-team-net-7': { IPAddress: '172.30.0.19' } };
    const stdout = `${JSON.stringify({ networks, env: ['PLATFORM_PORT=41234'] })}\n`;
    return Promise.resolve({ status: 0, stdout, stderr: '' });
  };

  await expect(instancePlatformEndpoint(command, '7')).resolves.toEqual({
    host: '172.30.0.19',
    port: 41234,
  });
  expect(calls).toEqual([
    [
      'container',
      'inspect',
      '--format',
      '{"networks":{{json .NetworkSettings.Networks}},"env":{{json .Config.Env}}}',
      'dsh-team-platform',
    ],
  ]);
});

it.each([
  ['no employee bridge', { 'dsh-team-net-8': { IPAddress: '172.30.0.19' } }, ['PLATFORM_PORT=1']],
  [
    'an address other than +3',
    { 'dsh-team-net-7': { IPAddress: '172.30.0.18' } },
    ['PLATFORM_PORT=1'],
  ],
  ['a malformed address', { 'dsh-team-net-7': { IPAddress: '172.30.0' } }, ['PLATFORM_PORT=1']],
  ['no port', { 'dsh-team-net-7': { IPAddress: '172.30.0.19' } }, ['PATH=/usr/bin']],
  ['a malformed port', { 'dsh-team-net-7': { IPAddress: '172.30.0.19' } }, ['PLATFORM_PORT=0x1']],
])('rejects a platform endpoint with %s', (_name, networks, env) => {
  const read = () => platformEndpoint({ networks, env }, '7');

  expect(read).toThrow(/^Platform endpoint on the employee bridge unavailable$/);
});

const SERVICES = ['ragflow-cpu', 'infinity', 'mysql', 'minio', 'nats', 'kvrocks'];
const container = (service: string, change: Record<string, unknown> = {}) => ({
  id: `${service}-id`,
  name: `/ragflow-rc2-${service}-1`,
  state: 'running',
  restartCount: 5,
  startedAt: `${service}-started`,
  project: 'ragflow-rc2',
  service,
  ...change,
});
const inspected = (rows: Record<string, unknown>[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const VOLUMES = 'ragflow-rc2_mysql_data\nragflow-rc2_minio_data\n';

it('compares the six RAGFlow containers ignoring only the start time and restart count of the restarted service', () => {
  const before = parseRagflowStack(
    inspected(SERVICES.map((service) => container(service))),
    VOLUMES,
  );
  const restarted = parseRagflowStack(
    inspected(
      [...SERVICES]
        .reverse()
        .map((service) =>
          container(
            service,
            service === 'ragflow-cpu' ? { startedAt: 'later', restartCount: 0 } : {},
          ),
        ),
    ),
    VOLUMES,
  );

  const [left, right] = [comparableRagflowStack(before), comparableRagflowStack(restarted)];

  expect(right).toEqual(left);
  expect(left.volumes).toEqual(['ragflow-rc2_minio_data', 'ragflow-rc2_mysql_data']);
  expect(before.service('ragflow-cpu')).toMatchObject({ id: 'ragflow-cpu-id', restartCount: 5 });
});

it.each([
  ['a changed ID', 'mysql', { id: 'other' }],
  ['a changed ragflow-cpu ID', 'ragflow-cpu', { id: 'other' }],
  ['another restart count', 'mysql', { restartCount: 6 }],
  ['a changed state', 'ragflow-cpu', { state: 'exited' }],
  ['another service restarted', 'nats', { startedAt: 'later' }],
])('detects %s in the RAGFlow stack', (_name, changed, change) => {
  const before = parseRagflowStack(
    inspected(SERVICES.map((service) => container(service))),
    VOLUMES,
  );
  const after = parseRagflowStack(
    inspected(SERVICES.map((service) => container(service, service === changed ? change : {}))),
    VOLUMES,
  );

  const [left, right] = [comparableRagflowStack(before), comparableRagflowStack(after)];

  expect(right).not.toEqual(left);
});

it('detects a changed RAGFlow volume inventory', () => {
  const rows = inspected(SERVICES.map((service) => container(service)));

  const [left, right] = [
    comparableRagflowStack(parseRagflowStack(rows, VOLUMES)),
    comparableRagflowStack(parseRagflowStack(rows, 'ragflow-rc2_mysql_data\n')),
  ];

  expect(right).not.toEqual(left);
});

it.each([
  ['a missing service', inspected(SERVICES.slice(1).map((service) => container(service)))],
  [
    'an extra container',
    inspected([
      ...SERVICES.map((service) => container(service)),
      container('ragflow-cpu', { name: '/x' }),
    ]),
  ],
  [
    'a foreign project label',
    inspected(SERVICES.map((service) => container(service, { project: 'x' }))),
  ],
  [
    'a name that does not match the service',
    inspected(SERVICES.map((service) => container(service, { name: '/x' }))),
  ],
  [
    'a non-integer restart count',
    inspected(SERVICES.map((service) => container(service, { restartCount: '5' }))),
  ],
  ['non-JSON inspection', 'ragflow\n'],
])('rejects a RAGFlow stack inspection with %s', (_name, rows) => {
  const parse = () => parseRagflowStack(rows, VOLUMES);

  expect(parse).toThrow(/^RAGFlow test stack inspection malformed$/);
});

it('embeds only the seed names, closed results and the fixed question in the script', () => {
  const script = instanceScript({ kind: 'retrieval', datasetIds: [POLICIES] });

  for (const { name, files } of SEED_DATASETS) {
    expect(script).toContain(name);
    for (const file of files) expect(script).toContain(file);
  }
  expect(script).toContain('process.env.DSH_TEAM_INSTANCE_TOKEN');
  expect(script).not.toContain(TOKEN);
});

it('accepts the running ragflow-cpu container of the ragflow-rc2 project as the stop target', () => {
  const inspection = inspected([container('ragflow-cpu')]);

  const target = verifiedRagflowContainer(inspection);

  expect(target).toMatchObject({ id: 'ragflow-cpu-id', restartCount: 5, state: 'running' });
});

it.each([
  ['a foreign compose project', container('ragflow-cpu', { project: 'other' })],
  ['a missing compose project label', container('ragflow-cpu', { project: '' })],
  ['another service', container('mysql', { name: '/ragflow-rc2-ragflow-cpu-1' })],
  ['another service under its own name', container('mysql')],
  ['a stopped container', container('ragflow-cpu', { state: 'exited' })],
  ['a malformed inspection', { id: 1 }],
])('refuses to stop %s', (_name, row) => {
  const verify = () => verifiedRagflowContainer(inspected([row]));

  expect(verify).toThrow(/^RAGFlow container identity mismatch; nothing stopped$/);
});

interface RagflowStubState {
  version: 'ready' | 'down' | 'hang';
  datasets: 'ok' | 'fail' | 'hang';
}

/** A loopback stand-in for the RAGFlow API: the version and the seed listings it is read for. */
async function stubRagflow(state: RagflowStubState) {
  const ids = SEED_DATASETS.map((_, index) => String(index + 1).repeat(32));
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const hang = url === '/api/v1/system/version' ? state.version : state.datasets;
    if (hang === 'hang') return;
    if (url === '/api/v1/system/version') {
      if (state.version === 'ready') send(200, { code: 0, data: 'v1.0.0-rc2' });
      else send(503, { code: 1 });
    } else if (state.datasets === 'fail') send(500, { code: 100 });
    else if (url === '/api/v1/datasets?page_size=100')
      send(200, {
        code: 0,
        data: SEED_DATASETS.map(({ name }, index) => ({ id: ids[index], name })),
      });
    else {
      const index = ids.findIndex((id) => url === `/api/v1/datasets/${id}/documents?page_size=100`);
      const files = SEED_DATASETS[index]?.files ?? [];
      const docs = files.map((name, file) => ({
        id: `${String(index)}-${String(file)}`,
        name,
        ingestion_status: 'COMPLETED',
      }));
      send(200, { code: 0, data: { docs } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () => {
      // Hanging requests would otherwise keep the server open past the test.
      server.closeAllConnections();
      server.close();
    },
  });
  const port = (server.address() as AddressInfo).port;
  return { ragflowUrl: `http://127.0.0.1:${String(port)}`, ragflowApiKey: 'stub-key' };
}

/** A recording Docker boundary; the stderr announcement is recorded in the same sequence. */
function fakeDocker(
  failures: { stop?: Error; start?: Error } = {},
  inspection = inspected([container('ragflow-cpu')]),
) {
  const calls: string[] = [];
  const run: DockerOutput = (args) => {
    const [verb] = args;
    calls.push(verb === 'container' ? `inspect ${String(args.at(-1))}` : args.join(' '));
    if (verb === 'container') return Promise.resolve(inspection);
    const failure = verb === 'stop' ? failures.stop : verb === 'start' ? failures.start : undefined;
    return failure === undefined ? Promise.resolve('') : Promise.reject(failure);
  };
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    calls.push(`announce ${String(text)}`);
    return true;
  });
  return { run, calls };
}

const READY: RagflowStubState = { version: 'ready', datasets: 'ok' };
const QUICK = { deadlineMs: 2_000, intervalMs: 10 };
const ANNOUNCE =
  'announce test:stack stopping RAGFlow container ragflow-rc2-ragflow-cpu-1 (ragflow-cpu-id); ' +
  'restore manually with docker start ragflow-rc2-ragflow-cpu-1\n';
const STOPPED = ['inspect ragflow-rc2-ragflow-cpu-1', ANNOUNCE, 'stop ragflow-cpu-id'];

it('stops nothing and runs no body when the named container is not the verified stop target', async () => {
  const stack = await stubRagflow({ ...READY });
  const docker = fakeDocker({}, inspected([container('ragflow-cpu', { project: 'other' })]));
  const body = vi.fn(() => Promise.resolve('ran'));

  const outcome = duringRagflowOutage(ragflowOutage(docker.run, stack, [], QUICK), body);

  await expect(outcome).rejects.toThrow(/^RAGFlow container identity mismatch; nothing stopped$/);
  expect(docker.calls).toEqual(['inspect ragflow-rc2-ragflow-cpu-1']);
  expect(body).not.toHaveBeenCalled();
});

it('starts the captured ID once and rethrows the stop failure after a submitted stop', async () => {
  const stack = await stubRagflow({ ...READY });
  const seed = await readSeedDatasets(stack);
  const stopFailure = new Error('docker stop timed out');
  const docker = fakeDocker({ stop: stopFailure });
  const body = vi.fn(() => Promise.resolve('ran'));

  const outcome = duringRagflowOutage(ragflowOutage(docker.run, stack, seed, QUICK), body);

  await expect(outcome).rejects.toBe(stopFailure);
  expect(docker.calls).toEqual([...STOPPED, 'start ragflow-cpu-id']);
  expect(body).not.toHaveBeenCalled();
});

it('restores once and rethrows the body failure unchanged', async () => {
  const stack = await stubRagflow({ ...READY });
  const seed = await readSeedDatasets(stack);
  const docker = fakeDocker();
  const failure = new Error('instance call failed');

  const outcome = duringRagflowOutage(ragflowOutage(docker.run, stack, seed, QUICK), () =>
    Promise.reject(failure),
  );

  await expect(outcome).rejects.toBe(failure);
  expect(docker.calls).toEqual([...STOPPED, 'start ragflow-cpu-id']);
});

it.each([
  ['the start fails', { ...READY }, new Error('docker start failed'), /docker start failed/],
  [
    'the version never answers',
    { version: 'hang', datasets: 'ok' } as const,
    undefined,
    /version not ready within 1s/,
  ],
  [
    'the version stays down',
    { version: 'down', datasets: 'ok' } as const,
    undefined,
    /version not ready within 1s/,
  ],
  [
    'the seed read keeps failing',
    { version: 'ready', datasets: 'fail' } as const,
    undefined,
    /version ready but seed snapshot unreadable within 1s/,
  ],
  [
    'the seed read never answers',
    { version: 'ready', datasets: 'hang' } as const,
    undefined,
    /version ready but seed snapshot unreadable within 1s/,
  ],
])(
  'aggregates the body failure first and a restore failure naming the recovery when %s',
  async (_name, state, start, reason) => {
    const stack = await stubRagflow(state);
    const docker = fakeDocker(start === undefined ? {} : { start });
    const failure = new Error('instance call failed');
    const began = performance.now();

    const outcome = duringRagflowOutage(
      ragflowOutage(docker.run, stack, [], { deadlineMs: 1_000, intervalMs: 20 }),
      () => Promise.reject(failure),
    );

    const error: unknown = await outcome.catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(AggregateError);
    // Checked to be an AggregateError just above; its errors are the case's own failures.
    const [first, restore] = (error as AggregateError).errors as [unknown, Error];
    expect(first).toBe(failure);
    expect(restore.message).toMatch(reason);
    expect(restore.message).toMatch(
      /^RAGFlow restore failed \(.*\); recover manually with: docker start ragflow-rc2-ragflow-cpu-1$/,
    );
    // Every probe and read is bounded by the deadline that runs from before `docker start`.
    expect(performance.now() - began).toBeLessThan(2_500);
    expect(docker.calls).toEqual([...STOPPED, 'start ragflow-cpu-id']);
  },
);

it('fails the restore at once when a successful seed read differs from the recorded snapshot', async () => {
  const stack = await stubRagflow({ ...READY });
  const docker = fakeDocker();
  const outage = ragflowOutage(docker.run, stack, [], { deadlineMs: 60_000, intervalMs: 20 });
  await outage.stop();
  const began = performance.now();

  const restored = outage.restore();

  await expect(restored).rejects.toThrow(
    /^RAGFlow restore failed \(RAGFlow seed snapshot changed\)/,
  );
  expect(performance.now() - began).toBeLessThan(5_000);
});

it('starts exactly once when the body restores before the outer restoration', async () => {
  const stack = await stubRagflow({ ...READY });
  const seed = await readSeedDatasets(stack);
  const docker = fakeDocker();
  const outage = ragflowOutage(docker.run, stack, seed, QUICK);
  let restartMs: number | undefined;

  const value = await duringRagflowOutage(outage, async () => {
    restartMs = await outage.restore();
    return 'done';
  });

  expect(value).toBe('done');
  expect(restartMs).toBeGreaterThanOrEqual(0);
  expect(await outage.restore()).toBeUndefined();
  expect(docker.calls).toEqual([...STOPPED, 'start ragflow-cpu-id']);
});

const ENV_SECRET = 'PLATFORM_SECRET_SENTINEL=env-secret-nonce';
const FAILED_INSPECTIONS: [string, () => Promise<DockerCommandResult>][] = [
  [
    'a command error after a partial write',
    () =>
      Promise.resolve({
        status: null,
        stdout: `{"env":["${ENV_SECRET}"`,
        stderr: ENV_SECRET,
        error: new Error(`spawnSync docker ENOBUFS ${ENV_SECRET}`),
      }),
  ],
  [
    'a nonzero status',
    () => Promise.resolve({ status: 1, stdout: `["${ENV_SECRET}"]`, stderr: ENV_SECRET }),
  ],
  [
    'malformed JSON',
    () => Promise.resolve({ status: 0, stdout: `{"env":["${ENV_SECRET}"]`, stderr: '' }),
  ],
  ['a rejected command', () => Promise.reject(new Error(`docker failed ${ENV_SECRET}`))],
];

it.each(FAILED_INSPECTIONS)(
  'reports %s as the fixed endpoint failure, without the output or a cause',
  async (_label, command) => {
    const error: unknown = await instancePlatformEndpoint(command, '7').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Platform endpoint on the employee bridge unavailable');
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain('env-secret-nonce');
  },
);

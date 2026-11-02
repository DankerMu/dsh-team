import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { SEED_DATASETS, runSeedStack } from '../../scripts/seed-stack.mjs';
import {
  EXPECTED_RAGFLOW_VERSION,
  STACK_CONFIG_RELATIVE_PATH,
  assessSeedPrerequisites,
  configuredStack,
} from '../../scripts/test-stack-prerequisites.mjs';

interface FakeDoc {
  id: string;
  name: string;
  run: string | number;
  chunks: number;
  queue: string[];
}
interface FakeDataset {
  id: string;
  name: string;
  embedding: string;
  docs: FakeDoc[];
}
interface Logged {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  json?: unknown;
  files?: { name: string; bytes: Buffer }[];
}
interface Reply {
  status: number;
  body: unknown;
}
interface Fake {
  datasets: FakeDataset[];
  version: string;
  embedding: string;
  parseOutcome: string[];
  createdName: (name: string) => string;
  override: (entry: Logged) => Reply | undefined;
}
interface Options {
  argv?: (url: string) => string[];
  config?: (url: string) => string | null;
  mode?: number;
  parseDeadline?: number;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const [ragflowKey, embeddingKey, progressSentinel] = [randomUUID(), randomUUID(), randomUUID()];
const MODEL = 'text-embedding-3-small@OpenAI';
const [POLICIES, PRODUCTS, MINUTES] = SEED_DATASETS.map(({ name }) => name) as [
  string,
  string,
  string,
];
const ATTENDANCE = 'attendance-policy.txt';
const EXPENSE = 'expense-policy.txt';
const COMPLETE = 'seed:stack complete\n';
const settings = (url: string) =>
  JSON.stringify({ ragflowUrl: url, ragflowApiKey: ragflowKey, embeddingApiKey: embeddingKey });
const seedBytes = (dataset: string, file: string) =>
  readFileSync(join(root, 'scripts/seed-stack', dataset, file));
const line = (name: string, state: string, uploaded: number, parsed: number) =>
  `${name}: ${state}; uploaded ${String(uploaded)}; parsed ${String(parsed)}; documents 2; ` +
  `chunks 2; done 2; failed 0; embedding ${MODEL}\n`;
const doc = (name: string, run: string | number, queue: string[] = []): FakeDoc => ({
  id: randomUUID(),
  name,
  run,
  chunks: run === 'DONE' ? 1 : 0,
  queue,
});
const dataset = (name: string, docs: FakeDoc[] = [], embedding = MODEL): FakeDataset => ({
  id: randomUUID(),
  name,
  embedding,
  docs,
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closers.splice(0)) await close();
});

function summary(set: FakeDataset) {
  const count = (run: string) => set.docs.filter((item) => item.run === run).length;
  return {
    id: set.id,
    name: set.name,
    embedding_model: set.embedding,
    document_count: set.docs.length,
    chunk_count: set.docs.reduce((total, item) => total + item.chunks, 0),
    done_count: count('DONE'),
    fail_count: count('FAIL'),
    running_count: count('RUNNING'),
  };
}

function listDocuments(set: FakeDataset): Reply {
  for (const item of set.docs) {
    const next = item.queue.shift();
    if (next !== undefined) item.run = next;
    if (item.run === 'DONE') item.chunks = 1;
  }
  const docs = set.docs.map(({ id, name, run, chunks }) => ({
    id,
    name,
    run,
    chunk_count: chunks,
    progress_msg: progressSentinel,
  }));
  return { status: 200, body: { code: 0, data: { docs, total_datasets: 1 } } };
}

// Each part's bytes are kept exactly: latin1 maps every byte to one code unit and back.
function multipart(body: Buffer, type: string) {
  const boundary = `--${/boundary=(.+)$/.exec(type)?.[1] ?? ''}`;
  return body
    .toString('latin1')
    .split(boundary)
    .slice(1, -1)
    .map((part) => {
      const [head = '', content = ''] = part.split('\r\n\r\n', 2);
      const field = /name="([^"]*)"/.exec(head)?.[1];
      const name = /filename="([^"]*)"/.exec(head)?.[1] ?? '';
      return { field, name, bytes: Buffer.from(content.replace(/\r\n$/, ''), 'latin1') };
    });
}

function upload(set: FakeDataset, entry: Logged): Reply {
  entry.files ??= [];
  const created = entry.files.map(({ name }) => doc(name, 'UNSTART'));
  set.docs.push(...created);
  return {
    status: 200,
    body: { code: 0, data: created.map(({ id, name, run }) => ({ id, name, run })) },
  };
}

function parse(fake: Fake, set: FakeDataset, entry: Logged): Reply {
  const ids = (entry.json as { document_ids: string[] }).document_ids;
  for (const item of set.docs.filter(({ id }) => ids.includes(id))) {
    item.run = 'RUNNING';
    item.queue = [...fake.parseOutcome];
  }
  return { status: 200, body: { code: 0 } };
}

function datasets(fake: Fake, entry: Logged): Reply {
  if (entry.method === 'POST') {
    const name = (entry.json as { name: string }).name;
    const set = dataset(fake.createdName(name), [], fake.embedding);
    fake.datasets.push(set);
    return { status: 200, body: { code: 0, data: { ...summary(set), chunk_method: 'naive' } } };
  }
  if (entry.query.has('name'))
    return { status: 200, body: { code: 102, message: "The dataset doesn't exist" } };
  const id = entry.query.get('id');
  const data = fake.datasets.filter((set) => id === null || set.id === id).map(summary);
  return { status: 200, body: { code: 0, data, total_datasets: data.length } };
}

function route(fake: Fake, entry: Logged): Reply {
  const override = fake.override(entry);
  if (override !== undefined) return override;
  if (entry.path === '/api/v1/system/version')
    return { status: 200, body: { code: 0, data: fake.version, message: 'success' } };
  if (entry.path === '/api/v1/datasets') return datasets(fake, entry);
  const [, id, kind] = /^\/api\/v1\/datasets\/([^/]+)\/(documents|chunks)$/.exec(entry.path) ?? [];
  const set = fake.datasets.find((item) => item.id === id);
  if (set === undefined) return { status: 404, body: { code: 404 } };
  if (kind === 'chunks' && entry.method === 'POST') return parse(fake, set, entry);
  if (entry.method === 'POST') return upload(set, entry);
  return listDocuments(set);
}

async function handle(
  fake: Fake,
  log: Logged[],
  message: IncomingMessage,
  response: ServerResponse,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(message.url ?? '/', 'http://fake');
  const type = message.headers['content-type'] ?? '';
  const entry: Logged = {
    method: message.method ?? '',
    path: url.pathname,
    query: url.searchParams,
    authorization: message.headers.authorization,
    ...(type.startsWith('application/json')
      ? { json: JSON.parse(body.toString()) as unknown }
      : {}),
  };
  if (type.startsWith('multipart/form-data'))
    entry.files = multipart(body, type).map(({ field, name, bytes }) => {
      expect(field).toBe('file');
      return { name, bytes };
    });
  log.push(entry);
  const reply = route(fake, entry);
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

async function start(overrides: Partial<Fake> = {}) {
  const fake: Fake = {
    datasets: [],
    version: EXPECTED_RAGFLOW_VERSION,
    embedding: MODEL,
    parseOutcome: ['RUNNING', 'DONE'],
    createdName: (name) => name,
    override: () => undefined,
    ...overrides,
  };
  const log: Logged[] = [];
  const counter = { connections: 0 };
  const server: Server = createServer((message, response) => {
    void handle(fake, log, message, response);
  });
  server.on('connection', () => (counter.connections += 1));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const home = await mkdtemp(join(tmpdir(), 'dsh-team-seed-home-'));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(home, { recursive: true, force: true });
  });
  return {
    fake,
    log,
    counter,
    url,
    home,
    run: (options: Options = {}) => run(fake, log, url, home, options),
  };
}

async function writeSettings(home: string, url: string, options: Options) {
  const content = (options.config ?? settings)(url);
  const file = join(home, STACK_CONFIG_RELATIVE_PATH);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await rm(file, { force: true });
  if (content === null) return;
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, options.mode ?? 0o600);
}

async function run(fake: Fake, log: Logged[], url: string, home: string, options: Options) {
  vi.stubEnv('HOME', home);
  await writeSettings(home, url, options);
  const [stdout, stderr, sleeps]: [string[], string[], number[]] = [[], [], []];
  let clock = 0;
  const from = log.length;
  const code = await runSeedStack({
    argv: options.argv?.(url) ?? [],
    home,
    uid: process.getuid?.() ?? -1,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => (clock += 1000),
    parseDeadline: options.parseDeadline ?? 600_000,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const output = stdout.join('') + stderr.join('') + String(code);
  const ids = fake.datasets.flatMap((set) => [set.id, ...set.docs.map(({ id }) => id)]);
  const port = new URL(url).host;
  for (const secret of [url, port, ragflowKey, embeddingKey, progressSentinel, ...ids])
    expect(output).not.toContain(secret);
  const requests = log.slice(from);
  expect(JSON.stringify(requests)).not.toContain(embeddingKey);
  for (const { path, authorization } of requests)
    expect(authorization).toBe(
      path === '/api/v1/system/version' ? undefined : `Bearer ${ragflowKey}`,
    );
  expect(sleeps.every((ms) => ms === 2000)).toBe(true);
  return {
    code,
    stdout,
    stderr,
    sleeps,
    requests,
    posts: requests.filter((r) => r.method === 'POST'),
  };
}

const datasetPosts = (requests: Logged[]) =>
  requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/datasets');
const uploads = (requests: Logged[]) =>
  requests.filter((r) => r.method === 'POST' && r.path.endsWith('/documents'));
const parses = (requests: Logged[]) =>
  requests.filter((r) => r.method === 'POST' && r.path.endsWith('/chunks'));
const parsedIds = (requests: Logged[]) =>
  parses(requests).flatMap((r) => (r.json as { document_ids: string[] }).document_ids);
const idOf = (fake: Fake, set: string, file: string) =>
  fake.datasets.find(({ name }) => name === set)?.docs.find(({ name }) => name === file)?.id;
const failure = (code: number, stderr: string[], text: string) => {
  expect({ code, stderr }).toEqual({ code: 1, stderr: [`seed:stack ${text}\n`] });
};

it('seeds an empty stack once, then a second run sends no POST and reports identical counts', async () => {
  const stack = await start();
  const first = await stack.run();

  expect(first).toMatchObject({ code: 0, stderr: [] });
  expect(first.stdout).toEqual([
    ...SEED_DATASETS.map(({ name }) => line(name, 'created', 2, 2)),
    COMPLETE,
  ]);
  const lists = first.requests.filter(
    (r) => r.method === 'GET' && r.path === '/api/v1/datasets' && !r.query.has('id'),
  );
  expect(lists.map((r) => r.query.toString())).toEqual([
    'page_size=100&include_parsing_status=true',
  ]);
  expect(first.requests.some((r) => r.query.has('name'))).toBe(false);
  expect(datasetPosts(first.requests).map((r) => r.json)).toEqual(
    SEED_DATASETS.map(({ name }) => ({ name })),
  );
  expect(
    uploads(first.requests).map((r) => r.files?.map(({ name, bytes }) => [name, bytes])),
  ).toEqual(
    SEED_DATASETS.map(({ name, files }) => files.map((file) => [file, seedBytes(name, file)])),
  );
  expect(parses(first.requests).map((r) => r.json)).toEqual(
    SEED_DATASETS.map(({ name, files }) => ({
      document_ids: files.map((file) => idOf(stack.fake, name, file)),
    })),
  );

  const second = await stack.run();
  expect(second).toMatchObject({ code: 0, stderr: [], sleeps: [], posts: [] });
  expect(second.stdout).toEqual([
    ...SEED_DATASETS.map(({ name }) => line(name, 'existing', 0, 0)),
    COMPLETE,
  ]);
});

it('uploads and parses only the missing document of a partially seeded dataset', async () => {
  const done = doc(ATTENDANCE, 'DONE');
  const stack = await start({ datasets: [dataset(POLICIES, [done])] });
  const result = await stack.run();

  expect(result).toMatchObject({ code: 0, stderr: [] });
  expect(result.stdout[0]).toBe(line(POLICIES, 'existing', 1, 1));
  expect(datasetPosts(result.requests).map((r) => r.json)).toEqual([
    { name: PRODUCTS },
    { name: MINUTES },
  ]);
  expect(uploads(result.requests)[0]?.files?.map(({ name }) => name)).toEqual([EXPENSE]);
  expect(parses(result.requests)[0]?.json).toEqual({
    document_ids: [idOf(stack.fake, POLICIES, EXPENSE)],
  });
  expect(parsedIds(result.requests)).not.toContain(done.id);
});

it('reparses a FAIL residue and reports a repeated failure by dataset and file only', async () => {
  const failed = doc(ATTENDANCE, 'FAIL');
  const done = doc(EXPENSE, 'DONE');
  const stack = await start({
    datasets: [dataset(POLICIES, [failed, done])],
    parseOutcome: ['FAIL'],
  });
  const result = await stack.run();

  failure(result.code, result.stderr, `failed: parsing failed for ${POLICIES}/${ATTENDANCE}`);
  expect(result.posts.map((r) => r.json)).toEqual([{ document_ids: [failed.id] }]);
  expect(result.requests.some((r) => r.method === 'DELETE' || r.path.includes('stop'))).toBe(false);
});

it('waits for a RUNNING residue without triggering it again', async () => {
  const running = doc(ATTENDANCE, 'RUNNING', ['RUNNING', 'DONE']);
  const stack = await start({ datasets: [dataset(POLICIES, [running, doc(EXPENSE, 'DONE')])] });
  const result = await stack.run();

  expect(result).toMatchObject({ code: 0, stderr: [] });
  expect(result.stdout[0]).toBe(line(POLICIES, 'existing', 0, 0));
  expect(parsedIds(result.requests)).not.toContain(running.id);
  expect(parses(result.requests)).toHaveLength(2);
});

it('fails when parsing is cancelled after the parse request', async () => {
  const stack = await start({ parseOutcome: ['CANCEL'] });
  const result = await stack.run();

  failure(
    result.code,
    result.stderr,
    `failed: parsing was cancelled for ${POLICIES}/${ATTENDANCE}`,
  );
  expect(uploads(result.requests)).toHaveLength(1);
});

it('treats the numeric run state 0 as UNSTART', async () => {
  const docs = [doc(ATTENDANCE, '0'), doc(EXPENSE, 0)];
  const stack = await start({ datasets: [dataset(POLICIES, docs)] });
  const result = await stack.run();

  expect(result).toMatchObject({ code: 0, stderr: [] });
  expect(result.stdout[0]).toBe(line(POLICIES, 'existing', 0, 2));
  expect(parses(result.requests)[0]?.json).toEqual({ document_ids: docs.map(({ id }) => id) });
});

it.each<[string, (url: string) => string[]]>([
  ['the configured address', (url) => [url]],
  ['the configured address with a trailing slash', (url) => [`${url}/`]],
])('accepts %s as the positional argument', async (_name, argv) => {
  const result = await (await start()).run({ argv });
  expect(result).toMatchObject({ code: 0, stderr: [] });
});

it.each<[string, (url: string) => string[]]>([
  ['localhost', (url) => [url.replace('127.0.0.1', 'localhost')]],
  ['a different case', (url) => [url.replace('http', 'HTTP')]],
  ['a different port', (url) => [`http://127.0.0.1:${String(Number(new URL(url).port) + 1)}`]],
])('refuses %s before any network request', async (_name, argv) => {
  const stack = await start();
  const result = await stack.run({ argv });
  failure(result.code, result.stderr, 'refused: address does not match the private configuration');
  expect(stack.counter.connections).toBe(0);
});

it.each<[string, Options, string]>([
  ['two positional arguments', { argv: () => ['a', 'b'] }, 'usage: pnpm seed:stack [<ragflowUrl>]'],
  [
    'a missing configuration',
    { config: () => null },
    'prerequisite failed: private configuration missing',
  ],
  ['a 0644 configuration', { mode: 0o644 }, 'prerequisite failed: private configuration invalid'],
])('rejects %s without any connection', async (_name, options, text) => {
  const stack = await start();
  const result = await stack.run(options);
  failure(result.code, result.stderr, text);
  expect(stack.counter.connections).toBe(0);
});

it('rejects an unexpected stack version after only the version probe', async () => {
  const stack = await start({ version: 'v1.0.0-rc3' });
  const result = await stack.run();
  failure(
    result.code,
    result.stderr,
    'prerequisite failed: RAGFlow test stack version is v1.0.0-rc3, expected v1.0.0-rc2',
  );
  expect(result.requests.map(({ method, path }) => [method, path])).toEqual([
    ['GET', '/api/v1/system/version'],
  ]);
});

const api = (reply: Reply) => (entry: Logged) =>
  entry.path === '/api/v1/system/version' ? undefined : reply;
const many = (count: number, make: (index: number) => string) =>
  Array.from({ length: count }, (_value, index) => make(index));

it.each<[string, Partial<Fake>, string]>([
  [
    'HTTP 401',
    { override: api({ status: 401, body: { code: 401, message: 'Invalid access token' } }) },
    'failed: RAGFlow rejected the configured key',
  ],
  [
    'HTTP 200 with code 102',
    { override: api({ status: 200, body: { code: 102, message: progressSentinel } }) },
    'failed: RAGFlow list datasets request failed (HTTP 200, code 102)',
  ],
  [
    'two datasets with the same name',
    { datasets: [dataset(POLICIES), dataset(POLICIES)] },
    `failed: dataset ${POLICIES} is ambiguous`,
  ],
  [
    'a dataset name differing only in case',
    { datasets: [dataset('DSH-Team-Seed-Minutes')] },
    `failed: dataset ${MINUTES} collides with an existing name`,
  ],
  [
    'a document name differing only in case',
    { datasets: [dataset(POLICIES, [doc('Attendance-Policy.txt', 'DONE')])] },
    `failed: document ${ATTENDANCE} in ${POLICIES} collides with an existing name`,
  ],
  [
    'a duplicated document',
    { datasets: [dataset(POLICIES, [doc(EXPENSE, 'DONE'), doc(EXPENSE, 'DONE')])] },
    `failed: document ${EXPENSE} in ${POLICIES} is duplicated`,
  ],
  [
    'a full dataset listing',
    { datasets: many(100, (index) => `other-${String(index)}`).map((name) => dataset(name)) },
    'failed: RAGFlow list datasets listing is full',
  ],
  [
    'a full document listing',
    {
      datasets: [
        dataset(
          POLICIES,
          many(100, (i) => `other-${String(i)}.txt`).map((n) => doc(n, 'DONE')),
        ),
      ],
    },
    'failed: RAGFlow list documents listing is full',
  ],
])('rejects %s before any POST', async (_name, overrides, text) => {
  const result = await (await start(overrides)).run();
  failure(result.code, result.stderr, text);
  expect(result.posts).toEqual([]);
});

it.each<[string, Partial<Fake>, string]>([
  [
    'a dataset created under a suffixed name',
    { createdName: (name) => `${name}(1)` },
    `failed: dataset ${POLICIES} was created as a different name`,
  ],
  [
    'a dataset without an embedding model',
    { embedding: '' },
    `failed: dataset ${POLICIES} has no embedding model; set the tenant default in the RAGFlow UI`,
  ],
])('rejects %s before any upload', async (_name, overrides, text) => {
  const result = await (await start(overrides)).run();
  failure(result.code, result.stderr, text);
  expect(result.posts.map((r) => r.json)).toEqual([{ name: POLICIES }]);
});

it('stops polling at the parse deadline with the fixed 600s line', async () => {
  const result = await (await start({ parseOutcome: [] })).run({ parseDeadline: 1 });
  failure(result.code, result.stderr, 'failed: parsing did not finish within 600s');
  expect(result.requests.some((r) => r.method === 'DELETE' || r.path.includes('stop'))).toBe(false);
});

it('ships exactly three datasets of two small numbered UTF-8 seed files', () => {
  const codes = ['POL', 'PRD', 'MIN'];
  expect(SEED_DATASETS.map(({ name, files }) => [name, files.length])).toEqual([
    [POLICIES, 2],
    [PRODUCTS, 2],
    [MINUTES, 2],
  ]);
  SEED_DATASETS.forEach(({ name, files }, index) => {
    files.forEach((file, position) => {
      const bytes = seedBytes(name, file);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const lines = text.trimEnd().split('\n');
      expect(statSync(join(root, 'scripts/seed-stack', name, file)).size).toBeLessThanOrEqual(2048);
      expect(lines.length).toBeGreaterThanOrEqual(6);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines[0]).toBe(`文档编号：SEED-${String(codes[index])}-0${String(position + 1)}`);
    });
  });
});

it('projects the configured stack and assesses only configuration and version', () => {
  const value = JSON.parse(settings('http://127.0.0.1:19380/')) as unknown;
  const config = { present: true, value } as const;
  const stack = { ragflowUrl: 'http://127.0.0.1:19380', ragflowApiKey: ragflowKey };
  const version = (data: string) => ({ status: 200, body: JSON.stringify({ code: 0, data }) });

  expect(configuredStack(config)).toEqual(stack);
  expect(configuredStack({ present: false })).toBeUndefined();
  expect(configuredStack('invalid')).toBeUndefined();
  expect(assessSeedPrerequisites({ config: { present: false } })).toEqual({
    ok: false,
    reason: 'private configuration missing',
  });
  expect(assessSeedPrerequisites({ config: 'invalid' })).toEqual({
    ok: false,
    reason: 'private configuration invalid',
  });
  expect(
    assessSeedPrerequisites({
      config: { present: true, value: { ragflowUrl: 'http://localhost' } },
    }),
  ).toEqual({ ok: false, reason: 'private configuration invalid' });
  expect(assessSeedPrerequisites({ config })).toEqual({ ok: undefined, stack });
  expect(assessSeedPrerequisites({ config, version: 'unreachable' })).toEqual({
    ok: false,
    reason: 'RAGFlow test stack unreachable',
  });
  expect(assessSeedPrerequisites({ config, version: version(EXPECTED_RAGFLOW_VERSION) })).toEqual({
    ok: true,
    stack,
  });
});

async function spawnSeed(args: string[], home: string) {
  const child = spawn(process.execPath, ['scripts/seed-stack.mjs', ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, output };
}

it('ends the actual entrypoint with one usage line for two arguments', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-team-seed-empty-'));
  try {
    expect(await spawnSeed(['a', 'b'], home)).toEqual({
      status: 1,
      output: 'seed:stack usage: pnpm seed:stack [<ragflowUrl>]\n',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('refuses a mismatched address in the actual entrypoint without connecting', async () => {
  const stack = await start();
  await writeSettings(stack.home, stack.url, {});
  const mismatch = stack.url.replace('127.0.0.1', 'localhost');

  expect(await spawnSeed([mismatch], stack.home)).toEqual({
    status: 1,
    output: 'seed:stack refused: address does not match the private configuration\n',
  });
  expect(stack.counter.connections).toBe(0);
});

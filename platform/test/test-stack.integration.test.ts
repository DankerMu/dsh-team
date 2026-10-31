import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { readPrivateJsonFile } from '../../scripts/docker-proxy-environment.mjs';
import {
  EXPECTED_RAGFLOW_VERSION,
  MIN_DOCKER_MEM_TOTAL,
  STACK_CONFIG_RELATIVE_PATH,
  assessStackPrerequisites,
} from '../../scripts/test-stack-prerequisites.mjs';
import { probeRagflowVersion, runTestStack } from '../../scripts/test-stack.mjs';
import { retireCleanupJournal } from './docker-cleanup.ts';
import type { CleanupJournalEntry } from './docker-cleanup.ts';
import { createDockerCommands } from './docker-command.ts';
import type { DockerCommandResult } from './docker-command.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
type Cases = Parameters<typeof runTestStack>[0]['spawnCases'];
type Retire = Parameters<typeof runTestStack>[0]['retire'];
interface Scenario {
  env?: NodeJS.ProcessEnv;
  host?: [string, string];
  config?: (url: string) => string | null;
  mode?: number;
  link?: boolean;
  info?: DockerCommandResult;
  handler?: Handler | 'closed';
  deadline?: number;
  spawnCases?: Cases;
  retire?: Retire;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const [ragflowKey, embeddingKey, segment] = [randomUUID(), randomUUID(), randomUUID()];
const FAILED = 'test:stack prerequisite failed: ';
const LOCAL = 'local default Docker daemon required';
const HOST = 'macOS arm64 host required';
const INVALID = 'private configuration invalid';
const UNAVAILABLE = 'local Docker daemon unavailable';
const BELOW = 'docker info MemTotal below 14 GiB';
const UNREACHABLE = 'RAGFlow test stack unreachable';
const MALFORMED = 'RAGFlow test stack version response malformed';
const shown = (version: string) => `RAGFlow test stack version is ${version}, expected v1.0.0-rc2`;
const dockerInfo = (document: unknown, status = 0) => ({
  status,
  stdout: typeof document === 'string' ? document : JSON.stringify(document),
  stderr: '',
});
const linuxInfo = (MemTotal = MIN_DOCKER_MEM_TOTAL) => dockerInfo({ OSType: 'linux', MemTotal });
const settings = (url: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    ragflowUrl: url,
    ragflowApiKey: ragflowKey,
    embeddingApiKey: embeddingKey,
    ...fields,
  });
const reply =
  (data: unknown, code = 0): Handler =>
  (_request, response) =>
    response.end(JSON.stringify({ code, data, message: 'success' }));

const fields = (extra: Record<string, unknown>) => (url: string) => settings(url, extra);
const origin = (select: (url: string) => string) => (url: string) => settings(select(url));
afterEach(() => vi.unstubAllEnvs());

async function serve(handler: Handler | 'closed') {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    if (handler !== 'closed') handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  if (handler === 'closed') await new Promise((done) => server.close(done));
  return { server, requests, url };
}

async function writeSettings(home: string, scenario: Scenario, url: string) {
  const content = (scenario.config ?? settings)(url);
  const file = join(home, STACK_CONFIG_RELATIVE_PATH);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const target = scenario.link === true ? `${file}.target` : file;
  if (content === null) return;
  await writeFile(target, content, { mode: 0o600 });
  await chmod(target, scenario.mode ?? 0o600);
  if (target !== file) await symlink(target, file);
}

async function run(scenario: Scenario) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-team-stack-home-'));
  vi.stubEnv('HOME', home);
  const { server, requests, url } = await serve(
    scenario.handler ?? reply(EXPECTED_RAGFLOW_VERSION),
  );
  await writeSettings(home, scenario, url);
  const docker: { args: readonly string[]; timeout: number }[] = [];
  const stderr: string[] = [];
  const probes: string[] = [];
  let runDir = '';
  let code: number | undefined;
  let thrown = '';
  try {
    code = await runTestStack({
      env: { PATH: process.env.PATH, ...scenario.env },
      platform: scenario.host?.[0] ?? 'darwin',
      arch: scenario.host?.[1] ?? 'arm64',
      repositoryRoot: root,
      dockerCommands: (directory, config) => {
        runDir = dirname(config);
        return createDockerCommands(directory, config, true, (args, timeout) => {
          docker.push({ args, timeout });
          return scenario.info ?? linuxInfo();
        });
      },
      probeVersion: (target) => {
        probes.push(target);
        return probeRagflowVersion(target, scenario.deadline);
      },
      spawnCases: scenario.spawnCases ?? (() => Promise.resolve({ code: 0, signal: null })),
      retire: scenario.retire ?? retireCleanupJournal,
      stderr: (text) => stderr.push(text),
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(home, { recursive: true, force: true });
  }
  for (const secret of [ragflowKey, embeddingKey, segment, url])
    expect(stderr.join('') + String(code) + thrown).not.toContain(secret);
  expect(
    docker.every(
      ({ args, timeout }) => timeout === 30_000 && args.join(' ') === 'info --format {{json .}}',
    ),
  ).toBe(true);
  return { code, stderr, docker, probes, requests, runDir, thrown, url };
}

it.each<[string, Scenario, string]>([
  ['DOCKER_HOST', { env: { DOCKER_HOST: 'tcp://127.0.0.1:1' } }, LOCAL],
  ['DOCKER_CONTEXT', { env: { DOCKER_CONTEXT: 'desktop-linux' } }, LOCAL],
  ['linux/x64', { host: ['linux', 'x64'] }, HOST],
  ['darwin/x64', { host: ['darwin', 'x64'] }, HOST],
  ['linux/arm64', { host: ['linux', 'arm64'] }, HOST],
  ['missing configuration', { config: () => null }, 'private configuration missing'],
  ['0644', { mode: 0o644 }, INVALID],
  ['0640', { mode: 0o640 }, INVALID],
  ['symlink', { link: true }, INVALID],
  ['oversized', { config: () => `{}${' '.repeat(16_383)}` }, INVALID],
  ['invalid JSON', { config: () => `{"ragflowApiKey":"${ragflowKey}"` }, INVALID],
  ['non-object', { config: () => '[]' }, INVALID],
  ['unknown key', { config: fields({ [segment]: 'x' }) }, INVALID],
  ['missing key', { config: fields({ embeddingApiKey: undefined }) }, INVALID],
  ['empty string', { config: fields({ ragflowApiKey: '' }) }, INVALID],
  ['control character', { config: fields({ ragflowApiKey: `${ragflowKey}\u0007` }) }, INVALID],
  ['localhost', { config: origin((url) => url.replace('127.0.0.1', 'localhost')) }, INVALID],
  ['non-loopback IP', { config: origin((url) => url.replace('127.0.0.1', '10.0.0.1')) }, INVALID],
  ['userinfo', { config: origin((url) => url.replace('//', `//${segment}@`)) }, INVALID],
  ['query', { config: origin((url) => `${url}/?${segment}`) }, INVALID],
  ['path', { config: origin((url) => `${url}/${segment}`) }, INVALID],
  ['docker info nonzero', { info: dockerInfo('', 1) }, UNAVAILABLE],
  ['docker info non-JSON', { info: dockerInfo('not json') }, UNAVAILABLE],
  ['non-linux OSType', { info: dockerInfo({ OSType: 'windows', MemTotal: 2 ** 40 }) }, UNAVAILABLE],
  ['missing MemTotal', { info: dockerInfo({ OSType: 'linux' }) }, UNAVAILABLE],
  ['13.9 GiB MemTotal', { info: linuxInfo(14_925_011_353) }, BELOW],
  ['closed port', { handler: 'closed' }, UNREACHABLE],
  ['timeout', { handler: () => undefined, deadline: 200 }, UNREACHABLE],
  ['302', { handler: (_q, s) => s.writeHead(302, { location: '/' }).end() }, UNREACHABLE],
  ['500', { handler: (_q, s) => s.writeHead(500).end() }, UNREACHABLE],
  ['body over 64 KiB', { handler: (_q, s) => s.end(' '.repeat(65_537)) }, UNREACHABLE],
  ['non-JSON body', { handler: (_q, s) => s.end('<html>') }, MALFORMED],
  ['nonzero code', { handler: reply(EXPECTED_RAGFLOW_VERSION, 1) }, MALFORMED],
  ['non-string data', { handler: reply(1) }, MALFORMED],
  ['version suffix', { handler: reply('v1.0.0-rc2-3-gabcdef') }, shown('v1.0.0-rc2-3-gabcdef')],
  ['non-printable version', { handler: reply('v1\u00a00') }, shown('unparseable')],
])('rejects %s before any case or later fact', async (_name, scenario, reason) => {
  const cases = vi.fn<Cases>();
  const result = await run({ ...scenario, spawnCases: cases });
  const probed = reason.startsWith('RAGFlow') ? 1 : 0;

  expect(result).toMatchObject({ code: 1, thrown: '', stderr: [`${FAILED}${reason}\n`] });
  expect(result.probes).toHaveLength(probed);
  expect(result.docker).toHaveLength([UNAVAILABLE, BELOW].includes(reason) ? 1 : probed);
  expect(cases).not.toHaveBeenCalled();
  expect(existsSync(result.runDir)).toBe(false);
});

it('admits exactly 14 GiB and v1.0.0-rc2, runs cases against an empty private journal and retires it', async () => {
  let journal = '';
  const retire = vi.fn<Retire>(() => Promise.resolve());
  const result = await run({
    info: linuxInfo(15_032_385_536),
    config: (url) => settings(`${url}/`),
    spawnCases: (env) => {
      journal = env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '';
      expect(env.DOCKER_CONFIG).toBeUndefined();
      expect(statSync(journal)).toMatchObject({ size: 0, mode: 0o100600 });
      expect(statSync(dirname(journal)).mode & 0o777).toBe(0o700);
      return Promise.resolve({ code: 1, signal: null });
    },
    retire,
  });

  expect(result).toMatchObject({
    code: 1,
    stderr: [],
    probes: [result.url],
  });
  expect(
    result.requests.map(({ method, url, headers }) => [method, url, headers.authorization]),
  ).toEqual([['GET', '/api/v1/system/version', undefined]]);
  expect(journal).toBe(join(result.runDir, 'cleanup.journal'));
  expect(retire.mock.calls[0]?.[0]).toEqual([]);
  expect(existsSync(result.runDir)).toBe(false);
});

it('accepts the bracketed IPv6 loopback address as a literal RAGFlow origin', () => {
  const config = {
    present: true,
    value: JSON.parse(settings('https://[::1]:9380/')) as unknown,
  } as const;
  expect(
    assessStackPrerequisites({
      platform: 'darwin',
      arch: 'arm64',
      config,
      dockerInfo: linuxInfo(),
      version: { status: 200, body: JSON.stringify({ code: 0, data: 'v1.0.0-rc2' }) },
    }),
  ).toEqual({ ok: true, ragflowUrl: 'https://[::1]:9380' });
});

it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('maps an interrupted %s case run to %i after retirement', async (signal, status) => {
  const result = await run({ spawnCases: () => Promise.resolve({ code: null, signal }) });
  expect(result).toMatchObject({ code: status, stderr: [] });
});

it.each<[string, (journal: string) => void, number]>([
  ['a retirement failure', () => undefined, 1],
  [
    'a forged journal row',
    (journal) => {
      appendFileSync(journal, '{"runId":"forged","target":{}}\n');
    },
    0,
  ],
])('retains the run directory after %s', async (_name, write, retireCalls) => {
  const retire = vi.fn<Retire>((_entries, _retirement, failures) => {
    failures.push(new Error(segment));
    return Promise.resolve();
  });
  const result = await run({
    spawnCases: (env) => {
      write(env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '');
      return Promise.resolve({ code: 0, signal: null });
    },
    retire,
  });
  try {
    expect(retire).toHaveBeenCalledTimes(retireCalls);
    expect(result).toMatchObject({
      code: 1,
      stderr: [`test:stack cleanup failed (1); journal retained at ${result.runDir}\n`],
    });
    expect(existsSync(join(result.runDir, 'cleanup.journal'))).toBe(true);
  } finally {
    await rm(result.runDir, { recursive: true, force: true });
  }
});

it('removes nothing of a run that registered the fixed platform without the deployment lock', async () => {
  const runId = randomUUID();
  const failures: string[] = [];
  const result = await run({
    spawnCases: (env) => {
      const ownership = { 'dsh-team.test-run': runId };
      const target = { kind: 'container', name: 'dsh-team-platform', ownership };
      appendFileSync(
        env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '',
        `${JSON.stringify({ runId, target })}\n`,
      );
      return Promise.resolve({ code: 0, signal: null });
    },
    retire: async (entries: readonly CleanupJournalEntry[], retirement, collected) => {
      await retireCleanupJournal(entries, retirement, collected);
      failures.push(...collected.map((error) => (error instanceof Error ? error.message : '')));
    },
  });
  await rm(result.runDir, { recursive: true, force: true });

  expect(failures).toEqual(['deployment lock unavailable in the local lane']);
  expect(result.docker).toHaveLength(1);
  expect(result).toMatchObject({
    code: 1,
    stderr: [`test:stack cleanup failed (1); journal retained at ${result.runDir}\n`],
  });
});

it('reads only an owned private file and reports absence separately', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-team-stack-reader-'));
  const file = join(home, 'stack.json');
  const uid = process.getuid?.() ?? 0;
  try {
    expect(readPrivateJsonFile(file, uid)).toEqual({ present: false });
    await writeFile(file, `{"key":"${ragflowKey}"}`, { mode: 0o600 });
    expect(readPrivateJsonFile(file, uid)).toEqual({ present: true, value: { key: ragflowKey } });
    expect(() => readPrivateJsonFile(file, uid + 1)).toThrow(
      /^Private configuration file invalid$/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('fails the actual entrypoint on a remote Docker selection with one fixed line', async () => {
  const child = spawn(process.execPath, ['scripts/test-stack.mjs'], {
    cwd: root,
    env: { ...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const [status] = (await once(child, 'close')) as [number | null];

  expect({ status, output }).toEqual({
    status: 1,
    output: `${FAILED}${LOCAL}\n`,
  });
});

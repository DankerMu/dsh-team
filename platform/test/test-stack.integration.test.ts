import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
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
import { probeRagflowVersion, runTestStack, spawnCases } from '../../scripts/test-stack.mjs';
import type * as RecordModule from '../../scripts/trusted-docker-record.mjs';
import { OWNER_LABEL, retireCleanupJournal } from './docker-cleanup.ts';
import { createDockerCommands } from './docker-command.ts';
import type { DockerCommandResult } from './docker-command.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
type Cases = Parameters<typeof runTestStack>[0]['spawnCases'];
type Retire = Parameters<typeof runTestStack>[0]['retire'];
type Lock = Parameters<typeof runTestStack>[0]['acquireLock'];
interface Scenario {
  env?: NodeJS.ProcessEnv;
  host?: [string, string];
  config?: (url: string) => string | null;
  mode?: number;
  link?: boolean;
  info?: DockerCommandResult;
  compose?: DockerCommandResult;
  buildx?: DockerCommandResult;
  python?: boolean;
  chromium?: boolean;
  answer?: (args: readonly string[]) => DockerCommandResult | undefined;
  handler?: Handler | 'closed';
  deadline?: number;
  spawnCases?: Cases;
  retire?: Retire;
  acquireLock?: Lock;
}

// Group settlement is the real exported observer unless a case makes it throw.
const settlement = vi.hoisted(() => ({ fail: false }));
vi.mock('../../scripts/trusted-docker-record.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof RecordModule>();
  return {
    ...original,
    groupSettlesAfterClose: (pid: number) =>
      settlement.fail
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }))
        : original.groupSettlesAfterClose(pid),
  };
});

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
const COMPOSE = 'docker compose 2.33.1 or newer required';
const BUILDX = 'docker buildx unavailable';
const PYTHON = '/usr/bin/python3 with fcntl required';
const CHROMIUM = 'playwright chromium not installed; run pnpm test:ui:install';
const PREREQUISITE_DOCKER = [
  'info --format {{json .}}',
  'compose version --short',
  'buildx version',
];
const INVENTORY =
  /^(container ls --all|network ls|volume ls|image ls --all) --quiet( --no-trunc)? --filter label=dsh-team\.test-run=[a-f0-9-]{36}$/;
const runLine = (directory: string) => `test:stack run directory ${directory}\n`;
const UNSETTLED = (directory: string) =>
  `test:stack case processes unsettled; journal retained at ${directory}\n`;
const settled = (code: number | null, signal: NodeJS.Signals | null = null) =>
  Promise.resolve({ code, signal, settled: true });
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
afterEach(() => {
  vi.unstubAllEnvs();
  settlement.fail = false;
});

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

async function run(scenario: Scenario, stderr: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-team-stack-home-'));
  vi.stubEnv('HOME', home);
  const { server, requests, url } = await serve(
    scenario.handler ?? reply(EXPECTED_RAGFLOW_VERSION),
  );
  await writeSettings(home, scenario, url);
  const docker: { args: readonly string[]; timeout: number }[] = [];
  const probes: string[] = [];
  const pythonProbes: number[] = [];
  const chromiumProbes: number[] = [];
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
          // A scenario's own answers are its evidence; only the rest must be prerequisites/inventory.
          const answered = scenario.answer?.(args);
          if (answered !== undefined) return answered;
          docker.push({ args, timeout });
          if (args[0] === 'compose') return scenario.compose ?? dockerInfo('2.40.3-desktop.1\n');
          if (args[0] === 'buildx')
            return scenario.buildx ?? dockerInfo('github.com/docker/buildx v0.30.1-desktop.1\n');
          if (args.includes('ls')) return dockerInfo('');
          return scenario.info ?? linuxInfo();
        });
      },
      probeVersion: (target) => {
        probes.push(target);
        return probeRagflowVersion(target, scenario.deadline);
      },
      probePython: () => {
        pythonProbes.push(1);
        return scenario.python ?? true;
      },
      probeChromium: () => {
        chromiumProbes.push(1);
        return scenario.chromium ?? true;
      },
      spawnCases: scenario.spawnCases ?? (() => settled(0)),
      retire: scenario.retire ?? retireCleanupJournal,
      // No test ever reaches the host-wide deployment lock file.
      acquireLock: scenario.acquireLock ?? (() => Promise.resolve(() => Promise.resolve())),
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
      ({ args, timeout }) =>
        timeout === 30_000 &&
        (PREREQUISITE_DOCKER.includes(args.join(' ')) || INVENTORY.test(args.join(' '))),
    ),
  ).toBe(true);
  return {
    code,
    stderr,
    docker,
    probes,
    pythonProbes,
    chromiumProbes,
    requests,
    runDir,
    thrown,
    url,
  };
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
  ['missing compose plugin', { compose: dockerInfo('', 1) }, COMPOSE],
  ['compose 2.33.0', { compose: dockerInfo('2.33.0\n') }, COMPOSE],
  ['unparseable compose version', { compose: dockerInfo('compose\n') }, COMPOSE],
  ['buildx nonzero', { buildx: dockerInfo('', 1) }, BUILDX],
  ['python3 without fcntl', { python: false }, PYTHON],
  ['missing pinned Playwright Chromium', { chromium: false }, CHROMIUM],
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
  const dockerCalls =
    { [UNAVAILABLE]: 1, [BELOW]: 1, [COMPOSE]: 2, [BUILDX]: 3, [PYTHON]: 3, [CHROMIUM]: 3 }[
      reason
    ] ?? 3 * probed;

  expect(result).toMatchObject({ code: 1, thrown: '', stderr: [`${FAILED}${reason}\n`] });
  expect(result.probes).toHaveLength(probed);
  expect(result.docker).toHaveLength(dockerCalls);
  expect(result.pythonProbes).toHaveLength(reason === PYTHON || reason === CHROMIUM ? 1 : probed);
  expect(result.chromiumProbes).toHaveLength(reason === CHROMIUM ? 1 : probed);
  expect(cases).not.toHaveBeenCalled();
  expect(existsSync(result.runDir)).toBe(false);
});

it('admits exactly 14 GiB and v1.0.0-rc2, runs cases against an empty private journal and retires it', async () => {
  let journal = '';
  const retire = vi.fn<Retire>(() => Promise.resolve());
  const stderr: string[] = [];
  const result = await run(
    {
      info: linuxInfo(15_032_385_536),
      compose: dockerInfo('2.33.1\n'),
      config: (url) => settings(`${url}/`),
      spawnCases: (env) => {
        journal = env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '';
        expect(env.DOCKER_CONFIG).toBeUndefined();
        expect(statSync(journal)).toMatchObject({ size: 0, mode: 0o100600 });
        expect(statSync(dirname(journal)).mode & 0o777).toBe(0o700);
        // The run directory is announced before any case output.
        expect(stderr).toEqual([runLine(dirname(journal))]);
        return settled(1);
      },
      retire,
    },
    stderr,
  );

  expect(result).toMatchObject({
    code: 1,
    stderr: [runLine(result.runDir)],
    probes: [result.url],
  });
  expect(result.docker.map(({ args }) => args.join(' '))).toEqual(PREREQUISITE_DOCKER);
  expect(result.pythonProbes).toHaveLength(1);
  expect(result.chromiumProbes).toHaveLength(1);
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
      compose: dockerInfo('2.40.3-desktop.1\n'),
      buildx: dockerInfo('github.com/docker/buildx v0.30.1-desktop.1\n'),
      python: true,
      chromium: true,
      version: { status: 200, body: JSON.stringify({ code: 0, data: 'v1.0.0-rc2' }) },
    }),
  ).toEqual({ ok: true, ragflowUrl: 'https://[::1]:9380' });
});

it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('maps an interrupted %s case run to %i after retirement', async (signal, status) => {
  const result = await run({ spawnCases: () => settled(null, signal) });
  expect(result).toMatchObject({ code: status, stderr: [runLine(result.runDir)] });
  expect(existsSync(result.runDir)).toBe(false);
});

it('retires only after the signalled case runner itself closes, including its late registration', async () => {
  const runId = randomUUID();
  const target = {
    kind: 'container',
    name: 'dsh-team-late',
    ownership: { 'dsh-team.test-run': runId },
  };
  const row = JSON.stringify({ runId, target });
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-stack-marker-'));
  const marker = join(directory, 'ready');
  const child = String.raw`const fs=require('node:fs');const [marker,row]=process.argv.slice(1);
    process.on('SIGTERM',()=>setTimeout(()=>{
      fs.appendFileSync(process.env.DSH_TEAM_CI_RESOURCE_JOURNAL,row+'\n');process.exit(0);},300));
    setTimeout(()=>process.exit(2),10000);fs.writeFileSync(marker,'ready');`;
  const listeners = process.listenerCount('SIGTERM');
  const retire = vi.fn<Retire>(() => Promise.resolve());
  try {
    const pending = run({
      spawnCases: (env, cwd) =>
        spawnCases(env, cwd, { file: process.execPath, args: ['-e', child, marker, row] }),
      retire,
    });
    await vi.waitFor(
      () => {
        expect(existsSync(marker)).toBe(true);
      },
      { timeout: 5000 },
    );
    process.emit('SIGTERM', 'SIGTERM');
    const result = await pending;

    expect(result).toMatchObject({ code: 143, stderr: [runLine(result.runDir)] });
    expect(retire.mock.calls[0]?.[0]).toEqual([{ runId, target }]);
    expect(existsSync(result.runDir)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('records an EPERM-refused group SIGTERM and still settles through the group observation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-stack-eperm-'));
  const [marker, go] = [join(directory, 'ready'), join(directory, 'go')];
  // The refused group signal never reaches the runner: it exits only once told to, after it.
  const child = String.raw`const fs=require('node:fs');const [marker,go]=process.argv.slice(1);
    setInterval(()=>{if(fs.existsSync(go))process.exit(0);},20);
    setTimeout(()=>process.exit(2),10000);fs.writeFileSync(marker,'ready');`;
  const listeners = process.listenerCount('SIGTERM');
  const retire = vi.fn<Retire>(() => Promise.resolve());
  const kill = process.kill.bind(process);
  // Darwin's answer for a group of unreaped zombies; group observation (signal 0) stays real.
  const refused = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM')
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  try {
    const pending = run({
      spawnCases: (env, cwd) =>
        spawnCases(env, cwd, { file: process.execPath, args: ['-e', child, marker, go] }),
      retire,
    });
    await vi.waitFor(
      () => {
        expect(existsSync(marker)).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(() => process.emit('SIGTERM', 'SIGTERM')).not.toThrow();
    await writeFile(go, '');
    const result = await pending;

    expect(refused).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(refused.mock.calls.find(([, signal]) => signal === 'SIGTERM')?.[0]).toBeLessThan(0);
    expect(result).toMatchObject({ code: 143, stderr: [runLine(result.runDir)] });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(existsSync(result.runDir)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  } finally {
    refused.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
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
      return settled(0);
    },
    retire,
  });
  try {
    expect(retire).toHaveBeenCalledTimes(retireCalls);
    expect(result).toMatchObject({
      code: 1,
      stderr: [
        runLine(result.runDir),
        `test:stack cleanup failed (1); journal retained at ${result.runDir}\n`,
      ],
    });
    expect(existsSync(join(result.runDir, 'cleanup.journal'))).toBe(true);
  } finally {
    await rm(result.runDir, { recursive: true, force: true });
  }
});

it('retires a registered fixed platform only under the injected deployment lock', async () => {
  const runId = randomUUID();
  const order: string[] = [];
  const platformId = 'e'.repeat(64);
  let present = true;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const result = await run({
    spawnCases: (env) => {
      const ownership = { [OWNER_LABEL]: runId };
      const target = { kind: 'container', name: 'dsh-team-platform', ownership };
      appendFileSync(
        env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '',
        `${JSON.stringify({ runId, target })}\n`,
      );
      return settled(0);
    },
    acquireLock: () => {
      order.push('lock');
      return Promise.resolve(() => {
        order.push('release');
        return Promise.resolve();
      });
    },
    answer: (args) => {
      if (args[0] !== 'container' || args[1] === 'ls') return undefined;
      order.push(args.join(' '));
      if (!present)
        return {
          status: 1,
          stdout: '',
          stderr: `Error: No such container: ${String(args.at(-1))}\n`,
        };
      if (args[1] === 'rm') {
        present = false;
        return ok();
      }
      if (args.includes('--format')) return ok(`${runId}\n`);
      const document = {
        Id: platformId,
        Name: '/dsh-team-platform',
        Config: { Labels: { [OWNER_LABEL]: runId } },
        State: { Status: 'created', Running: false, ExitCode: 0, OOMKilled: false },
      };
      return ok(JSON.stringify([document]));
    },
  });

  expect(result).toMatchObject({ code: 0, stderr: [runLine(result.runDir)] });
  expect(order[0]).toBe('lock');
  expect(order.indexOf('container rm --force dsh-team-platform')).toBeGreaterThan(0);
  expect(order.at(-1)).toBe('release');
  expect(present).toBe(false);
  expect(existsSync(result.runDir)).toBe(false);
});

it('retains the journal when the post-retirement label inventory still lists a resource', async () => {
  const runId = randomUUID();
  const inventories: string[] = [];
  const result = await run({
    spawnCases: (env) => {
      const target = {
        kind: 'network',
        name: 'dsh-team-late',
        ownership: { [OWNER_LABEL]: runId },
      };
      appendFileSync(
        env.DSH_TEAM_CI_RESOURCE_JOURNAL ?? '',
        `${JSON.stringify({ runId, target })}\n`,
      );
      return settled(0);
    },
    // The registered name is absent; a daemon-side late creation still carries the label.
    answer: (args) => {
      if (args.includes('ls')) {
        inventories.push(args.join(' '));
        return dockerInfo(args[0] === 'container' ? `${'d'.repeat(64)}\n` : '');
      }
      if (args[0] !== 'network') return undefined;
      return {
        status: 1,
        stdout: '',
        stderr: 'Error response from daemon: network dsh-team-late not found\n',
      };
    },
  });
  try {
    const filter = `--filter label=${OWNER_LABEL}=${runId}`;
    expect(inventories).toEqual([
      `container ls --all --quiet --no-trunc ${filter}`,
      `network ls --quiet --no-trunc ${filter}`,
      `volume ls --quiet ${filter}`,
      `image ls --all --quiet --no-trunc ${filter}`,
    ]);
    expect(result).toMatchObject({
      code: 1,
      stderr: [
        runLine(result.runDir),
        `test:stack cleanup failed (1); journal retained at ${result.runDir}\n`,
      ],
    });
    expect(readFileSync(join(result.runDir, 'cleanup.journal'), 'utf8')).toContain(runId);
  } finally {
    await rm(result.runDir, { recursive: true, force: true });
  }
});

it('retains the journal without reading or retiring it when the case launch rejects', async () => {
  const retire = vi.fn<Retire>(() => Promise.resolve());
  const result = await run({
    spawnCases: () => Promise.reject(new Error('launch failed')),
    retire,
  });
  try {
    expect(result).toMatchObject({
      code: 1,
      stderr: [runLine(result.runDir), UNSETTLED(result.runDir)],
    });
    expect(retire).not.toHaveBeenCalled();
    expect(existsSync(join(result.runDir, 'cleanup.journal'))).toBe(true);
  } finally {
    await rm(result.runDir, { recursive: true, force: true });
  }
});

/**
 * A vitest stand-in that leaves one same-group grandchild: `linger` outlives the settlement
 * window, `timely` exits within it, and `term` exits only on a group SIGTERM.
 */
function standIn(mode: 'linger' | 'timely' | 'term') {
  const grandchild = String.raw`const fs=require('node:fs');const [dir,mode]=process.argv.slice(1);
    process.on('SIGTERM',()=>{fs.writeFileSync(dir+'/term','');process.exit(0);});
    fs.writeFileSync(dir+'/grandchild',String(process.pid));
    setTimeout(()=>process.exit(0),mode==='timely'?300:10000);`;
  const parent = String.raw`const fs=require('node:fs');const {spawn}=require('node:child_process');
    const [dir,mode,grandchild]=process.argv.slice(1);
    spawn(process.execPath,['-e',grandchild,dir,mode],{stdio:'ignore'}).unref();
    fs.writeFileSync(dir+'/stand-in',String(process.pid));
    const ready=setInterval(()=>{if(fs.existsSync(dir+'/grandchild')){clearInterval(ready);process.exit(0);}},20);`;
  return (directory: string): Cases =>
    (env, cwd) =>
      spawnCases(env, cwd, {
        file: process.execPath,
        args: ['-e', parent, directory, mode, grandchild],
      });
}

/** The stand-in's group is owned by its case: retire any lingering member. */
function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function withStandIn(
  run: (directory: string, pid: (name: string) => number) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-stack-group-'));
  const pid = (name: string) => Number(readFileSync(join(directory, name), 'utf8'));
  try {
    await run(directory, pid);
  } finally {
    if (existsSync(join(directory, 'stand-in'))) killGroup(pid('stand-in'));
    await rm(directory, { recursive: true, force: true });
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it('retains the journal and retires nothing while a case grandchild outlives its runner', async () => {
  await withStandIn(async (directory) => {
    const retire = vi.fn<Retire>(() => Promise.resolve());
    const listeners = process.listenerCount('SIGTERM');
    const result = await run({ spawnCases: standIn('linger')(directory), retire });
    try {
      expect(result).toMatchObject({
        code: 1,
        stderr: [runLine(result.runDir), UNSETTLED(result.runDir)],
      });
      expect(retire).not.toHaveBeenCalled();
      expect(existsSync(join(result.runDir, 'cleanup.journal'))).toBe(true);
      expect(process.listenerCount('SIGTERM')).toBe(listeners);
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
    }
  });
});

it('retires only after the whole case process group has settled', async () => {
  await withStandIn(async (directory, pid) => {
    const retire = vi.fn<Retire>(() => {
      expect(alive(pid('grandchild'))).toBe(false);
      return Promise.resolve();
    });
    const result = await run({ spawnCases: standIn('timely')(directory), retire });

    expect(result).toMatchObject({ code: 0, stderr: [runLine(result.runDir)] });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(existsSync(result.runDir)).toBe(false);
  });
});

it('keeps forwarding SIGTERM to the whole group until it settles after the runner closed', async () => {
  await withStandIn(async (directory, pid) => {
    const listeners = process.listenerCount('SIGTERM');
    const retire = vi.fn<Retire>(() => Promise.resolve());
    const pending = run({ spawnCases: standIn('term')(directory), retire });
    await vi.waitFor(
      () => {
        expect(existsSync(join(directory, 'grandchild'))).toBe(true);
        expect(alive(pid('stand-in'))).toBe(false);
      },
      { timeout: 5000, interval: 20 },
    );
    // The runner itself closed; its forwarding handler remains while the group lives.
    expect(process.listenerCount('SIGTERM')).toBe(listeners + 1);
    process.emit('SIGTERM', 'SIGTERM');
    const result = await pending;

    expect(existsSync(join(directory, 'term'))).toBe(true);
    expect(result).toMatchObject({ code: 143, stderr: [runLine(result.runDir)] });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });
});

it('treats a failed group observation as unsettled', async () => {
  settlement.fail = true;
  const retire = vi.fn<Retire>(() => Promise.resolve());
  const listeners = process.listenerCount('SIGINT');
  const result = await run({
    spawnCases: (env, cwd) =>
      spawnCases(env, cwd, { file: process.execPath, args: ['-e', 'process.exit(0)'] }),
    retire,
  });
  try {
    expect(result).toMatchObject({
      code: 1,
      stderr: [runLine(result.runDir), UNSETTLED(result.runDir)],
    });
    expect(retire).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  } finally {
    await rm(result.runDir, { recursive: true, force: true });
  }
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

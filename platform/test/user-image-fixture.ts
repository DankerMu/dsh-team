import { deepStrictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSeedScript } from './profile-seed-fixture.ts';
import { runOfficeConvert } from './office-convert-fixture.ts';
import { createWebNetwork, runWebStartup, webAddress } from './web-startup-fixture.ts';
import type { WebStartupBoundary } from './web-startup-fixture.ts';
import { createDockerCommands, isAbsentResource } from './docker-command.ts';
import type { AsyncDockerCommand, DockerCommand, DockerCommandResult } from './docker-command.ts';
import {
  cleanupTargets,
  output,
  OWNER_LABEL,
  registerCleanupTarget,
  removeOwned,
} from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import type {
  DeploymentSetupEvidence,
  DeploymentSetupOperation,
} from './deployment-setup-evidence.ts';
import { prepareVerificationImage } from '../../scripts/verification-image.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export const offlineDocxScript = `
import json
import os
from docx import Document
assert not any(name in os.environ for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY")), "Docker client proxy leaked into employee runtime"

path = "/data/work/offline.docx"
document = Document()
document.add_paragraph("离线办公验证")
document.add_paragraph("中文段落：无需联网即可生成文档。")
table = document.add_table(rows=2, cols=2)
for row, values in zip(table.rows, (("项目", "状态"), ("文档生成", "成功"))):
    for cell, value in zip(row.cells, values):
        cell.text = value
document.save(path)
reopened = Document(path)
print(json.dumps({
    "effectiveUid": os.geteuid(),
    "path": path,
    "paragraphs": [paragraph.text for paragraph in reopened.paragraphs],
    "tables": [
        [[cell.text for cell in row.cells] for row in table.rows]
        for table in reopened.tables
    ],
}, ensure_ascii=False))
`;

/** Independent exact oracle shared by real Docker and invalid-readback regressions. */
export function assertDocxReadback(stdout: string): void {
  const readback: unknown = JSON.parse(stdout);
  deepStrictEqual(
    readback,
    {
      effectiveUid: 1001,
      path: '/data/work/offline.docx',
      paragraphs: ['离线办公验证', '中文段落：无需联网即可生成文档。'],
      tables: [
        [
          ['项目', '状态'],
          ['文档生成', '成功'],
        ],
      ],
    },
    'Offline DOCX readback must match exact non-root workspace and Chinese content',
  );
}

function nestedMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((inner) => nestedMessages(inner));
  }
  if (error instanceof Error) return [error.message];
  return [String(error)];
}

function assertOfflineContainerConfiguration(command: DockerCommand, container: string): void {
  const network = ['container', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', container];
  const mode = output(command(network, 30_000), network).replace(/\r?\n$/, '');
  if (mode !== 'none') throw new Error(`Expected offline Docker network none, got ${mode}`);
  const user = ['container', 'inspect', '--format', '{{.Config.User}}', container];
  const configuredUser = output(command(user, 30_000), user).replace(/\r?\n$/, '');
  if (configuredUser !== 'dsh') {
    throw new Error(`Expected default Docker user dsh, got ${configuredUser}`);
  }
}

type Probe = 'version' | 'offline-docx' | 'profile-seed' | 'office-convert' | 'offline-plugin';

export const PROBE_PLUGIN = 'dsh-team-probe-plugin';
export const PROBE_TARBALL = `/${PROBE_PLUGIN}/-/${PROBE_PLUGIN}-1.0.0.tgz`;
// Each DSH/pnpm step is bounded above the CLI's 120s registry lookup; the profile dump at 60s.
const PLUGIN_STEP_MS = 150_000;
const PROFILE_DUMP_MS = 60_000;
// Four steps and two dumps, plus the stand-in's setup and the container's own start and exit.
const OFFLINE_PLUGIN_DEADLINE_MS = 4 * PLUGIN_STEP_MS + 2 * PROFILE_DUMP_MS + 60_000;

/**
 * An employee's plugin install, uninstall and repair through the real DSH and pnpm entries
 * against a loopback registry stand-in that serves only the probe plugin, logging every request
 * per step; then the same install after the profile copies lose `bundleDependencies` (a home
 * volume seeded by an older image). Only facts leave the container; `--network none` outside.
 */
const offlinePluginScript = `
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const PROFILE = '/data/home/profiles/web';
const NAME = ${JSON.stringify(PROBE_PLUGIN)};
const TARBALL = ${JSON.stringify(PROBE_TARBALL)};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
// Each run is its own process group, killed whole at its bound with the pnpm DSH starts.
const run = (file, args, bound, cwd) => new Promise((resolve) => {
  const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2000); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, bound);
  const settle = (status, signal, error) => { clearTimeout(timer); resolve({ status, signal, error, timedOut, stdout, stderr }); };
  child.on('error', (error) => settle(null, null, error.code));
  child.on('close', (status, signal) => settle(status, signal, undefined));
});
// No engines.dsh and no @deepseek-ai peer: DSH's preflight reads the manifest as compatible.
const work = mkdtempSync('/tmp/dsh-team-registry-');
mkdirSync(work + '/package');
writeFileSync(work + '/package/package.json', JSON.stringify({ name: NAME, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
writeFileSync(work + '/package/cordis.patch.yml', '[]\\n');
const packed = await run('tar', ['-czf', work + '/probe.tgz', '-C', work, 'package'], 30000);
if (packed.status !== 0) throw new Error('probe tarball not packed: ' + packed.stderr);
const tarball = readFileSync(work + '/probe.tgz');
let requests = [];
let documentText = '';
const server = createServer((request, response) => {
  requests.push(request.method + ' ' + request.url);
  if (request.url === '/' + NAME) {
    response.setHeader('content-type', 'application/json');
    response.end(documentText);
  } else if (request.url === TARBALL) response.end(tarball);
  else { response.statusCode = 404; response.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const registry = 'http://127.0.0.1:' + String(server.address().port) + '/';
const version = { name: NAME, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, dist: {
  tarball: registry.slice(0, -1) + TARBALL,
  integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
  shasum: createHash('sha1').update(tarball).digest('hex') } };
documentText = JSON.stringify({ name: NAME, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } });
const catalog = read('/opt/dsh-team/catalog.json').entries;
const bundled = catalog.filter((entry) => Object.keys(read('/opt/dsh-team/' + entry.id + '/package.json').dependencies ?? {}).length > 0);
const closure = new Set(bundled.flatMap((entry) => Object.keys(read('/opt/dsh-team/' + entry.id + '/package.json').dependencies)));
const visible = (path) => readdirSync(path).filter((name) => !name.startsWith('.'));
const packagesIn = (path) => visible(path).flatMap((name) => name.startsWith('@')
  ? visible(path + '/' + name).map((child) => name + '/' + child) : [name]);
// Every package the canonical copies deliver nested, transitive ones included.
const nestedNames = [...new Set(bundled.flatMap((entry) => packagesIn('/opt/dsh-team/' + entry.id + '/node_modules')))].sort();
const state = async () => {
  const top = packagesIn(PROFILE + '/node_modules').sort();
  const dump = await run('dsh', ['--profile', 'web', '--dump-default-config'], ${String(PROFILE_DUMP_MS)});
  return {
    sidebar: { version: read(PROFILE + '/node_modules/dsh-better-sidebar/package.json').version,
      directory: lstatSync(PROFILE + '/node_modules/dsh-better-sidebar').isDirectory() },
    nested: Object.fromEntries(bundled.map((entry) => [entry.id, {
      canonical: visible('/opt/dsh-team/' + entry.id + '/node_modules').length,
      profile: visible(PROFILE + '/node_modules/' + entry.package + '/node_modules').length }])),
    top,
    dependencies: Object.keys(read(PROFILE + '/package.json').dependencies ?? {}).sort(),
    hoisted: top.filter((name) => closure.has(name)),
    dump: { status: dump.status, diagnostics: dump.stderr.split('\\n').filter((line) => /dsh: (skipping profile bundle|disabling profile plugin)/.test(line)) },
  };
};
const step = async (name, file, args, cwd) => {
  requests = [];
  const result = await run(file, args, ${String(PLUGIN_STEP_MS)}, cwd);
  const { status, signal, error, timedOut, stdout, stderr } = result;
  return { name, status, signal, error, timedOut, requests: [...requests].sort(), tail: (stdout + stderr).slice(-2000) };
};
const add = () => step('add', 'dsh', ['plugin', '--profile', 'web', 'add', NAME, '--registry=' + registry]);
const steps = [await add()];
if (steps[0].status === 0) steps.push(await step('remove', 'dsh', ['plugin', '--profile', 'web', 'remove', NAME, '--config.registry=' + registry]));
if (steps.at(-1).status === 0) steps.push(await step('install', 'pnpm', ['install', '--config.lockfile=false', '--config.registry=' + registry], PROFILE));
const observed = { uid: process.getuid(), bundled: bundled.map((entry) => entry.id), nestedNames, steps };
if (steps.length === 3 && steps[2].status === 0) {
  observed.state = await state();
  observed.stripped = [];
  for (const entry of bundled) {
    const path = PROFILE + '/node_modules/' + entry.package + '/package.json';
    const copy = read(path);
    if (!Object.hasOwn(copy, 'bundleDependencies')) continue;
    delete copy.bundleDependencies;
    writeFileSync(path, JSON.stringify(copy, null, 2) + '\\n');
    observed.stripped.push(entry.id);
  }
  observed.oldVolume = { step: await add() };
  if (observed.oldVolume.step.status === 0) observed.oldVolume.state = await state();
}
server.close();
process.stdout.write(JSON.stringify(observed), () => process.exit(0));
`;

/** Create, start and boundedly wait for the offline plugin probe as uid1001 without a network. */
function runOfflinePlugin(
  command: DockerCommand,
  targets: CleanupTarget[],
  run: { container: string; imageId: string; runId: string },
): string {
  const { container, imageId, runId } = run;
  const create = [
    'create',
    '--user',
    '1001',
    '--network',
    'none',
    '--name',
    container,
    '--label',
    `${OWNER_LABEL}=${runId}`,
    imageId,
    'node',
    '--input-type=module',
    '-e',
    offlinePluginScript,
  ];
  registerCleanupTarget(targets, runId, { kind: 'container', name: container });
  output(command(create, 30_000), create);
  const format = '{{.HostConfig.NetworkMode}} {{.Config.User}}';
  const inspect = ['container', 'inspect', '--format', format, container];
  const identity = output(command(inspect, 30_000), inspect).trim();
  if (identity !== 'none 1001')
    throw new Error(`Expected network none and user 1001, got ${identity}`);
  const start = ['start', container];
  output(command(start, 30_000), start);
  const wait = ['wait', container];
  const exit = output(command(wait, OFFLINE_PLUGIN_DEADLINE_MS), wait).replace(/\r?\n$/, '');
  const logs = command(['logs', container], 30_000);
  if (exit !== '0')
    throw new Error(`offline-plugin container exited ${exit}:\n${logs.stdout}\n${logs.stderr}`);
  return output(logs, ['logs', container]);
}

// The python3 offline probes; `version` runs DSH itself, `office-convert` and `offline-plugin`
// their own runners.
const PYTHON_PROBES: Partial<Record<string, string>> = {
  'offline-docx': offlineDocxScript,
  'profile-seed': profileSeedScript,
};

export interface UserImageLifecycle {
  readonly command: DockerCommand;
  readonly commandAsync: AsyncDockerCommand;
  readonly imageId: string;
  readonly runId: string;
  readonly stateVolume: string;
  readonly workVolume: string;
  readonly overlayDirectory: string;
  readonly seccomp: string;
  readonly repositoryRoot: string;
  registerContainer: (name: string) => void;
  registerResource: (
    kind: 'container' | 'volume' | 'image' | 'network',
    name: string,
    ownership: Readonly<Record<string, string>>,
  ) => void;
  registerResourceAsync: (
    kind: 'container' | 'volume' | 'image' | 'network',
    name: string,
    ownership: Readonly<Record<string, string>>,
  ) => Promise<void>;
  removeNetwork: (name: string, id: string) => void;
}
export type UserImageScenario = (lifecycle: UserImageLifecycle) => Promise<string>;

function runContainer(
  command: DockerCommand,
  targets: CleanupTarget[],
  probe: Probe,
  container: string,
  imageId: string,
  runId: string,
  volume: string | undefined,
  phase: 'fresh' | 'reuse',
): string {
  if (probe === 'office-convert') {
    const run = { container, imageId, runId, docxScript: offlineDocxScript };
    return runOfficeConvert(command, targets, run);
  }
  if (probe === 'offline-plugin')
    return runOfflinePlugin(command, targets, { container, imageId, runId });
  const script = PYTHON_PROBES[probe];
  if (probe !== 'version' && script === undefined)
    throw new Error(`Unknown user-image probe: ${probe}`);
  const offline = script !== undefined;
  if (volume !== undefined) {
    const inspectVolume = [
      'volume',
      'inspect',
      '--format',
      `{{ index .Labels "${OWNER_LABEL}" }}`,
      volume,
    ];
    if (output(command(inspectVolume, 30_000), inspectVolume).replace(/\r?\n$/, '') !== runId) {
      throw new Error('Refusing use of state volume: invocation label does not match');
    }
  }
  const create = [
    'create',
    ...(offline ? ['--network', 'none'] : []),
    ...(volume === undefined ? [] : ['--mount', `type=volume,source=${volume},target=/data/home`]),
    '--name',
    container,
    '--label',
    `${OWNER_LABEL}=${runId}`,
    imageId,
    ...(script === undefined ? ['dsh', '--version'] : ['python3', '-c', script, phase]),
  ];
  registerCleanupTarget(targets, runId, { kind: 'container', name: container });
  output(command(create, 30_000), create);
  if (offline) assertOfflineContainerConfiguration(command, container);
  if (volume !== undefined) {
    const inspect = ['container', 'inspect', '--format', '{{json .Mounts}}', container];
    const mounts: unknown = JSON.parse(output(command(inspect, 30_000), inspect));
    if (
      !Array.isArray(mounts) ||
      !mounts.some(
        (mount: unknown) =>
          typeof mount === 'object' &&
          mount !== null &&
          'Type' in mount &&
          mount.Type === 'volume' &&
          'Name' in mount &&
          mount.Name === volume &&
          'Destination' in mount &&
          mount.Destination === '/data/home' &&
          'RW' in mount &&
          mount.RW === true,
      )
    ) {
      throw new Error('Profile probe requires the owned writable named volume at /data/home');
    }
  }
  const start = ['start', '--attach', container];
  const stdout = output(command(start, 30_000), start);
  const wait = ['wait', container];
  const exit = output(command(wait, 30_000), wait).replace(/\r?\n$/, '');
  if (exit !== '0') throw new Error(`${probe} container exited ${exit}:\n${stdout}`);
  return stdout;
}

function createOwnedVolumes(
  command: DockerCommand,
  targets: CleanupTarget[],
  runId: string,
  names: (string | undefined)[],
): void {
  for (const name of names) {
    if (name === undefined) continue;
    const args = ['volume', 'create', '--label', `${OWNER_LABEL}=${runId}`, name];
    registerCleanupTarget(targets, runId, { kind: 'volume', name });
    output(command(args, 30_000), args);
  }
}

function lifecycleVolumes(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  runId: string,
): { volume: string | undefined; workVolume: string | undefined } {
  if (probe === 'container-start') {
    const userId = runId.replaceAll('-', '').slice(0, 12);
    return { volume: `dsh-team-home-${userId}`, workVolume: `dsh-team-work-${userId}` };
  }
  const volume =
    probe === 'profile-seed' || probe === 'web-startup' || probe === 'managed-policy'
      ? `dsh-team-test-${runId}-state`
      : undefined;
  const workVolume =
    probe === 'web-startup' || probe === 'managed-policy'
      ? `dsh-team-test-${runId}-work`
      : undefined;
  return { volume, workVolume };
}

interface UserImageResult {
  runId: string;
  image: string;
  container: string;
  stdout: string;
  volume?: string;
  workVolume?: string;
  containers: string[];
}

export function runUserImage(
  probe: 'web-startup',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  webBoundary?: Partial<WebStartupBoundary>,
): Promise<UserImageResult>;
export function runUserImage(
  probe: Probe,
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
): UserImageResult;
export function runUserImage(
  probe: 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand: DockerCommand | undefined,
  scenario: UserImageScenario,
  setup?: DeploymentSetupEvidence,
): Promise<UserImageResult>;
export function runUserImage(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  extra?: Partial<WebStartupBoundary> | UserImageScenario,
  setup?: DeploymentSetupEvidence,
): UserImageResult | Promise<UserImageResult> {
  if (probe === 'web-startup') {
    return Promise.resolve().then(() =>
      runImageLifecycle(probe, assertOutput, injectedCommand, extra as Partial<WebStartupBoundary>),
    );
  }
  if (probe === 'managed-policy' || probe === 'container-start') {
    return Promise.resolve().then(() => {
      const preparation = setup?.begin('user-image-preparation');
      setup?.cleanup('resources', 'unconfirmed');
      try {
        return runImageLifecycle(probe, assertOutput, injectedCommand, extra, setup, preparation);
      } catch (error) {
        preparation?.fail();
        throw error;
      }
    });
  }
  return runImageLifecycle(probe, assertOutput, injectedCommand);
}

function createResourceRegistration(
  targets: CleanupTarget[],
  runId: string,
  command: DockerCommand,
  commandAsync: AsyncDockerCommand,
): Pick<UserImageLifecycle, 'registerResource' | 'registerResourceAsync'> {
  const registrations = new Map<string, { target: CleanupTarget; settlement: Promise<void> }>();
  function prepareRegistration(
    kind: CleanupTarget['kind'],
    name: string,
    ownership: Readonly<Record<string, string>>,
  ) {
    if (!name.startsWith('dsh-team-') || Object.keys(ownership).length === 0)
      throw new Error('Acceptance target requires exact owned identity');
    const registered = targets.find((target) => target.kind === kind && target.name === name);
    const existing = registered ?? registrations.get(`${kind}:${name}`)?.target;
    if (existing !== undefined) {
      const expected = existing.ownership ?? { [OWNER_LABEL]: runId };
      if (
        Object.keys(expected).length !== Object.keys(ownership).length ||
        Object.entries(expected).some(([label, value]) => ownership[label] !== value)
      )
        throw new Error('Acceptance resource ownership does not match registered authority');
    }
    if (registered !== undefined) return undefined;
    // Authority must not change while the asynchronous absence inspection is pending.
    return { kind, name, ownership: Object.freeze({ ...ownership }) };
  }
  function registerAbsent(target: CleanupTarget, result: DockerCommandResult): void {
    if (!isAbsentResource(result, target.kind, target.name))
      throw new Error('Acceptance resource already exists; refusing cleanup authority');
    registerCleanupTarget(targets, runId, target);
  }
  return {
    registerResource: (kind, name, ownership): void => {
      const target = prepareRegistration(kind, name, ownership);
      if (target === undefined) return;
      if (registrations.has(`${kind}:${name}`))
        throw new Error('Acceptance resource registration in progress');
      registerAbsent(target, command([kind, 'inspect', name], 30_000));
    },
    registerResourceAsync: async (kind, name, ownership): Promise<void> => {
      const target = prepareRegistration(kind, name, ownership);
      if (target === undefined) return;
      const key = `${kind}:${name}`;
      const pending = registrations.get(key);
      if (pending !== undefined) return pending.settlement;
      // Reserve before invoking even an injected boundary, which may synchronously re-enter.
      const settlement = Promise.resolve().then(async () => {
        try {
          registerAbsent(target, await commandAsync([kind, 'inspect', name], 30_000));
        } finally {
          registrations.delete(key);
        }
      });
      registrations.set(key, { target, settlement });
      await settlement;
    },
  };
}

const PLUGIN_CONTEXTS = [
  'zh-locale',
  'permission-tiers',
  'office-agents',
  'platform-nav',
  'knowledge-base',
] as const;
type PluginContext = (typeof PLUGIN_CONTEXTS)[number];

/** The named contexts of the stage-1 commit's user image, which predates `knowledge-base`. */
export const STAGE1_PLUGIN_CONTEXTS = [
  'zh-locale',
  'permission-tiers',
  'office-agents',
  'platform-nav',
] as const satisfies readonly PluginContext[];

function requireDockerDaemon(command: DockerCommand): void {
  const prerequisite = ['version', '--format', '{{.Server.Version}}'];
  if (output(command(prerequisite, 10_000), prerequisite).trim() === '') {
    throw new Error('Docker daemon version prerequisite returned no version');
  }
}

/**
 * The one user-image build argv over a source tree (this checkout, or an extracted historical
 * commit); a caller may substitute one plugin's named context, or the primary context together
 * with the Dockerfile it contains.
 */
export function userImageBuildArgs(
  runId: string,
  image: string,
  replaced?: { plugin: PluginContext; directory: string },
  root = repositoryRoot,
  primary = join(root, 'images/dsh-user'),
  contexts: readonly PluginContext[] = PLUGIN_CONTEXTS,
): string[] {
  return [
    'build',
    '--label',
    `${OWNER_LABEL}=${runId}`,
    '--tag',
    image,
    '--file',
    join(primary, 'Dockerfile'),
    ...contexts.flatMap((plugin) => [
      '--build-context',
      `${plugin}=${replaced?.plugin === plugin ? replaced.directory : join(root, `plugins/${plugin}`)}`,
    ]),
    // Keep the primary context narrow: no repository-root files or secrets.
    primary,
  ];
}

interface RejectedBuild {
  readonly runId: string;
  readonly image: string;
  readonly status: number;
  readonly stderr: string;
}

/** One plugin's `engines.dsh` replaced, or an owned primary-context copy mutated in place. */
type RejectedBuildOptions =
  | { readonly plugin: PluginContext; readonly enginesDsh: string }
  | { readonly primary: (directory: string) => void; readonly expect: string };

/** Prepares the owned copy under `copy` and returns the build argv over it. */
function rejectedBuildArgs(
  options: RejectedBuildOptions,
  copy: string,
  runId: string,
  image: string,
): string[] {
  if ('primary' in options) {
    const primary = join(copy, 'dsh-user');
    cpSync(join(repositoryRoot, 'images/dsh-user'), primary, { recursive: true });
    options.primary(primary);
    return userImageBuildArgs(runId, image, undefined, repositoryRoot, primary);
  }
  const { plugin, enginesDsh } = options;
  const directory = join(copy, plugin);
  cpSync(join(repositoryRoot, `plugins/${plugin}`), directory, { recursive: true });
  const manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const engines = {
    ...(manifest.engines as Record<string, unknown> | undefined),
    dsh: enginesDsh,
  };
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, engines }, null, 2)}\n`);
  return userImageBuildArgs(runId, image, { plugin, directory });
}

/**
 * Natively build the user image from an owned changed copy (one plugin's `engines.dsh`, or the
 * primary context) and require the build to fail with the expected diagnostic. Uploaded
 * verification images cannot represent the changed context.
 */
export function buildUserImageExpectingFailure(
  options: RejectedBuildOptions,
  injectedCommand?: DockerCommand,
): RejectedBuild {
  const [subject, expected, missing] =
    'primary' in options
      ? ['Inconsistent catalog', options.expect, `contain ${options.expect}`]
      : [`Incompatible ${options.plugin}`, options.plugin, `name ${options.plugin}`];
  const runId = randomUUID();
  const tag = 'primary' in options ? 'inconsistent-catalog' : `incompatible-${options.plugin}`;
  const image = `dsh-team-test-${runId}:${tag}`;
  const config = mkdtempSync(join(tmpdir(), 'dsh-team-test-docker-'));
  const copy = mkdtempSync(join(tmpdir(), 'dsh-team-test-plugin-'));
  // Unbounded mode retains the build's own stderr; the bounded mode redacts it.
  const { command } = createDockerCommands(repositoryRoot, config, false, injectedCommand);
  const failures: unknown[] = [];
  const targets: CleanupTarget[] = [];
  let rejected: RejectedBuild | undefined;
  try {
    requireDockerDaemon(command);
    const build = rejectedBuildArgs(options, copy, runId, image);
    // A rejected build normally leaves no tag; registration still owns any it produces.
    registerCleanupTarget(targets, runId, { kind: 'image', name: image });
    const result = command(build, 600_000, 1);
    if (result.error !== undefined || result.status !== 1) {
      throw new Error(`${subject} user-image build must exit 1, got ${String(result.status)}`);
    }
    if (!result.stderr.includes(expected))
      throw new Error(`Rejected user-image build stderr does not ${missing}`);
    rejected = { runId, image, status: result.status, stderr: result.stderr };
  } catch (error) {
    failures.push(error);
  }
  cleanupTargets(command, targets, runId, failures);
  for (const directory of [copy, config]) {
    try {
      rmSync(directory, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0 || rejected === undefined) {
    const messages = failures.flatMap((error) => nestedMessages(error));
    throw new AggregateError(failures, messages.join('\n'));
  }
  return rejected;
}

function prepareUserImage(
  command: DockerCommand,
  targets: CleanupTarget[],
  runId: string,
  image: string,
  config: string,
): string {
  requireDockerDaemon(command);
  const build = userImageBuildArgs(runId, image);
  const artifact = prepareVerificationImage(
    'user',
    image,
    { [OWNER_LABEL]: runId },
    config,
    command,
  );
  const buildArgs = artifact?.args ?? build;
  // Admission precedes registration; partial builds remain owned by this case.
  registerCleanupTarget(targets, runId, { kind: 'image', name: image });
  output(command(buildArgs, 600_000), buildArgs);
  const inspect = ['image', 'inspect', '--format', '{{.Id}}', image];
  const imageId = output(command(inspect, 30_000), inspect).replace(/\r?\n$/, '');
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error('Built Docker image did not return an exact image identity');
  artifact?.verify(imageId);
  return imageId;
}

function runImageLifecycle(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  extra?: Partial<WebStartupBoundary> | UserImageScenario,
  setup?: DeploymentSetupEvidence,
  preparation?: DeploymentSetupOperation,
): UserImageResult | Promise<UserImageResult> {
  const runId = randomUUID();
  const image = `dsh-team-test-${runId}:${probe}`;
  const container = `dsh-team-test-${runId}-${probe}`;
  const { volume, workVolume } = lifecycleVolumes(probe, runId);
  const containers = [container];
  const config = mkdtempSync(join(tmpdir(), 'dsh-team-test-docker-'));
  const hasScenario = probe === 'managed-policy' || probe === 'container-start';
  const { command, commandAsync } = createDockerCommands(
    repositoryRoot,
    config,
    probe === 'web-startup' || hasScenario,
    injectedCommand,
  );
  const failures: unknown[] = [];
  const targets: CleanupTarget[] = [];
  let stdout = '';
  function finish(): UserImageResult {
    const beforeCleanup = failures.length;
    cleanupTargets(command, targets, runId, failures);
    if (
      targets.some(
        (target) => target.kind === 'network' && target.ownership?.[OWNER_LABEL] === runId,
      )
    ) {
      try {
        const inventory = [
          'network',
          'ls',
          '--filter',
          `label=${OWNER_LABEL}=${runId}`,
          '--quiet',
          '--no-trunc',
        ];
        if (output(command(inventory, 30_000), inventory).trim() !== '')
          throw new Error('Invocation network inventory remains after cleanup');
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      rmSync(config, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
    setup?.cleanup('resources', failures.length === beforeCleanup ? 'confirmed' : 'unconfirmed');
    if (failures.length !== 0) {
      const messages = failures.flatMap((error) => nestedMessages(error));
      throw new AggregateError(failures, messages.join('\n'));
    }
    return {
      runId,
      image,
      container,
      stdout,
      containers,
      ...(volume === undefined ? {} : { volume }),
      ...(workVolume === undefined ? {} : { workVolume }),
    };
  }
  try {
    const imageId = prepareUserImage(command, targets, runId, image, config);
    if (probe !== 'container-start')
      createOwnedVolumes(command, targets, runId, [volume, workVolume]);
    if (probe === 'web-startup') {
      if (volume === undefined || workVolume === undefined)
        throw new Error('Web volume setup missing');
      const network = createWebNetwork(
        command,
        runId,
        'web',
        (name, ownership) => {
          registerCleanupTarget(targets, runId, { kind: 'network', name, ownership });
        },
        extra as Partial<WebStartupBoundary>,
      );
      const overlay = join(config, 'web.patch.yml');
      writeFileSync(
        overlay,
        `- id: webserver\n  config:\n    host: ${webAddress(network)}\n    port: 3080\n`,
        { mode: 0o444 },
      );
      registerCleanupTarget(targets, runId, { kind: 'container', name: container });
      return runWebStartup(
        command,
        {
          container,
          imageId,
          runId,
          stateVolume: volume,
          workVolume,
          overlay,
          seccomp: join(repositoryRoot, 'images/seccomp/dsh-user.json'),
          network,
        },
        extra as Partial<WebStartupBoundary>,
      )
        .then((summary) => {
          stdout = summary;
          assertOutput(summary);
        })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .then(finish);
    }
    if (hasScenario) {
      if (volume === undefined || workVolume === undefined)
        throw new Error('Image scenario volume setup missing');
      if (typeof extra !== 'function') throw new Error('Image scenario missing');
      const overlayDirectory = join(config, 'managed');
      const lifecycle: UserImageLifecycle = {
        command,
        commandAsync,
        imageId,
        runId,
        stateVolume: volume,
        workVolume,
        overlayDirectory,
        seccomp: join(repositoryRoot, 'images/seccomp/dsh-user.json'),
        repositoryRoot,
        registerContainer: (name: string): void => {
          if (!containers.includes(name)) containers.push(name);
          registerCleanupTarget(targets, runId, { kind: 'container', name });
        },
        ...createResourceRegistration(targets, runId, command, commandAsync),
        removeNetwork: (name, id): void => {
          const target = targets.find((entry) => entry.kind === 'network' && entry.name === name);
          if (target === undefined) throw new Error('Network cleanup target was not registered');
          target.networkId = id;
          removeOwned(command, 'network', name, runId, target.ownership, id);
        },
      };
      preparation?.complete();
      return extra(lifecycle)
        .then((summary) => {
          stdout = summary;
          assertOutput(summary);
        })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .then(finish);
    }
    stdout = runContainer(command, targets, probe, container, imageId, runId, volume, 'fresh');
    assertOutput(stdout);
    if (volume !== undefined) {
      const reusedContainer = `${container}-reuse`;
      containers.push(reusedContainer);
      stdout = runContainer(
        command,
        targets,
        probe,
        reusedContainer,
        imageId,
        runId,
        volume,
        'reuse',
      );
      assertOutput(stdout);
    }
  } catch (error) {
    preparation?.fail();
    failures.push(error);
  }
  return finish();
}

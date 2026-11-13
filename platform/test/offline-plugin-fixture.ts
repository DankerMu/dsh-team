import { expect } from 'vitest';
import { output, OWNER_LABEL, registerCleanupTarget } from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import type { DockerCommand } from './docker-command.ts';
import {
  METADATA_REQUEST,
  PROBE_PLUGIN,
  registryStandInScript,
  STAND_IN_REQUESTS,
  TARBALL_REQUEST,
} from './registry-stand-in.ts';

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
import { chmodSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
${registryStandInScript({ port: 0 })}
const PROFILE = '/data/home/profiles/web';
const NAME = ${JSON.stringify(PROBE_PLUGIN)};
const { registry } = registryStandIn;
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
  registryStandIn.requests.length = 0;
  const result = await run(file, args, ${String(PLUGIN_STEP_MS)}, cwd);
  const { status, signal, error, timedOut, stdout, stderr } = result;
  return { name, status, signal, error, timedOut, requests: [...registryStandIn.requests].sort(), tail: (stdout + stderr).slice(-2000) };
};
const add = () => step('add', 'dsh', ['plugin', '--profile', 'web', 'add', NAME, '--registry=' + registry]);
const steps = [];
const observed = { uid: process.getuid(), bundled: bundled.map((entry) => entry.id), nestedNames, steps };
// A throw still emits the steps done so far, with their request logs, and exits 1.
let failure;
try {
  steps.push(await add());
  if (steps[0].status === 0) steps.push(await step('remove', 'dsh', ['plugin', '--profile', 'web', 'remove', NAME, '--config.registry=' + registry]));
  if (steps.at(-1).status === 0) steps.push(await step('install', 'pnpm', ['install', '--config.lockfile=false', '--config.registry=' + registry], PROFILE));
  if (steps.length === 3 && steps[2].status === 0) {
    observed.state = await state();
    observed.stripped = [];
    for (const entry of bundled) {
      const path = PROFILE + '/node_modules/' + entry.package + '/package.json';
      const copy = read(path);
      if (!Object.hasOwn(copy, 'bundleDependencies')) continue;
      // pnpm re-copies the 0444 canonical files; an older image's register copy is 0644.
      const before = statSync(path);
      if (before.uid !== process.getuid()) throw new Error('profile copy not owned by the employee: ' + path);
      chmodSync(path, 0o644);
      delete copy.bundleDependencies;
      writeFileSync(path, JSON.stringify(copy, null, 2) + '\\n');
      observed.stripped.push({ id: entry.id, uid: before.uid, modeBefore: before.mode & 0o777, modeAfter: statSync(path).mode & 0o777 });
    }
    observed.oldVolume = { step: await add() };
    if (observed.oldVolume.step.status === 0) observed.oldVolume.state = await state();
  }
} catch (error) {
  failure = error;
  observed.failure = String(error?.stack ?? error);
}
registryStandIn.server.close();
process.stdout.write(JSON.stringify(observed), () => process.exit(failure === undefined ? 0 : 1));
`;

/** Create, start and boundedly wait for the offline plugin probe as uid1001 without a network. */
export function runOfflinePlugin(
  command: DockerCommand,
  targets: CleanupTarget[],
  run: { container: string; imageId: string; runId: string },
): string {
  const { container, imageId, runId } = run;
  const label = `${OWNER_LABEL}=${runId}`;
  const offline = ['--user', '1001', '--network', 'none', '--name', container, '--label', label];
  const script = ['node', '--input-type=module', '-e', offlinePluginScript];
  const create = ['create', ...offline, imageId, ...script];
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

interface PluginStep {
  readonly name: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: string;
  readonly timedOut: boolean;
  readonly requests: readonly string[];
  readonly tail: string;
}

interface ProfileState {
  readonly sidebar: { readonly version: string; readonly directory: boolean };
  readonly nested: Record<string, { readonly canonical: number; readonly profile: number }>;
  readonly top: readonly string[];
  readonly dependencies: readonly string[];
  readonly hoisted: readonly string[];
  readonly dump: { readonly status: number | null; readonly diagnostics: readonly string[] };
}

export interface OfflinePluginObservation {
  readonly uid: number;
  readonly bundled: readonly string[];
  readonly nestedNames: readonly string[];
  readonly steps: readonly PluginStep[];
  readonly state?: ProfileState;
  readonly stripped?: readonly {
    readonly id: string;
    readonly uid: number;
    readonly modeBefore: number;
    readonly modeAfter: number;
  }[];
  readonly failure?: string;
  readonly oldVolume?: { readonly step: PluginStep; readonly state?: ProfileState };
}

const BUNDLED_ENTRIES = ['dsh-better-sidebar', 'dsh-sidebar-onlyoffice'];

/** The nested package names a request path names as segments, raw, `%2F`-encoded or decoded. */
function namedPackages(request: string, names: readonly string[]): string[] {
  const raw = `${request.replace(/^\S+ /, '').replace(/[?#].*$/, '')}/`;
  const forms = [raw, raw.toLowerCase(), decodeURIComponent(raw)];
  return names.filter((name) =>
    [name, name.replace('/', '%2f')].some((form) =>
      forms.some((path) => path.includes(`/${form}/`)),
    ),
  );
}

/** One step exited 0 within its bound and asked the stand-in for nothing a preinstalled item needs. */
function expectStep(step: PluginStep | undefined, name: string): void {
  expect([step?.name, step?.status, step?.signal, step?.error, step?.timedOut], step?.tail).toEqual(
    [name, 0, null, undefined, false],
  );
  for (const request of step?.requests ?? []) expect(STAND_IN_REQUESTS).toContain(request);
}

/** The preinstalled items stay as delivered: nothing re-resolved, hoisted or skipped by DSH. */
function expectProfile(state: ProfileState | undefined, registered: readonly string[]): void {
  if (state === undefined) throw new Error('Missing profile state');
  expect(state.sidebar).toEqual({ version: '0.28.0', directory: true });
  expect(Object.keys(state.nested)).toEqual(BUNDLED_ENTRIES);
  for (const [id, { canonical, profile }] of Object.entries(state.nested)) {
    expect([id, profile]).toEqual([id, canonical]);
    expect(canonical).toBeGreaterThan(0);
  }
  expect(state.top).toEqual(registered);
  expect(state.dependencies).toEqual(registered);
  expect(state.hoisted).toEqual([]);
  expect(state.dump).toEqual({ status: 0, diagnostics: [] });
}

/** The offline-plugin probe's observation judged; returns the per-step request evidence. */
export function assertOfflinePluginObservation(
  stdout: string,
  packages: readonly string[],
): string {
  const observed = JSON.parse(stdout) as OfflinePluginObservation;
  expect(observed.failure).toBeUndefined();
  expect(observed.uid).toBe(1001);
  expect(observed.bundled).toEqual(BUNDLED_ENTRIES);
  expect(observed.nestedNames).toEqual(
    expect.arrayContaining(['@deepseek-ai/schemastery', 'yaml']),
  );
  // The invariant itself: no request names any package of the canonical nested closures.
  const requests = [...observed.steps, observed.oldVolume?.step].flatMap(
    (step) => step?.requests ?? [],
  );
  expect(requests.flatMap((request) => namedPackages(request, observed.nestedNames))).toEqual([]);
  const [add, remove, install, extra] = observed.steps;
  expectStep(add, 'add');
  expect(add?.requests).toEqual(expect.arrayContaining([METADATA_REQUEST, TARBALL_REQUEST]));
  expectStep(remove, 'remove');
  expectStep(install, 'install');
  expect(extra).toBeUndefined();
  expectProfile(observed.state, packages);
  // A home volume seeded by an older image: profile copies without the field.
  expect(observed.stripped?.map((copy) => copy.id)).toEqual(BUNDLED_ENTRIES);
  for (const copy of observed.stripped ?? []) {
    // pnpm's re-copy of the 0444 canonical file, or an older image's 0644 register copy.
    expect([0o444, 0o644]).toContain(copy.modeBefore);
    expect([copy.id, copy.uid, copy.modeAfter]).toEqual([copy.id, 1001, 0o644]);
  }
  expectStep(observed.oldVolume?.step, 'add');
  expect(observed.oldVolume?.step.requests).toContain(METADATA_REQUEST);
  expectProfile(observed.oldVolume?.state, [...packages, PROBE_PLUGIN].sort());
  const counts = [...observed.steps, observed.oldVolume?.step].map(
    (step) => `${String(step?.name)}=${String(step?.requests.length)}`,
  );
  return `requests ${counts.join(' ')} nested=${JSON.stringify(observed.state?.nested)}`;
}

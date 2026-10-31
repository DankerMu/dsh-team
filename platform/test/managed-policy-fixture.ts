import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  generateManagedConfig,
  readManagedComposition,
  writeManagedConfig,
} from '../src/managed-config/index.ts';
import type { ManagedComposition } from '../src/managed-config/index.ts';
import {
  acceptObservation,
  exchangeLaunchToken,
  mappedFlags,
  mappedRpc,
} from '../../scripts/probe-mapped-host.mjs';
import type { MappedHostAcceptResult } from '../../scripts/probe-mapped-host.mjs';
import type { DockerCommand } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import { createWebNetwork, runWebStartup, webAddress } from './web-startup-fixture.ts';
import type { WebNetwork } from './web-startup-fixture.ts';
import { extractLaunchToken } from '../src/orchestrator/index.ts';
import {
  browserEvidence,
  createManagedPolicyEvidence,
  managedPolicyEvidenceRoot,
  type ManagedPolicyEvidence,
  type ManagedPolicyStage,
} from './managed-policy-evidence.ts';
import {
  assertManagedPolicyRuntime,
  assertRuntimeRejected,
  controlEmployeePolicyFailure,
  liveCopyReenablesPersonalModels,
  parseManagedPolicyRuntime,
  SHIPPED_PRESET_IDS,
  RETAINED_TOOLS,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';
import { customOfficeInsert, employeeHomePatch } from './managed-policy-employee-edit.ts';
import { createProfileRecorder, PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';
import type { ProfileRecorder } from './managed-policy-profile.ts';
import { MANAGED_BOOT_ROSTER } from './managed-boot-roster.ts';

const USER_ID = 'managedpol01';
const MANAGED_ADDRESS = 'http://127.0.0.1:9/v1';
const ALT_ADDRESS = 'http://127.0.0.1:8/v1';
const HOSTNAME = 'dsh-team-managed.invalid';
const CUSTOM_PRESET_ID = 'custom-office';
const OBSERVER_ID = 'dsh-team-managed-policy-observer';
const OBSERVER_MARK = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const INVALID = 'Invalid managed policy runtime observation';
const API_KEY_ENV = 'DMXAPI_KEY';
const API_KEY_VALUE = 'test-owned-nonsecret';
const CANONICAL_SEED =
  '/opt/dsh-team/profile-seed/web/node_modules/@dsh-team/zh-locale/cordis.patch.yml';
const LIVE_PATCH = '/data/home/profiles/web/node_modules/@dsh-team/zh-locale/cordis.patch.yml';
const PROFILE_PATCH = '/data/home/profiles/web/cordis.patch.yml';
const HOME_PATCH = '/data/home/cordis.patch.yml';
const OBSERVER_PATH = '/data/home/profiles/web/node_modules/@dsh-team/managed-policy-observer.js';
const STATE_MARKER = '/data/home/dsh-team-user-state.txt';
const STATE_MARKER_BODY = 'keep-across-restart\n';
const CUSTOM_DESCRIPTION = 'brief-zh';
const WORKSPACE_PATH = '/data/work';
const TAMPERED_LIVE = '- id: ui-settings-models\n  disabled: false\n';
// The generated overlay's yolo default, observed through the managed execution service.
const MANAGED_YOLO_PERMISSIONS = { managedPermissions: true, defaultPreset: 'danger-full-access' };
const EMPLOYEE_HOME = employeeHomePatch(API_KEY_ENV, ALT_ADDRESS);
const CUSTOM_INSERT = customOfficeInsert(CUSTOM_PRESET_ID);
const OBSERVER_INSERT = { id: OBSERVER_ID, name: OBSERVER_PATH };

const MANAGED_POLICY_EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: MANAGED_ADDRESS,
  defaultModel: 'beta',
  catalog: [{ id: 'intranet', models: ['alpha', 'beta'] }],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: [...SHIPPED_PRESET_IDS],
  retainedTools: RETAINED_TOOLS,
  officeNames: { 'office-general': '综合办公', 'office-writer': '公文与材料写作' },
};

const RESTART_EXPECTED: ManagedPolicyRuntimeExpectation = {
  ...MANAGED_POLICY_EXPECTED,
  presetIds: [...SHIPPED_PRESET_IDS, CUSTOM_PRESET_ID],
  descriptions: { [CUSTOM_PRESET_ID]: CUSTOM_DESCRIPTION },
  readLimits: { [CUSTOM_PRESET_ID]: 500 },
  retainedTools: {
    ...RETAINED_TOOLS,
    [CUSTOM_PRESET_ID]: ['read', 'present', 'plugin_manager'],
  },
};

function docker(command: DockerCommand, args: readonly string[], timeout = 30_000): string {
  const result = command(args, timeout);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Web Docker operation failed');
  }
  return result.stdout;
}

/** One owned /28 bridge per DSH Web container, registered with the lifecycle before creation. */
export function lifecycleWebNetwork(lifecycle: UserImageLifecycle, suffix: string): WebNetwork {
  return createWebNetwork(lifecycle.command, lifecycle.runId, suffix, (name, ownership) => {
    lifecycle.registerResource('network', name, ownership);
  });
}

/**
 * Offline (`--network none`) unless the script launches DSH Web itself: DSH 0.2.1 binds only the
 * overlay's concrete address, so such a container sits at its owned network's base+2.
 */
export function execScript(
  lifecycle: UserImageLifecycle,
  name: string,
  script: string,
  network?: WebNetwork,
): string {
  const owned = docker(lifecycle.command, [
    'volume',
    'inspect',
    '--format',
    '{{ index .Labels "dsh-team.test-run" }}',
    lifecycle.stateVolume,
  ]).trim();
  if (owned !== lifecycle.runId) throw new Error('Web volume ownership mismatch');
  lifecycle.registerContainer(name);
  docker(lifecycle.command, [
    'create',
    '--name',
    name,
    '--label',
    `dsh-team.test-run=${lifecycle.runId}`,
    '--user',
    '1001',
    ...(network === undefined
      ? ['--network', 'none']
      : ['--network', network.name, '--ip', webAddress(network)]),
    '--mount',
    `type=volume,source=${lifecycle.stateVolume},target=/data/home`,
    lifecycle.imageId,
    'node',
    '--input-type=module',
    '-e',
    script,
  ]);
  const identity = parseJsonRecord(
    // The full inspection repeats the entire script argv and can exceed the bounded buffer.
    docker(lifecycle.command, [
      'container',
      'inspect',
      '--format',
      '{"Image":{{json .Image}}}',
      name,
    ]),
  );
  if (identity.Image !== lifecycle.imageId) throw new Error(INVALID);
  const mounts: unknown = JSON.parse(
    docker(lifecycle.command, ['container', 'inspect', '--format', '{{json .Mounts}}', name]),
  );
  if (
    !Array.isArray(mounts) ||
    !mounts.some(
      (mount: unknown) =>
        typeof mount === 'object' &&
        mount !== null &&
        'Type' in mount &&
        mount.Type === 'volume' &&
        'Name' in mount &&
        mount.Name === lifecycle.stateVolume &&
        'Destination' in mount &&
        mount.Destination === '/data/home' &&
        'RW' in mount &&
        mount.RW === true,
    )
  ) {
    throw new Error(INVALID);
  }
  docker(lifecycle.command, ['start', '--attach', name], 60_000);
  const exit = docker(lifecycle.command, ['wait', name]).replace(/\r?\n$/, '');
  const stdout = docker(lifecycle.command, ['logs', name]);
  if (exit !== '0') throw new Error(INVALID);
  return stdout;
}

function hashBytes(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonRecord(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(INVALID);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(INVALID);
  }
  // JSON.parse yields unknown; object/array checks above are the contract.
  return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(INVALID);
  return value;
}

function requirePort(record: Record<string, unknown>): number {
  const value = record.hostPort;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(INVALID);
  }
  return value;
}

function repositoryCanonicalHash(): string {
  return hashBytes(
    readFileSync(new URL('../../plugins/zh-locale/cordis.patch.yml', import.meta.url), 'utf8'),
  );
}

function installObserverScript(plugin: string): string {
  return `
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { load, dump } = require('js-yaml');
mkdirSync('/data/home/profiles/web/node_modules/@dsh-team', { recursive: true });
writeFileSync(${JSON.stringify(OBSERVER_PATH)}, ${JSON.stringify(plugin)});
writeFileSync(${JSON.stringify(STATE_MARKER)}, ${JSON.stringify(STATE_MARKER_BODY)});
const patchPath = ${JSON.stringify(PROFILE_PATCH)};
const parsed = existsSync(patchPath) ? load(readFileSync(patchPath, 'utf8')) ?? [] : [];
if (!Array.isArray(parsed)) throw new Error(${JSON.stringify(INVALID)});
parsed.push({ insert: [${JSON.stringify(OBSERVER_INSERT)}] });
writeFileSync(patchPath, dump(parsed, { lineWidth: -1 }));
process.stdout.write(JSON.stringify({ installed: true }));
`;
}

function seedHashScript(): string {
  return `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
process.stdout.write(JSON.stringify({
  seed: digest(${JSON.stringify(CANONICAL_SEED)}),
  live: digest(${JSON.stringify(LIVE_PATCH)}),
}));
`;
}

function editAfterStopScript(): string {
  return `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { load, dump } = require('js-yaml');
const home = ${JSON.stringify(HOME_PATCH)};
const live = ${JSON.stringify(LIVE_PATCH)};
const profile = ${JSON.stringify(PROFILE_PATCH)};
const seed = readFileSync(${JSON.stringify(CANONICAL_SEED)}, 'utf8');
writeFileSync(home, ${JSON.stringify(EMPLOYEE_HOME)});
const parsed = existsSync(profile) ? load(readFileSync(profile, 'utf8')) ?? [] : [];
if (!Array.isArray(parsed)) throw new Error(${JSON.stringify(INVALID)});
parsed.push({ insert: [${JSON.stringify(CUSTOM_INSERT)}] });
const bytes = dump(parsed, { lineWidth: -1 });
${PROFILE_EDITOR_SERIALIZATION}
writeFileSync(profile, serializedProfile);
writeFileSync(live, ${JSON.stringify(TAMPERED_LIVE)});
process.stdout.write(JSON.stringify({
  home: readFileSync(home, 'utf8'),
  live: readFileSync(live, 'utf8'),
  profile: readFileSync(profile, 'utf8'),
  seed,
  marker: readFileSync(${JSON.stringify(STATE_MARKER)}, 'utf8'),
}));
`;
}

function hashAfterEditScript(): string {
  return `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
process.stdout.write(JSON.stringify({
  seed: digest(${JSON.stringify(CANONICAL_SEED)}),
  live: digest(${JSON.stringify(LIVE_PATCH)}),
  home: readFileSync(${JSON.stringify(HOME_PATCH)}, 'utf8'),
  liveBytes: readFileSync(${JSON.stringify(LIVE_PATCH)}, 'utf8'),
  profile: readFileSync(${JSON.stringify(PROFILE_PATCH)}, 'utf8'),
  marker: readFileSync(${JSON.stringify(STATE_MARKER)}, 'utf8'),
}));
`;
}

export async function collectComposition(
  lifecycle: UserImageLifecycle,
  name: string,
): Promise<ManagedComposition> {
  let sequence = 0;
  return readManagedComposition((script) =>
    Promise.resolve(execScript(lifecycle, `${name}-${String(sequence++)}`, script)),
  );
}

async function publishOverlay(
  directory: string,
  composition: ManagedComposition,
  apiKeyConfigured: boolean,
  network: WebNetwork,
): Promise<string> {
  const generated = generateManagedConfig({
    admin: false,
    instanceAddress: webAddress(network),
    modelSettings: {
      baseURL: MANAGED_ADDRESS,
      apiKeyEnv: API_KEY_ENV,
      apiKeyConfigured,
      models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
      defaultModel: 'beta',
    },
    defaultPermissionTier: 'yolo',
    ...composition,
  });
  if (generated.outcome !== 'configured') {
    throw new Error('Managed policy generation returned no document');
  }
  return writeManagedConfig(directory, USER_ID, generated.content);
}

async function publishTransportOverlay(directory: string, network: WebNetwork): Promise<string> {
  return writeManagedConfig(
    directory,
    'managedctrl1',
    JSON.stringify([{ id: 'webserver', config: { host: webAddress(network), port: 3080 } }]),
  );
}

function parseObservation(text: string): unknown {
  const marker = new RegExp(`^${OBSERVER_MARK}(.+)$`, 'gm');
  let last: string | undefined;
  for (;;) {
    const match = marker.exec(text);
    if (match === null) break;
    last = match[1];
  }
  if (last === undefined) throw new Error(INVALID);
  try {
    return JSON.parse(last);
  } catch {
    throw new Error(INVALID);
  }
}

export async function waitObservation(
  command: DockerCommand,
  name: string,
  remaining: () => number,
): Promise<unknown> {
  for (;;) {
    const logs = docker(command, ['logs', name], Math.min(5_000, remaining()));
    try {
      return parseObservation(logs);
    } catch {
      if (remaining() <= 1) throw new Error(INVALID);
      await delay(Math.min(250, remaining()));
    }
  }
}

function adapterPresetIds(composition: ManagedComposition): string[] {
  return composition.presets.map((preset) =>
    typeof preset.config.id === 'string' ? preset.config.id : preset.id,
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function inertReadLimit(composition: ManagedComposition, id: string): unknown {
  const preset = composition.presets.find((entry) => entry.id === id || entry.config.id === id);
  const config = preset?.config.plugins.find((entry) => entry.id === 'tool-fs')?.config;
  if (
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config) ||
    !('readLimit' in config)
  ) {
    return undefined;
  }
  return config.readLimit;
}

function loaderExpression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('__jsExpr' in value)) return undefined;
  const expr = value.__jsExpr;
  return typeof expr === 'string' ? expr : undefined;
}

async function bindWorkWorkspace(
  origin: string,
  cookie: string,
): Promise<{ available: true; workBound: true }> {
  const created = await mappedRpc(origin, cookie, 'workspace/create', {
    request: { path: WORKSPACE_PATH },
  });
  const record = asRemoteRecord(created);
  const workspace = asRemoteRecord(record.workspace ?? record.value);
  const path = workspace.path ?? asRemoteRecord(workspace.workspace).path;
  if (path !== WORKSPACE_PATH) throw new Error(INVALID);
  return { available: true, workBound: true };
}

function asRemoteRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(INVALID);
  }
  // RPC envelopes are unknown until the ok/value checks below.
  const record = value as Record<string, unknown>;
  if (record.ok === false) throw new Error(INVALID);
  if (record.ok === true && record.value !== undefined) {
    if (typeof record.value !== 'object' || record.value === null || Array.isArray(record.value)) {
      throw new Error(INVALID);
    }
    // Nested RPC value is an object after the checks above.
    return record.value as Record<string, unknown>;
  }
  return record;
}

function requireAccepted(
  result: MappedHostAcceptResult,
  screenshot: string,
  defaultModel: string,
): void {
  if (!result.accepted) throw new Error(INVALID);
  if (result.reload?.accepted !== true) throw new Error(INVALID);
  const preservation = result.preservation;
  if (preservation?.general !== true) throw new Error(INVALID);
  if (!sameSet(preservation.exactModels ?? [], ['alpha', 'beta'])) throw new Error(INVALID);
  if (preservation.defaultModel !== defaultModel) throw new Error(INVALID);
  if (result.screenshot?.screenshot !== screenshot) throw new Error(INVALID);
}

function recordBrowserObservation(
  evidence: ManagedPolicyEvidence,
  stage: 'start' | 'control' | 'restart',
  result: MappedHostAcceptResult,
): void {
  const screenshot = result.screenshot?.screenshot;
  evidence.record(
    stage === 'start'
      ? {
          ...(screenshot === undefined ? {} : { startScreenshot: screenshot }),
          startBrowser: browserEvidence(result),
        }
      : {
          ...(screenshot === undefined ? {} : { restartScreenshot: screenshot }),
          restartBrowser: browserEvidence(result),
        },
  );
}

export async function qualifyHostSession(
  hostPort: number,
  logs: string,
  address: string,
  token = extractLaunchToken(logs, address),
): Promise<{ origin: string; cookie: string; workspace: { available: true; workBound: true } }> {
  if (token === undefined) throw new Error(INVALID);
  const cookie = await exchangeLaunchToken({
    host: '127.0.0.1',
    port: hostPort,
    token,
    cookieHost: HOSTNAME,
  });
  const wrongHost = await mappedRpc(
    `http://dsh-team.test:${String(hostPort)}`,
    cookie,
    'settings/describe',
    {},
  );
  const wrongRecord =
    typeof wrongHost === 'object' && wrongHost !== null && !Array.isArray(wrongHost)
      ? (wrongHost as Record<string, unknown>)
      : {};
  if (wrongRecord.status !== 403 || wrongRecord.error !== 'http-403') throw new Error(INVALID);
  const origin = `http://${HOSTNAME}:${String(hostPort)}`;
  const describe = await mappedRpc(origin, cookie, 'settings/describe', {});
  const describeRecord =
    typeof describe === 'object' && describe !== null && !Array.isArray(describe)
      ? (describe as Record<string, unknown>)
      : {};
  if (describeRecord.ok !== true || describeRecord.status !== 200) throw new Error(INVALID);
  const workspace = await bindWorkWorkspace(origin, cookie);
  return { origin, cookie, workspace };
}

async function startWeb(
  lifecycle: UserImageLifecycle,
  name: string,
  overlay: string,
  network: WebNetwork,
  remaining: () => number,
  evidence: ManagedPolicyEvidence,
  stage: 'start' | 'control' | 'restart',
  profiles: ProfileRecorder,
  browser?: {
    runtime: BrowserRuntime;
    profile: string;
    screenshot: string;
    roster: readonly string[];
  },
): Promise<{ hostPort: number; observation: unknown; browser?: MappedHostAcceptResult }> {
  lifecycle.registerContainer(name);
  const summary = parseJsonRecord(
    await runWebStartup(lifecycle.command, {
      container: name,
      imageId: lifecycle.imageId,
      runId: lifecycle.runId,
      stateVolume: lifecycle.stateVolume,
      workVolume: lifecycle.workVolume,
      overlay,
      seccomp: lifecycle.seccomp,
      network,
      trustedHost: HOSTNAME,
      env: { [API_KEY_ENV]: API_KEY_VALUE },
    }),
  );
  const hostPort = requirePort(summary);
  const logs = docker(lifecycle.command, ['logs', name]);
  const observation = await waitObservation(lifecycle.command, name, remaining);
  // Retain acquired facts before schema, browser, or policy qualification can reject them.
  evidence.record(
    stage === 'control'
      ? { controlObservation: observation }
      : stage === 'start'
        ? { startPort: hostPort, startObservation: observation }
        : { restartPort: hostPort, restartObservation: observation },
  );
  profiles.capture(stage === 'control' ? 'control-runtime' : `${stage}-runtime`);
  if (browser === undefined) {
    return { hostPort, observation };
  }
  const announced = requireStringField(summary, 'announcedHost');
  const { origin, cookie, workspace } = await qualifyHostSession(hostPort, logs, announced);
  const browserResult = await acceptObservation({
    origin,
    cookie,
    extraFlags: mappedFlags(HOSTNAME),
    screenshot: browser.screenshot,
    browserMs: Math.min(60_000, remaining()),
    composition: true,
    runtime: browser.runtime,
    profile: browser.profile,
    receiptFile: `${browser.profile}.receipt.json`,
    expectedHost: HOSTNAME,
    expectedRoster: browser.roster,
    workspace,
    preserveModels: 'alpha,beta',
    expectedDefault: 'beta',
  });
  recordBrowserObservation(evidence, stage, browserResult);
  profiles.capture(stage === 'start' ? 'start-browser' : 'restart-browser');
  return { hostPort, observation, browser: browserResult };
}

async function prepareState(
  lifecycle: UserImageLifecycle,
  plugin: string,
): Promise<{
  composition: ManagedComposition;
  overlay: string;
  network: WebNetwork;
  seedHash: string;
}> {
  mkdirSync(lifecycle.overlayDirectory, { recursive: true });
  execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-observer`, installObserverScript(plugin));
  const hashes = parseJsonRecord(
    execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-seed`, seedHashScript()),
  );
  const seedHash = requireStringField(hashes, 'seed');
  if (seedHash !== repositoryCanonicalHash() || seedHash !== requireStringField(hashes, 'live')) {
    throw new Error(INVALID);
  }
  const composition = await collectComposition(lifecycle, `dsh-team-test-${lifecycle.runId}-read`);
  if (!sameSet(adapterPresetIds(composition), SHIPPED_PRESET_IDS)) throw new Error(INVALID);
  const network = lifecycleWebNetwork(lifecycle, 'start');
  const overlay = await publishOverlay(
    lifecycle.overlayDirectory,
    composition,
    API_KEY_VALUE.trim() !== '',
    network,
  );
  return { composition, overlay, network, seedHash };
}

/**
 * Every delivered plugin loaded (#393): DSH 0.2.1 skips an incompatible bundle or disables an
 * inserted row with these stderr prefixes and still boots. permission-tiers is host-only, so its
 * evidence is the effective managed tier and the injected execution service.
 */
function assertPluginsLoaded(lifecycle: UserImageLifecycle, name: string, observation: unknown) {
  const logs = lifecycle.command(['logs', name], 30_000);
  if (logs.error !== undefined || logs.status !== 0) throw new Error(INVALID);
  for (const prefix of ['dsh: skipping profile bundle', 'dsh: disabling profile plugin']) {
    if (logs.stdout.includes(prefix) || logs.stderr.includes(prefix)) {
      throw new Error(`${INVALID}: ${prefix}`);
    }
  }
  const { permissions } = parseJsonRecord(JSON.stringify(observation));
  if (!isDeepStrictEqual(permissions, MANAGED_YOLO_PERMISSIONS))
    throw new Error(`${INVALID}: managed permission tier`);
}

async function acceptManaged(
  lifecycle: UserImageLifecycle,
  overlay: string,
  network: WebNetwork,
  remaining: () => number,
  runtime: BrowserRuntime,
  work: string,
  evidence: ManagedPolicyEvidence,
  profiles: ProfileRecorder,
  expected: ManagedPolicyRuntimeExpectation,
  label: 'start' | 'restart',
): Promise<{
  hostPort: number;
  observation: unknown;
  screenshot: string;
  browser: MappedHostAcceptResult;
}> {
  const screenshot = join(managedPolicyEvidenceRoot(lifecycle.runId), `${label}.png`);
  const name = `dsh-team-test-${lifecycle.runId}-${label}`;
  const started = await startWeb(
    lifecycle,
    name,
    overlay,
    network,
    remaining,
    evidence,
    label,
    profiles,
    {
      runtime,
      profile: join(work, `chrome-${label}`),
      screenshot,
      roster: MANAGED_BOOT_ROSTER,
    },
  );
  assertManagedPolicyRuntime(started.observation, expected);
  assertPluginsLoaded(lifecycle, name, started.observation);
  if (started.browser === undefined) throw new Error(INVALID);
  requireAccepted(started.browser, screenshot, expected.defaultModel);
  return {
    hostPort: started.hostPort,
    observation: started.observation,
    screenshot,
    browser: started.browser,
  };
}

async function editThenControl(
  lifecycle: UserImageLifecycle,
  startName: string,
  remaining: () => number,
  seedHash: string,
  evidence: ManagedPolicyEvidence,
  profiles: ProfileRecorder,
): Promise<{ home: string; live: string; profile: string }> {
  docker(lifecycle.command, ['stop', startName]);
  profiles.capture('start-stopped');
  const edited = parseJsonRecord(
    execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-edit`, editAfterStopScript()),
  );
  profiles.capture('employee-edited', requireStringField(edited, 'profile'));
  if (requireStringField(edited, 'marker') !== STATE_MARKER_BODY) throw new Error(INVALID);
  if (hashBytes(requireStringField(edited, 'seed')) !== seedHash) throw new Error(INVALID);
  const home = requireStringField(edited, 'home');
  const live = requireStringField(edited, 'live');
  const profile = requireStringField(edited, 'profile');
  if (home !== EMPLOYEE_HOME || live !== TAMPERED_LIVE) throw new Error(INVALID);
  if (!profile.includes(CUSTOM_PRESET_ID)) throw new Error(INVALID);
  const controlNetwork = lifecycleWebNetwork(lifecycle, 'control');
  const transportOverlay = await publishTransportOverlay(
    lifecycle.overlayDirectory,
    controlNetwork,
  );
  const controlName = `dsh-team-test-${lifecycle.runId}-control`;
  const control = await startWeb(
    lifecycle,
    controlName,
    transportOverlay,
    controlNetwork,
    remaining,
    evidence,
    'control',
    profiles,
  );
  const controlObserved = parseManagedPolicyRuntime(control.observation);
  const failure = controlEmployeePolicyFailure(controlObserved, ALT_ADDRESS, 'alpha');
  if (failure !== undefined) throw new Error(`${INVALID}: control/${failure}`);
  assertRuntimeRejected(control.observation, RESTART_EXPECTED);
  docker(lifecycle.command, ['stop', controlName]);
  profiles.capture('control-stopped');
  return { home, live, profile };
}

function proveRestartHashes(
  lifecycle: UserImageLifecycle,
  seedHash: string,
  home: string,
  live: string,
  profile: string,
  profiles: ProfileRecorder,
): void {
  const hashes = parseJsonRecord(
    execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-hash`, hashAfterEditScript()),
  );
  profiles.capture('final-hash', requireStringField(hashes, 'profile'));
  if (requireStringField(hashes, 'seed') !== seedHash) throw new Error(INVALID);
  if (requireStringField(hashes, 'home') !== home) throw new Error(INVALID);
  if (requireStringField(hashes, 'liveBytes') !== live) throw new Error(INVALID);
  if (requireStringField(hashes, 'profile') !== profile) throw new Error(INVALID);
  if (requireStringField(hashes, 'marker') !== STATE_MARKER_BODY) throw new Error(INVALID);
  if (requireStringField(hashes, 'live') === seedHash) throw new Error(INVALID);
}

export async function runManagedPolicyScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const evidence = createManagedPolicyEvidence(lifecycle);
  const profiles = createProfileRecorder(
    (phase, script) =>
      execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-profile-${phase}`, script),
    evidence,
  );
  let work: string | undefined;
  let failedStage: ManagedPolicyStage | undefined;
  try {
    const runtime = isolatedBrowserRuntime(lifecycle.runId);
    work = mkdtempSync(join(tmpdir(), 'dsh-team-managed-policy-'));
    const startedAt = Date.now();
    const remaining = (): number => Math.max(1, 180_000 - (Date.now() - startedAt));
    const plugin = readFileSync(new URL('./managed-policy-observer.js', import.meta.url), 'utf8');
    const prepared = await prepareState(lifecycle, plugin);
    profiles.capture('prepared');
    const startName = `dsh-team-test-${lifecycle.runId}-start`;
    failedStage = 'start';
    const start = await acceptManaged(
      lifecycle,
      prepared.overlay,
      prepared.network,
      remaining,
      runtime,
      work,
      evidence,
      profiles,
      MANAGED_POLICY_EXPECTED,
      'start',
    );
    failedStage = 'control';
    const edited = await editThenControl(
      lifecycle,
      startName,
      remaining,
      prepared.seedHash,
      evidence,
      profiles,
    );
    evidence.record({ controlRejected: true });
    failedStage = 'restart';
    const changed = await collectComposition(lifecycle, `dsh-team-test-${lifecycle.runId}-reread`);
    profiles.capture('recompose-read');
    if (!sameSet(adapterPresetIds(changed), RESTART_EXPECTED.presetIds)) throw new Error(INVALID);
    if (loaderExpression(inertReadLimit(changed, CUSTOM_PRESET_ID)) !== '250 + 250') {
      throw new Error(INVALID);
    }
    const restartNetwork = lifecycleWebNetwork(lifecycle, 'restart');
    const nextOverlay = await publishOverlay(
      lifecycle.overlayDirectory,
      changed,
      API_KEY_VALUE.trim() !== '',
      restartNetwork,
    );
    profiles.capture('recompose-published');
    await acceptManaged(
      lifecycle,
      nextOverlay,
      restartNetwork,
      remaining,
      runtime,
      work,
      evidence,
      profiles,
      RESTART_EXPECTED,
      'restart',
    );
    if (liveCopyReenablesPersonalModels(start.browser)) {
      throw new Error(INVALID);
    }
    failedStage = 'hash';
    proveRestartHashes(
      lifecycle,
      prepared.seedHash,
      edited.home,
      edited.live,
      edited.profile,
      profiles,
    );
    return evidence.finish();
  } catch (error) {
    evidence.fail(failedStage);
    throw error;
  } finally {
    if (work !== undefined) {
      await rescueChrome(join(work, 'chrome-start.receipt.json'));
      await rescueChrome(join(work, 'chrome-restart.receipt.json'));
      rmSync(work, { recursive: true, force: true });
    }
  }
}

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  generateManagedConfig,
  readManagedComposition,
  writeManagedConfig,
} from '../src/managed-config/index.ts';
import type { ManagedComposition, ManagedConfigInput } from '../src/managed-config/index.ts';
import {
  acceptObservation,
  exchangeLaunchToken,
  mappedFlags,
  mappedRpc,
} from '../../scripts/probe-mapped-host.mjs';
import type { MappedHostAcceptResult } from '../../scripts/probe-mapped-host.mjs';
import type { DockerCommand } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { runWebStartup } from './web-startup-fixture.ts';
import { extractLaunchToken } from './web-launch-token.ts';
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
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';
import { customOfficeInsert, employeeHomePatch } from './managed-policy-employee-edit.ts';
import { createProfileRecorder, PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';
import type { ProfileRecorder } from './managed-policy-profile.ts';

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
const SHIPPED_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis'] as const;
const CUSTOM_DESCRIPTION = 'brief-zh';
const WORKSPACE_PATH = '/data/work';
const MANAGED_BOOT_ROSTER = [
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-job-controller',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-account',
  '@deepseek-ai/dsh-client-ui-settings-agent-loop',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-session-log',
  '@deepseek-ai/dsh-client-ui-settings-shell',
  '@deepseek-ai/dsh-client-ui-settings-subagent',
  '@deepseek-ai/dsh-client-ui-settings-web-search',
  '@deepseek-ai/dsh-client-ui-shortcuts',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-typert-registry',
  '@dsh-team/zh-locale',
] as const;
const TAMPERED_LIVE = '- id: ui-settings-models\n  disabled: false\n';
const EMPLOYEE_HOME = employeeHomePatch(API_KEY_ENV, ALT_ADDRESS);
const CUSTOM_INSERT = customOfficeInsert(CUSTOM_PRESET_ID);
const OBSERVER_INSERT = { id: OBSERVER_ID, name: OBSERVER_PATH };
const PERMISSION: ManagedConfigInput['permission'] = {
  presets: {
    'danger-full-access': {
      sandbox: 'danger-full-access',
      approval: 'never',
      name: 'Yolo',
      description: 'Do not ask before writes or commands',
    },
  },
  defaultPreset: 'danger-full-access',
};

const RETAINED_TOOLS = {
  standard: ['bash', 'read'],
  ptc: ['bash', 'read'],
  minimal: ['bash'],
  cordis: ['bash', 'read'],
} as const;

const MANAGED_POLICY_EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: MANAGED_ADDRESS,
  defaultModel: 'beta',
  catalog: [{ id: 'intranet', models: ['alpha', 'beta'] }],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: [...SHIPPED_PRESET_IDS],
  retainedTools: RETAINED_TOOLS,
};

const RESTART_EXPECTED: ManagedPolicyRuntimeExpectation = {
  ...MANAGED_POLICY_EXPECTED,
  presetIds: [...SHIPPED_PRESET_IDS, CUSTOM_PRESET_ID],
  descriptions: { [CUSTOM_PRESET_ID]: CUSTOM_DESCRIPTION },
  readLimits: { [CUSTOM_PRESET_ID]: 500 },
  retainedTools: {
    ...RETAINED_TOOLS,
    [CUSTOM_PRESET_ID]: ['read', 'present'],
  },
};

function docker(command: DockerCommand, args: readonly string[], timeout = 30_000): string {
  const result = command(args, timeout);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Web Docker operation failed');
  }
  return result.stdout;
}

export function execScript(lifecycle: UserImageLifecycle, name: string, script: string): string {
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
    '--network',
    'none',
    '--mount',
    `type=volume,source=${lifecycle.stateVolume},target=/data/home`,
    lifecycle.imageId,
    'node',
    '--input-type=module',
    '-e',
    script,
  ]);
  const identity = parseJsonRecord(
    docker(lifecycle.command, ['container', 'inspect', '--format', '{{json .}}', name]),
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

function chromeRequired(): string {
  const chromeBin = process.env.CHROME_BIN;
  if (chromeBin === undefined || chromeBin === '') {
    throw new Error('CHROME_BIN is required for managed-policy browser verification');
  }
  return chromeBin;
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

async function collectComposition(
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
): Promise<string> {
  const generated = generateManagedConfig({
    modelSettings: {
      baseURL: MANAGED_ADDRESS,
      apiKeyEnv: API_KEY_ENV,
      apiKeyConfigured,
      models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
      defaultModel: 'beta',
    },
    permission: PERMISSION,
    ...composition,
  });
  if (generated.outcome !== 'configured') {
    throw new Error('Managed policy generation returned no document');
  }
  return writeManagedConfig(directory, USER_ID, generated.content);
}

async function publishTransportOverlay(directory: string): Promise<string> {
  return writeManagedConfig(
    directory,
    'managedctrl1',
    JSON.stringify([{ id: 'webserver', config: { host: '0.0.0.0', port: 3080 } }]),
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

async function waitObservation(
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

async function qualifyHostSession(
  hostPort: number,
  logs: string,
): Promise<{ origin: string; cookie: string; workspace: { available: true; workBound: true } }> {
  const token = extractLaunchToken(logs);
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
  remaining: () => number,
  evidence: ManagedPolicyEvidence,
  stage: 'start' | 'control' | 'restart',
  profiles: ProfileRecorder,
  browser?: { chromeBin: string; profile: string; screenshot: string; roster: readonly string[] },
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
  const { origin, cookie, workspace } = await qualifyHostSession(hostPort, logs);
  const browserResult = await acceptObservation({
    origin,
    cookie,
    extraFlags: mappedFlags(HOSTNAME),
    screenshot: browser.screenshot,
    browserMs: Math.min(60_000, remaining()),
    composition: true,
    chromeBin: browser.chromeBin,
    profile: browser.profile,
    pidFile: join(browser.profile, 'chrome.pid'),
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
): Promise<{ composition: ManagedComposition; overlay: string; seedHash: string }> {
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
  const overlay = await publishOverlay(
    lifecycle.overlayDirectory,
    composition,
    API_KEY_VALUE.trim() !== '',
  );
  return { composition, overlay, seedHash };
}

async function acceptManaged(
  lifecycle: UserImageLifecycle,
  overlay: string,
  remaining: () => number,
  chromeBin: string,
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
  const started = await startWeb(
    lifecycle,
    `dsh-team-test-${lifecycle.runId}-${label}`,
    overlay,
    remaining,
    evidence,
    label,
    profiles,
    {
      chromeBin,
      profile: join(work, `chrome-${label}`),
      screenshot,
      roster: MANAGED_BOOT_ROSTER,
    },
  );
  assertManagedPolicyRuntime(started.observation, expected);
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
  const transportOverlay = await publishTransportOverlay(lifecycle.overlayDirectory);
  const controlName = `dsh-team-test-${lifecycle.runId}-control`;
  const control = await startWeb(
    lifecycle,
    controlName,
    transportOverlay,
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
    const chromeBin = chromeRequired();
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
      remaining,
      chromeBin,
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
    const nextOverlay = await publishOverlay(
      lifecycle.overlayDirectory,
      changed,
      API_KEY_VALUE.trim() !== '',
    );
    profiles.capture('recompose-published');
    await acceptManaged(
      lifecycle,
      nextOverlay,
      remaining,
      chromeBin,
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
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

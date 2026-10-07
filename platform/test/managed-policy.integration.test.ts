import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { execScript } from './managed-policy-fixture.ts';
import {
  browserEvidence,
  createManagedPolicyEvidence,
  managedPolicyEvidenceRoot,
} from './managed-policy-evidence.ts';
import {
  assertManagedPolicyRuntime,
  controlExposesEmployeePolicy,
  parseManagedPolicyRuntime,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';
import {
  assertRosterObservation,
  COMPOSITION_PLUGIN,
} from '../../scripts/probe-first-run-composition.mjs';

const MANAGED_CATALOG = [{ id: 'intranet', models: ['alpha', 'beta'] }] as const;
const CONTROL_CATALOG = [
  { id: 'intranet', models: ['alpha', 'beta'] },
  { id: 'personal', models: ['gamma'] },
  { id: 'deepseek-official', models: [] },
  { id: 'deepseek-account', models: [] },
] as const;

const EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  catalog: MANAGED_CATALOG,
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: ['standard', 'minimal', 'custom-office'],
  descriptions: { 'custom-office': 'brief-zh' },
  retainedTools: {
    standard: ['bash', 'read'],
    minimal: ['bash'],
    'custom-office': ['read', 'present'],
  },
};

const COMPLETE = {
  models: {
    intranetAddress: EXPECTED.intranetAddress,
    defaultModel: EXPECTED.defaultModel,
    catalog: EXPECTED.catalog,
    alphaContextWindow: EXPECTED.alphaContextWindow,
    betaContextWindow: EXPECTED.betaContextWindow,
  },
  presets: [
    { id: 'standard', description: '', toolNames: ['bash', 'read'] },
    { id: 'minimal', description: '', toolNames: ['bash'] },
    { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
  ],
};

it('rejects an incorrect context window even when the custom preset is present', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        models: { ...COMPLETE.models, alphaContextWindow: 128_000 },
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects network tools in a live preset inventory', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        presets: [
          ...COMPLETE.presets.slice(0, 2),
          { id: 'custom-office', description: 'brief-zh', toolNames: ['bash', 'web_search'] },
        ],
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects a nonempty inventory that dropped a known retained non-network tool', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        presets: [
          { id: 'standard', description: '', toolNames: ['bash', 'read'] },
          { id: 'minimal', description: '', toolNames: ['bash'] },
          { id: 'custom-office', description: 'brief-zh', toolNames: ['read'] },
        ],
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects a no-managed control that only exposes network tools on shipped presets', () => {
  const observation = parseManagedPolicyRuntime({
    models: {
      intranetAddress: 'http://127.0.0.1:8/v1',
      defaultModel: 'alpha',
      catalog: CONTROL_CATALOG,
      alphaContextWindow: 500_000,
      betaContextWindow: 262_144,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'web_search', 'web_fetch'] },
      { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
    ],
  });
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it('rejects a live-copy roster that reenables personal-model onboarding', () => {
  const expected = [
    COMPOSITION_PLUGIN,
    '@deepseek-ai/dsh-client-ui-model-selection',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ];
  expect(() => {
    assertRosterObservation(
      { ids: ['@deepseek-ai/dsh-client-ui-settings-models', ...expected].sort() },
      expected.sort(),
    );
  }).toThrow(/roster-mismatch/);
  expect(assertRosterObservation({ ids: [...expected].sort() }, [...expected].sort())).toEqual({
    ids: [...expected].sort(),
  });
});

type ResourceKind = 'image' | 'container' | 'volume';

const SECRET = 'sk-managed-policy-secret';
const FOREIGN_LABEL = 'foreign-owner';
const FOREIGN = {
  image: ['foreign-image', FOREIGN_LABEL] as const,
  container: ['foreign-container', FOREIGN_LABEL] as const,
  volume: ['foreign-volume', FOREIGN_LABEL] as const,
};
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const START_OBSERVATION = {
  models: {
    intranetAddress: 'http://127.0.0.1:9/v1',
    defaultModel: 'beta',
    catalog: MANAGED_CATALOG,
    alphaContextWindow: 500_000,
    betaContextWindow: 262_144,
  },
  presets: [{ id: 'standard', description: '', toolNames: ['bash', 'read'] }],
};
const CONTROL_OBSERVATION = {
  models: {
    intranetAddress: 'http://127.0.0.1:8/v1',
    defaultModel: 'alpha',
    catalog: CONTROL_CATALOG,
    alphaContextWindow: 500_000,
    betaContextWindow: 262_144,
  },
  presets: [{ id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] }],
};
const BROWSER_UI = { chinese: true, noNotice: true };
const BROWSER_HOST = { hostname: 'dsh-team-managed.invalid' };
const BROWSER_INPUT = { typed: true, cleared: true, modelSend: false };
const BROWSER_PRESERVATION = {
  general: true,
  listed: ['alpha', 'beta'],
  selected: ['alpha', 'beta'],
  defaultModel: 'beta',
  exactModels: ['alpha', 'beta'],
};
const BROWSER_BINDING = {
  workBound: true,
  workBoundUnknown: false,
  readiness: 'composition' as const,
  consoleErrors: [] as unknown[],
};
const START_BROWSER = {
  accepted: true,
  initialized: true,
  screenshot: { screenshot: '/tmp/start.png' },
  reload: {
    accepted: true,
    initialized: true,
    screenshot: { screenshot: '/tmp/start-reload.png' },
    ui: BROWSER_UI,
    host: BROWSER_HOST,
    input: BROWSER_INPUT,
  },
  preservation: {
    ...BROWSER_PRESERVATION,
    screenshot: { screenshot: '/tmp/start-preservation.png' },
  },
  ui: { ...BROWSER_UI, workspaceSelected: true },
  host: BROWSER_HOST,
  input: BROWSER_INPUT,
  ...BROWSER_BINDING,
  bootRoster: { ids: ['@deepseek-ai/dsh-client-ui-model-selection'] },
};
const START_BROWSER_EVIDENCE = {
  accepted: true,
  initialized: true,
  screenshot: '/tmp/start.png',
  reload: {
    accepted: true,
    screenshot: '/tmp/start-reload.png',
    initialized: true,
    ui: BROWSER_UI,
    host: BROWSER_HOST,
    input: BROWSER_INPUT,
  },
  preservation: { ...BROWSER_PRESERVATION, screenshot: '/tmp/start-preservation.png' },
  ui: { ...BROWSER_UI, workspaceSelected: true },
  host: BROWSER_HOST,
  input: BROWSER_INPUT,
  ...BROWSER_BINDING,
  bootRoster: ['@deepseek-ai/dsh-client-ui-model-selection'],
};
const REVIEWED_HEAD = '6fc2aef11dd6299f545c672641c2827b8d949366';

function foreignInventory(
  extras: {
    container?: readonly (readonly [string, string])[];
    volume?: readonly (readonly [string, string])[];
  } = {},
) {
  return {
    image: [FOREIGN.image],
    container: [FOREIGN.container, ...(extras.container ?? [])],
    volume: [FOREIGN.volume, ...(extras.volume ?? [])],
  };
}

async function withReviewedHead<T>(body: () => Promise<T>): Promise<T> {
  const previousHead = process.env.DSH_TEAM_REVIEWED_HEAD;
  const previousGithubHead = process.env.GITHUB_SHA;
  process.env.DSH_TEAM_REVIEWED_HEAD = REVIEWED_HEAD;
  process.env.GITHUB_SHA = REVIEWED_HEAD;
  try {
    return await body();
  } finally {
    if (previousHead === undefined) delete process.env.DSH_TEAM_REVIEWED_HEAD;
    else process.env.DSH_TEAM_REVIEWED_HEAD = previousHead;
    if (previousGithubHead === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousGithubHead;
  }
}

function restoreEvidence(runId: string): void {
  if (runId !== '') rmSync(managedPolicyEvidenceRoot(runId), { recursive: true, force: true });
}

function helperNames(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('-helper'));
}

function openEvidence(lifecycle: UserImageLifecycle) {
  const evidence = createManagedPolicyEvidence(lifecycle);
  const root = managedPolicyEvidenceRoot(lifecycle.runId);
  return { evidence, runId: lifecycle.runId, root, path: evidence.path };
}

function writeScreenshot(root: string, label: 'start' | 'restart', body: string): string {
  const screenshot = join(root, `${label}.png`);
  writeFileSync(screenshot, body);
  return screenshot;
}

function startControlRecord(screenshot: string) {
  return {
    startPort: 43127,
    startScreenshot: screenshot,
    startObservation: START_OBSERVATION,
    startBrowser: browserEvidence(START_BROWSER),
    controlObservation: CONTROL_OBSERVATION,
    controlRejected: true as const,
  };
}

function startControlRetained(runId: string, screenshot: string) {
  return {
    imageId: IMAGE_ID,
    runId,
    reviewedHead: REVIEWED_HEAD,
    startPort: 43127,
    startScreenshot: screenshot,
    startObservation: START_OBSERVATION,
    startBrowser: START_BROWSER_EVIDENCE,
    controlObservation: CONTROL_OBSERVATION,
    controlRejected: true,
  };
}

async function runHelperScript(
  command: DockerCommand,
  after: (lifecycle: UserImageLifecycle) => Promise<string>,
): Promise<{ runId: string; error: unknown }> {
  let runId = '';
  const scenario = (lifecycle: UserImageLifecycle): Promise<string> => {
    runId = lifecycle.runId;
    execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-helper`, 'process.stdout.write("ok")');
    return after(lifecycle);
  };
  try {
    await runUserImage('managed-policy', () => undefined, command, scenario);
    return { runId, error: undefined };
  } catch (error) {
    return { runId, error };
  }
}

function ok(stdout = ''): DockerCommandResult {
  return { status: 0, stdout, stderr: '' };
}

function secretTexts(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.includes(SECRET) ? [value] : [];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const texts: string[] = [];
  if (value instanceof Error) {
    texts.push(
      ...secretTexts(value.message, seen),
      ...secretTexts(value.stack, seen),
      ...secretTexts(value.cause, seen),
    );
    if (value instanceof AggregateError) texts.push(...secretTexts(value.errors, seen));
  }
  for (const key of Reflect.ownKeys(value)) {
    texts.push(...secretTexts(Reflect.get(value, key), seen));
  }
  return texts;
}

function remainingEntries(resources: Record<ResourceKind, Map<string, string>>) {
  return {
    image: [...resources.image.entries()],
    container: [...resources.container.entries()],
    volume: [...resources.volume.entries()],
  };
}

function helperDaemon(options: {
  volumeLabel?: 'owned' | 'foreign' | 'missing';
  inspectImage?: string;
  inspectMount?: { Name: string; Destination: string; RW: boolean };
  failFirstOwnedRemoval?: boolean;
  failLaterOperation?: string;
}): {
  command: DockerCommand;
  resources: Record<ResourceKind, Map<string, string>>;
  created: string[];
  started: string[];
  failedRemovals: string[];
} {
  const resources: Record<ResourceKind, Map<string, string>> = {
    image: new Map([FOREIGN.image]),
    container: new Map([FOREIGN.container]),
    volume: new Map([FOREIGN.volume]),
  };
  const created: string[] = [];
  const started: string[] = [];
  const failedRemovals: string[] = [];
  const outputs = new Map<string, string>();
  const labelOf = (args: readonly string[]): string =>
    args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
  const remember = (kind: ResourceKind, name: string, label: string): void => {
    resources[kind].set(name, label);
  };
  const build = (args: readonly string[]): DockerCommandResult => {
    remember('image', args[args.indexOf('--tag') + 1] ?? '', labelOf(args));
    return ok();
  };
  const createVolume = (args: readonly string[]): DockerCommandResult => {
    const name = args.at(-1) ?? '';
    remember('volume', name, labelOf(args));
    if (name.endsWith('-state')) {
      if (options.volumeLabel === 'foreign') resources.volume.set(name, FOREIGN_LABEL);
      if (options.volumeLabel === 'missing') resources.volume.set(name, '');
    }
    return ok(name);
  };
  const createContainer = (args: readonly string[]): DockerCommandResult => {
    const name = args[args.indexOf('--name') + 1] ?? '';
    remember('container', name, labelOf(args));
    created.push(name);
    const script = args[args.indexOf('-e') + 1] ?? '';
    const prefix = 'process.stdout.write(';
    outputs.set(
      name,
      script.startsWith(prefix) && script.endsWith(')')
        ? (JSON.parse(script.slice(prefix.length, -1)) as string)
        : '',
    );
    return ok();
  };
  const inspectMounts = (): DockerCommandResult => {
    const volumeName =
      [...resources.volume.keys()].find((candidate) => candidate.endsWith('-state')) ?? '';
    const mount = options.inspectMount ?? {
      Type: 'volume',
      Name: volumeName,
      Destination: '/data/home',
      RW: true,
    };
    return ok(JSON.stringify([{ Type: 'volume', ...mount }]));
  };
  const inspectResource = (args: readonly string[]): DockerCommandResult => {
    const kind = args[0] as ResourceKind;
    const name = args.at(-1) ?? '';
    if (!resources[kind].has(name)) {
      return { status: 1, stdout: '', stderr: `Error: No such ${kind}: ${name}` };
    }
    if (args[0] === 'image' && args.includes('{{.Id}}')) return ok(`${IMAGE_ID}\n`);
    if (args.includes('{{json .Mounts}}')) return inspectMounts();
    if (args.includes('{{json .}}')) {
      return ok(JSON.stringify({ Image: options.inspectImage ?? IMAGE_ID }));
    }
    return ok(`${resources[kind].get(name) ?? ''}\n`);
  };
  const runContainer = (args: readonly string[]): DockerCommandResult => {
    if (options.failLaterOperation !== undefined && args[0] === options.failLaterOperation) {
      return { status: 1, stdout: SECRET, stderr: SECRET };
    }
    if (args[0] === 'start') started.push(args.at(-1) ?? '');
    if (args[0] === 'wait') return ok('0\n');
    if (args[0] === 'logs') return ok(outputs.get(args.at(-1) ?? '') ?? '');
    return ok();
  };
  const removeResource = (args: readonly string[]): DockerCommandResult => {
    const kind = (args[0] === 'rm' ? 'container' : args[0]) as ResourceKind;
    const name = args.at(-1) ?? '';
    if (name.startsWith('foreign-')) {
      return { status: 1, stdout: SECRET, stderr: SECRET };
    }
    if (options.failFirstOwnedRemoval === true && failedRemovals.length === 0) {
      failedRemovals.push(name);
      return { status: 1, stdout: SECRET, stderr: SECRET };
    }
    resources[kind].delete(name);
    return ok();
  };
  const command: DockerCommand = (args) => {
    if (args[0] === 'version') return ok('29.1.3');
    if (args[0] === 'build') return build(args);
    if (args[0] === 'volume' && args[1] === 'create') return createVolume(args);
    if (args[0] === 'create') return createContainer(args);
    if (args[1] === 'inspect') return inspectResource(args);
    if (args[0] === 'start' || args[0] === 'wait' || args[0] === 'logs' || args[0] === 'stop') {
      return runContainer(args);
    }
    if (args[0] === 'rm' || args[1] === 'rm') return removeResource(args);
    return ok();
  };
  return { command, resources, created, started, failedRemovals };
}

it('cleans acquired helper resources after a post-create scenario failure without leaking secrets', async () => {
  const daemon = helperDaemon({ failFirstOwnedRemoval: true });
  const { runId, error } = await runHelperScript(daemon.command, () =>
    Promise.reject(new Error('acquired helper failed after create')),
  );
  expect(error).toBeDefined();
  expect(secretTexts(error)).toEqual([]);
  expect(inspect(error)).toMatch(/acquired helper failed after create|Web Docker operation failed/);
  const helper = `dsh-team-test-${runId}-helper`;
  expect(helperNames(daemon.created)).toEqual([helper]);
  expect(daemon.failedRemovals).toEqual([helper]);
  expect(remainingEntries(daemon.resources)).toEqual(
    foreignInventory({ container: [[helper, runId]] }),
  );
});

it('retains a completed start and restart summary after owned Docker cleanup', async () => {
  const daemon = helperDaemon({});
  let artifactPath = '';
  let startScreenshot = '';
  let restartScreenshot = '';
  let runId = '';
  await withReviewedHead(async () => {
    try {
      const result = await runUserImage(
        'managed-policy',
        () => undefined,
        daemon.command,
        (lifecycle) => {
          const opened = openEvidence(lifecycle);
          runId = opened.runId;
          artifactPath = opened.path;
          startScreenshot = writeScreenshot(opened.root, 'start', 'fixture-start');
          restartScreenshot = writeScreenshot(opened.root, 'restart', 'fixture-restart');
          opened.evidence.record(startControlRecord(startScreenshot));
          opened.evidence.record({
            restartPort: 43128,
            restartScreenshot,
            restartObservation: START_OBSERVATION,
            restartBrowser: browserEvidence(START_BROWSER),
          });
          return Promise.resolve(opened.evidence.finish());
        },
      );
      const retained = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
      expect(retained).toEqual({
        ...startControlRetained(runId, startScreenshot),
        restartPort: 43128,
        restartScreenshot,
        restartObservation: START_OBSERVATION,
        restartBrowser: START_BROWSER_EVIDENCE,
      });
      expect(existsSync(startScreenshot)).toBe(true);
      expect(existsSync(restartScreenshot)).toBe(true);
      expect(secretTexts(retained)).toEqual([]);
      expect(result.stdout).toBe(JSON.stringify(retained));
      expect(remainingEntries(daemon.resources)).toEqual(foreignInventory());
    } finally {
      restoreEvidence(runId);
    }
  });
});

it.each(['foreign', 'missing'] as const)(
  'refuses helper create when the state volume owner is %s',
  async (volumeLabel) => {
    const daemon = helperDaemon({ volumeLabel });
    const { runId, error } = await runHelperScript(daemon.command, () =>
      Promise.resolve('unreachable'),
    );
    expect(error).toBeDefined();
    expect(secretTexts(error)).toEqual([]);
    expect(inspect(error)).toContain('Web volume ownership mismatch');
    expect(helperNames(daemon.created)).toEqual([]);
    expect(helperNames(daemon.started)).toEqual([]);
    expect(remainingEntries(daemon.resources)).toEqual(
      foreignInventory({
        volume: [[`dsh-team-test-${runId}-state`, volumeLabel === 'foreign' ? FOREIGN_LABEL : '']],
      }),
    );
  },
);

it.each([
  ['image', { inspectImage: 'sha256:wrong' }],
  [
    'mount',
    {
      inspectMount: { Name: 'foreign-volume', Destination: '/data/home', RW: true },
    },
  ],
] as const)(
  'refuses helper start when the created container %s observation is wrong',
  async (_kind, inspectFault) => {
    const daemon = helperDaemon(inspectFault);
    const { runId, error } = await runHelperScript(daemon.command, () =>
      Promise.resolve('unreachable'),
    );
    expect(error).toBeDefined();
    expect(secretTexts(error)).toEqual([]);
    expect(inspect(error)).toMatch(
      /Invalid managed policy runtime observation|Web Docker operation failed/,
    );
    const helper = `dsh-team-test-${runId}-helper`;
    expect(helperNames(daemon.created)).toEqual([helper]);
    expect(helperNames(daemon.started)).toEqual([]);
    expect(remainingEntries(daemon.resources)).toEqual(foreignInventory());
  },
);

it('retains acquired start and control observations after a later Docker stage failure', async () => {
  const daemon = helperDaemon({ failLaterOperation: 'stop' });
  let artifactPath = '';
  let screenshotPath = '';
  let runId = '';
  await withReviewedHead(async () => {
    try {
      let failure: unknown;
      try {
        await runUserImage(
          'managed-policy',
          () => undefined,
          daemon.command,
          (lifecycle) => {
            const opened = openEvidence(lifecycle);
            runId = opened.runId;
            artifactPath = opened.path;
            screenshotPath = writeScreenshot(opened.root, 'start', 'fixture-screenshot');
            const observed = JSON.parse(
              execScript(
                lifecycle,
                `dsh-team-test-${lifecycle.runId}-observe`,
                `process.stdout.write(${JSON.stringify(JSON.stringify(START_OBSERVATION))})`,
              ),
            ) as unknown;
            expect(observed).toEqual(START_OBSERVATION);
            opened.evidence.record(startControlRecord(screenshotPath));
            expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual(
              startControlRetained(runId, screenshotPath),
            );
            const stopped = lifecycle.command(
              ['stop', `dsh-team-test-${lifecycle.runId}-observe`],
              30_000,
            );
            if (stopped.error !== undefined || stopped.status !== 0) {
              opened.evidence.fail('restart');
              throw new Error('Web Docker operation failed');
            }
            return Promise.resolve(opened.evidence.finish());
          },
        );
        throw new Error('must fail after acquired observations');
      } catch (error) {
        failure = error;
      }
      expect(secretTexts(failure)).toEqual([]);
      expect(inspect(failure)).toContain('Web Docker operation failed');
      const retained = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
      expect(retained).toEqual({
        ...startControlRetained(runId, screenshotPath),
        failed: true,
        failedStage: 'restart',
      });
      expect(existsSync(screenshotPath)).toBe(true);
      expect(secretTexts(retained)).toEqual([]);
      expect(remainingEntries(daemon.resources)).toEqual(foreignInventory());
    } finally {
      restoreEvidence(runId);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { assertOfflinePluginObservation } from './offline-plugin-fixture.ts';
import type { OfflinePluginObservation } from './offline-plugin-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const imageId = `sha256:${'d'.repeat(64)}`;
const SENTINEL = ['dsh-team-test-sentinel', 'sentinel-owner'] as const;
const IDENTITY = '{{.HostConfig.NetworkMode}} {{.Config.User}}';
// The registry stand-in's probe plugin metadata and tarball requests, written out independently.
const METADATA = 'GET /dsh-team-probe-plugin';
const TARBALL = 'GET /dsh-team-probe-plugin/-/dsh-team-probe-plugin-1.0.0.tgz';
// The catalog's packages, sorted, before and after the probe plugin is added.
const PACKAGES = [
  '@dsh-team/knowledge-base',
  '@dsh-team/office-agents',
  '@dsh-team/office-hints',
  '@dsh-team/permission-tiers',
  '@dsh-team/platform-nav',
  '@dsh-team/zh-locale',
  'dsh-better-sidebar',
  'dsh-sidebar-onlyoffice',
];
const WITH_PROBE = [...PACKAGES, 'dsh-team-probe-plugin'];

const step = (name: string, requests: readonly string[]) => ({
  name,
  status: 0,
  signal: null,
  timedOut: false,
  requests,
  tail: `${name} done`,
});
const state = (registered: readonly string[]) => ({
  sidebar: { version: '0.28.0', directory: true },
  nested: {
    'dsh-better-sidebar': { canonical: 12, profile: 12 },
    'dsh-sidebar-onlyoffice': { canonical: 4, profile: 4 },
  },
  top: registered,
  dependencies: registered,
  hoisted: [],
  dump: { status: 0, diagnostics: [] },
});
/** A passing run: three steps, both bundled copies stripped, then the old-volume add. */
function accepted(): OfflinePluginObservation {
  return {
    uid: 1001,
    bundled: ['dsh-better-sidebar', 'dsh-sidebar-onlyoffice'],
    nestedNames: ['@deepseek-ai/schemastery', 'cordis', 'yaml'],
    steps: [
      step('add', [METADATA, TARBALL, 'GET /npm']),
      step('remove', [METADATA]),
      step('install', [METADATA, 'GET /pnpm']),
    ],
    state: state(PACKAGES),
    stripped: [
      { id: 'dsh-better-sidebar', uid: 1001, modeBefore: 0o444, modeAfter: 0o644 },
      { id: 'dsh-sidebar-onlyoffice', uid: 1001, modeBefore: 0o644, modeAfter: 0o644 },
    ],
    oldVolume: { step: step('add', [METADATA]), state: state(WITH_PROBE) },
  };
}
const EVIDENCE =
  'requests add=3 remove=1 install=2 add=1 nested=' +
  '{"dsh-better-sidebar":{"canonical":12,"profile":12},"dsh-sidebar-onlyoffice":{"canonical":4,"profile":4}}';

type Fault = 'create' | 'identity' | 'timeout' | 'exit';

/** Substitute daemon boundary for the offline-plugin probe: owned resources and every call. */
function daemon(fault?: Fault, logs = JSON.stringify(accepted())) {
  const resources = new Map<string, string>([SENTINEL]);
  const calls: { args: readonly string[]; timeout: number }[] = [];
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const absent = (kind: string, name: string): DockerCommandResult => ({
    status: 1,
    stdout: '',
    stderr: `Error response from daemon: No such ${kind}: ${name}\n`,
  });
  function inspect(kind: string, args: readonly string[]): DockerCommandResult {
    const name = args.at(-1) ?? '';
    const owner = resources.get(name);
    if (owner === undefined) return absent(kind, name);
    if (args.includes('{{.Id}}')) return ok(`${imageId}\n`);
    if (args.includes(IDENTITY)) return ok(fault === 'identity' ? 'none dsh\n' : 'none 1001\n');
    return ok(`${owner}\n`);
  }
  // A built tag or created container is owned by its invocation label.
  function own(args: readonly string[], flag: '--tag' | '--name'): DockerCommandResult {
    const label = (args[args.indexOf('--label') + 1] ?? '').split('=')[1] ?? '';
    resources.set(args[args.indexOf(flag) + 1] ?? '', label);
    return ok();
  }
  function wait(): DockerCommandResult {
    if (fault !== 'timeout') return ok(fault === 'exit' ? '1\n' : '0\n');
    // createDockerCommands' shape for a process killed at its bound.
    const error = Object.assign(new Error('Docker process failed: ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    return { status: null, stdout: '', stderr: '', error, signal: 'SIGKILL' };
  }
  const command: DockerCommand = (args, timeout) => {
    calls.push({ args: [...args], timeout });
    const [operation, subcommand] = args;
    if (operation === 'version') return ok('28.0.0\n');
    if (operation === 'build') return own(args, '--tag');
    if (operation === 'create') {
      const created = own(args, '--name');
      // The daemon may leave the named container behind even when create reports failure.
      return fault === 'create'
        ? { status: 1, stdout: '', stderr: 'Error response from daemon: create interrupted\n' }
        : created;
    }
    if (operation === 'start') return ok();
    if (operation === 'wait') return wait();
    if (operation === 'logs') return ok(logs);
    if (subcommand === 'inspect') return inspect(operation ?? '', args);
    if (subcommand === 'rm') {
      resources.delete(args.at(-1) ?? '');
      return ok();
    }
    throw new Error(`Unexpected Docker boundary call: ${args.join(' ')}`);
  };
  const operations = () => calls.map(({ args }) => args[0]);
  const created = () => {
    const create = calls.find(({ args }) => args[0] === 'create')?.args ?? [];
    return create[create.indexOf('--name') + 1] ?? '';
  };
  const removed = (name: string) =>
    calls.some(({ args }) => args.join(' ') === `container rm --force --volumes ${name}`);
  return { command, calls, resources, operations, created, removed };
}

describe('offline-plugin user-image probe', () => {
  it('creates the probe as uid1001 without a network under the run label, waits 780s and judges the logs', () => {
    const fake = daemon();
    let evidence = '';

    const result = runUserImage(
      'offline-plugin',
      (stdout) => {
        evidence = assertOfflinePluginObservation(stdout, PACKAGES);
      },
      fake.command,
    );

    const start = fake.calls.findIndex(({ args }) => args[0] === 'create');
    const create = fake.calls[start]?.args ?? [];
    const image = create.indexOf(imageId);
    expect(create.slice(1, image)).toEqual([
      '--user',
      '1001',
      '--network',
      'none',
      '--name',
      result.container,
      '--label',
      `dsh-team.test-run=${result.runId}`,
    ]);
    expect(create.slice(image + 1, -1)).toEqual(['node', '--input-type=module', '-e']);
    expect(fake.calls.slice(start + 1, start + 5)).toEqual([
      { args: ['container', 'inspect', '--format', IDENTITY, result.container], timeout: 30_000 },
      { args: ['start', result.container], timeout: 30_000 },
      { args: ['wait', result.container], timeout: 780_000 },
      { args: ['logs', result.container], timeout: 30_000 },
    ]);
    expect(evidence).toBe(EVIDENCE);
    expect(result.stdout).toBe(JSON.stringify(accepted()));
    expect([...fake.resources]).toEqual([SENTINEL]);
  });

  it('registers the container before create, so a create that fails after naming it still removes it', () => {
    const fake = daemon('create');

    expect(() => runUserImage('offline-plugin', () => undefined, fake.command)).toThrow(
      'create interrupted',
    );
    expect(fake.removed(fake.created())).toBe(true);
    expect(fake.operations()).not.toContain('start');
    expect([...fake.resources]).toEqual([SENTINEL]);
  });

  it('refuses to start a probe whose inspect is not network none and user 1001', () => {
    const fake = daemon('identity');

    expect(() => runUserImage('offline-plugin', () => undefined, fake.command)).toThrow(
      'Expected network none and user 1001, got none dsh',
    );
    expect(fake.operations()).not.toContain('start');
    expect(fake.removed(fake.created())).toBe(true);
    expect([...fake.resources]).toEqual([SENTINEL]);
  });

  it('fails a wait killed at its 780s bound without reading the logs as success', () => {
    const fake = daemon('timeout');
    let judged = false;

    expect(() =>
      runUserImage(
        'offline-plugin',
        () => {
          judged = true;
        },
        fake.command,
      ),
    ).toThrow(/docker wait dsh-team-test-.+-offline-plugin failed \(null\): .*ETIMEDOUT/);
    expect(judged).toBe(false);
    expect(fake.operations()).not.toContain('logs');
    expect(fake.calls.find(({ args }) => args[0] === 'wait')?.timeout).toBe(780_000);
    expect(fake.removed(fake.created())).toBe(true);
    expect([...fake.resources]).toEqual([SENTINEL]);
  });

  it('reports a nonzero exit with the partial observation and its failure from the logs', () => {
    const partial = JSON.stringify({
      ...accepted(),
      steps: [step('add', [METADATA, TARBALL])],
      failure: 'Error: profile copy not owned by the employee',
    });
    const fake = daemon('exit', partial);
    let judged = false;

    expect(() =>
      runUserImage(
        'offline-plugin',
        () => {
          judged = true;
        },
        fake.command,
      ),
    ).toThrow(`offline-plugin container exited 1:\n${partial}\n`);
    expect(partial).toContain('"failure":"Error: profile copy not owned by the employee"');
    expect(judged).toBe(false);
    expect([...fake.resources]).toEqual([SENTINEL]);
  });
});

describe('offline-plugin observation oracle', () => {
  it('accepts a passing run and reports each step request count and the nested copies', () => {
    expect(assertOfflinePluginObservation(JSON.stringify(accepted()), PACKAGES)).toBe(EVIDENCE);
  });

  // Vitest truncates the message; the assertion's own actual/expected name the mutated item.
  it.each([
    [
      'a failure',
      (o: OfflinePluginObservation) => ({ ...o, failure: 'Error: registry down' }),
      { actual: 'Error: registry down', expected: undefined },
    ],
    [
      'another uid',
      (o: OfflinePluginObservation) => ({ ...o, uid: 1000 }),
      { actual: 1000, expected: 1001 },
    ],
    [
      'a missing step',
      (o: OfflinePluginObservation) => ({ ...o, steps: o.steps.slice(0, 2) }),
      { expected: ['install', 0, null, undefined, false] },
    ],
    [
      'an extra step',
      (o: OfflinePluginObservation) => ({ ...o, steps: [...o.steps, step('repair', [METADATA])] }),
      { actual: step('repair', [METADATA]), expected: undefined },
    ],
    [
      'a request naming a nested closure package',
      (o: OfflinePluginObservation) => ({
        ...o,
        steps: o.steps.map((entry) =>
          entry.name === 'remove'
            ? { ...entry, requests: [...entry.requests, 'GET /@deepseek-ai%2fschemastery'] }
            : entry,
        ),
      }),
      { actual: ['@deepseek-ai/schemastery'], expected: [] },
    ],
  ] as const)('rejects %s', (_name, change, mismatch) => {
    expect(() =>
      assertOfflinePluginObservation(JSON.stringify(change(accepted())), PACKAGES),
    ).toThrow(expect.objectContaining(mismatch));
  });
});

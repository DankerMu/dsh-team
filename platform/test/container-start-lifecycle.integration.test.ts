import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const NETWORK_ID = 'b'.repeat(64);

function inspectReply(
  args: readonly string[],
  labels: Record<string, string> | undefined,
): DockerCommandResult {
  if (labels === undefined) {
    const kind = args[0] ?? '';
    const name = args.at(-1) ?? '';
    return {
      status: 1,
      stdout: args.includes('--format') ? '\n' : '[]\n',
      stderr:
        kind === 'volume'
          ? `Error response from daemon: get ${name}: no such volume\n`
          : `Error response from daemon: No such ${kind}: ${name}\n`,
    };
  }
  const format = args[args.indexOf('--format') + 1] ?? '';
  if (format === '{{.Id}}') return { status: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
  const label = /"([^"]+)"/.exec(format)?.[1];
  return {
    status: 0,
    stdout: label === undefined ? '{}' : `${labels[label] ?? ''}\n`,
    stderr: '',
  };
}

function networkCommand(
  args: readonly string[],
  resources: Map<string, Record<string, string>>,
  sentinel: string,
): DockerCommandResult | undefined {
  if (args[1] === 'ls') {
    const owner = (args[args.indexOf('--filter') + 1] ?? '').split('=').slice(2).join('=');
    const present = [...resources].some(
      ([key, labels]) => key.startsWith('network:') && labels['dsh-team.test-run'] === owner,
    );
    return { status: 0, stdout: present ? `${NETWORK_ID}\n` : '', stderr: '' };
  }
  const name = args.at(-1) ?? '';
  const entry = [...resources].find(
    ([key]) =>
      key.startsWith('network:') &&
      (key === `network:${name}` || (name === NETWORK_ID && !key.endsWith(sentinel))),
  );
  if (args[1] === 'inspect' && entry !== undefined && !args.includes('--format')) {
    return {
      status: 0,
      stdout: JSON.stringify([
        {
          Id: entry[0].endsWith(sentinel) ? 'c'.repeat(64) : NETWORK_ID,
          Name: entry[0].slice('network:'.length),
          Labels: entry[1],
          Containers: {},
        },
      ]),
      stderr: '',
    };
  }
  if (args[1] === 'rm' && entry !== undefined) {
    resources.delete(entry[0]);
    return { status: 0, stdout: '', stderr: '' };
  }
  return undefined;
}

function lifecycleDaemon() {
  const sentinel = 'dsh-team-test-unrelated-sentinel';
  const resources = new Map<string, Record<string, string>>([
    [`container:${sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`volume:${sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
  ]);
  const calls: { args: readonly string[]; timeout: number }[] = [];
  const command: DockerCommand = (args, timeout) => {
    calls.push({ args, timeout });
    const kind = args[0] ?? '';
    const name = args.at(-1) ?? '';
    if (kind === 'version') return { status: 0, stdout: '29.1.3\n', stderr: '' };
    if (kind === 'build') {
      const tag = args[args.indexOf('--tag') + 1] ?? '';
      const label = args[args.indexOf('--label') + 1] ?? '';
      const delimiter = label.indexOf('=');
      resources.set(`image:${tag}`, { [label.slice(0, delimiter)]: label.slice(delimiter + 1) });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (kind === 'network') {
      const result = networkCommand(args, resources, sentinel);
      if (result !== undefined) return result;
    }
    const key = `${kind}:${name}`;
    if (args[1] === 'inspect') return inspectReply(args, resources.get(key));
    if (args[1] === 'rm') {
      resources.delete(key);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error('Unexpected lifecycle fixture Docker operation');
  };
  return { command, resources, calls, sentinel };
}

it('registers absent startup resources and verifies cleanup with observed Docker CLI output', async () => {
  const daemon = lifecycleDaemon();

  const result = await runUserImage(
    'container-start',
    () => undefined,
    daemon.command,
    (lifecycle) => {
      const ownership = { 'dsh-team.user': 'abcdefghijkl' };
      const container = 'dsh-team-u-abcdefghijkl';
      lifecycle.registerResource('volume', lifecycle.stateVolume, ownership);
      lifecycle.registerResource('container', container, ownership);
      const image = `dsh-team-test-${lifecycle.runId}:mutable`;
      const imageOwnership = { 'dsh-team.test-run': lifecycle.runId };
      lifecycle.registerResource('image', image, imageOwnership);
      daemon.resources.set(`image:${image}`, imageOwnership);
      daemon.resources.set(`volume:${lifecycle.stateVolume}`, ownership);
      daemon.resources.set(`container:${container}`, ownership);
      return Promise.resolve('startup scenario completed');
    },
  );

  expect(result.stdout).toBe('startup scenario completed');
  expect([...daemon.resources.entries()]).toEqual([
    [`container:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`volume:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
  ]);
});

it.each([
  ['nonempty resource list', { stdout: '[{"Id":"present"}]\n' }],
  ['resource object', { stdout: '{}\n' }],
  ['unrelated stdout', { stdout: 'daemon failed\n' }],
  ['successful exit', { status: 0 }],
  ['other failure exit', { status: 2 }],
  ['missing exit status', { status: null }],
  ['process error', { error: new Error('process failed') }],
  ['wrong target', { stderr: 'Error response from daemon: No such container: other-target\n' }],
  [
    'wrong resource kind',
    { stderr: 'Error response from daemon: No such volume: dsh-team-target\n' },
  ],
  ['generic failure', { stderr: 'Cannot connect to the Docker daemon\n' }],
  [
    'extra diagnostic',
    { stderr: 'Error response from daemon: No such container: dsh-team-target\nother failure\n' },
  ],
] as const)(
  'refuses startup cleanup authority when absence inspection returns %s',
  async (_name, invalid) => {
    const daemon = lifecycleDaemon();
    const target = 'dsh-team-target';
    const command: DockerCommand = (args, timeout) => {
      const result = daemon.command(args, timeout);
      return args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === target
        ? { ...result, ...invalid }
        : result;
    };

    await expect(
      runUserImage(
        'container-start',
        () => undefined,
        command,
        (lifecycle) => {
          lifecycle.registerResource('container', target, { 'dsh-team.user': 'abcdefghijkl' });
          return Promise.resolve('unexpected cleanup authority');
        },
      ),
    ).rejects.toThrow(/already exists/);

    expect([...daemon.resources.entries()]).toEqual([
      [`container:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
      [`volume:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    ]);
    expect(daemon.calls.some((call) => call.args[1] === 'rm' && call.args.at(-1) === target)).toBe(
      false,
    );
  },
);

it.each(['partial create', 'assertion failure'])(
  'cleans pre-registered exact startup resources after %s without touching unrelated sentinels',
  async (failure) => {
    const daemon = lifecycleDaemon();
    const created: string[] = [];

    await expect(
      runUserImage(
        'container-start',
        () => {
          if (failure === 'assertion failure') throw new Error('Induced assertion failure');
        },
        daemon.command,
        (lifecycle) => {
          const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
          const ownership = { 'dsh-team.user': userId };
          const container = `dsh-team-u-${userId}`;
          const helper = `dsh-team-compose-${userId}-fixture`;
          lifecycle.registerResource('volume', lifecycle.stateVolume, ownership);
          lifecycle.registerResource('volume', lifecycle.workVolume, ownership);
          lifecycle.registerResource('container', container, ownership);
          lifecycle.registerResource('container', helper, {
            ...ownership,
            'dsh-team.role': 'managed-composition',
            'dsh-team.invocation': lifecycle.runId,
          });
          for (const [kind, name, labels] of [
            ['volume', lifecycle.stateVolume, ownership],
            ['volume', lifecycle.workVolume, ownership],
            [
              'container',
              helper,
              {
                ...ownership,
                'dsh-team.role': 'managed-composition',
                'dsh-team.invocation': lifecycle.runId,
              },
            ],
            ['container', container, ownership],
          ] as const) {
            daemon.resources.set(`${kind}:${name}`, labels);
            created.push(`${kind}:${name}`);
            if (failure === 'partial create' && kind === 'container')
              throw new Error('Induced partial create failure');
          }
          return Promise.resolve('complete');
        },
      ),
    ).rejects.toThrow(/Induced/);

    expect([...daemon.resources.entries()]).toEqual([
      [`container:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
      [`volume:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    ]);
    for (const key of created) expect(daemon.resources.has(key)).toBe(false);
    expect(daemon.calls.every((call) => call.timeout > 0 && call.timeout <= 600_000)).toBe(true);
  },
);

it('refuses cleanup authority over a colliding startup resource before any create', async () => {
  const daemon = lifecycleDaemon();

  await expect(
    runUserImage(
      'container-start',
      () => undefined,
      daemon.command,
      (lifecycle) => {
        lifecycle.registerResource('container', daemon.sentinel, {
          'dsh-team.user': 'current-user',
        });
        return Promise.resolve('unreachable');
      },
    ),
  ).rejects.toThrow(/already exists/);

  expect(daemon.resources.get(`container:${daemon.sentinel}`)).toEqual({
    'dsh-team.user': 'other-owned-user',
  });
  expect(
    daemon.calls.some((call) => call.args[1] === 'rm' && call.args.at(-1) === daemon.sentinel),
  ).toBe(false);
});

it('reports original failure and refuses removal when startup resource ownership changes', async () => {
  const daemon = lifecycleDaemon();
  let target = '';

  const error: unknown = await runUserImage(
    'container-start',
    () => undefined,
    daemon.command,
    (lifecycle) => {
      target = `dsh-team-u-${lifecycle.runId.replaceAll('-', '').slice(0, 12)}`;
      lifecycle.registerResource('container', target, { 'dsh-team.user': 'abcdefghijkl' });
      daemon.resources.set(`container:${target}`, { 'dsh-team.user': 'foreign-owner' });
      throw new Error('Original startup assertion');
    },
  ).catch((failure: unknown) => failure);

  expect(String(error)).toContain('Original startup assertion');
  expect(String(error)).toContain('invocation label does not match');
  expect(daemon.resources.get(`container:${target}`)).toEqual({ 'dsh-team.user': 'foreign-owner' });
});

it('network-aware cleanup independently inventories owned resources and removes containers before their bridge', async () => {
  const daemon = lifecycleDaemon();
  const container = 'dsh-team-u-abcdefghijkl';
  const network = 'dsh-team-net-abcdefghijkl';
  const sentinelOwnership = {
    'dsh-team.user': 'other-owned-user',
    'dsh-team.test-run': 'other-invocation',
  };
  daemon.resources.set(`network:${daemon.sentinel}`, sentinelOwnership);
  const command: DockerCommand = (args, timeout) => {
    if (args[0] === 'network' && args[1] === 'rm' && daemon.resources.has(`container:${container}`))
      return { status: 1, stdout: '', stderr: 'network has active endpoints' };
    return daemon.command(args, timeout);
  };

  await expect(
    runUserImage(
      'container-start',
      () => undefined,
      command,
      (lifecycle) => {
        const ownership = {
          'dsh-team.user': 'abcdefghijkl',
          'dsh-team.test-run': lifecycle.runId,
        };
        // Both exact targets are registered before their external creation, even for partial failure.
        lifecycle.registerResource('network', network, ownership);
        lifecycle.registerResource('container', container, ownership);
        daemon.resources.set(`network:${network}`, ownership);
        daemon.resources.set(`container:${container}`, ownership);
        throw new Error('Induced network scenario failure');
      },
    ),
  ).rejects.toThrow('Induced network scenario failure');

  expect([...daemon.resources]).toEqual([
    [`container:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`volume:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`network:${daemon.sentinel}`, sentinelOwnership],
  ]);
  const removed = daemon.calls
    .filter(({ args }) => args[1] === 'rm')
    .map(({ args }) => {
      const kind = args[0];
      const name = args.at(-1);
      if (kind === undefined || name === undefined)
        throw new Error('Malformed cleanup fixture command');
      return `${kind}:${name}`;
    });
  expect(removed.indexOf(`container:${container}`)).toBeLessThan(
    removed.indexOf(`network:${NETWORK_ID}`),
  );
  expect(daemon.resources.has(`network:${network}`)).toBe(false);
  expect(
    daemon.calls
      .filter(({ args }) => args[0] === 'network' && args[1] === 'rm')
      .map(({ args }) => args.at(-1)),
  ).toEqual([NETWORK_ID]);
  expect(daemon.calls.some(({ args }) => args[0] === 'network' && args.includes('--force'))).toBe(
    false,
  );
});

it('network cleanup refuses a changed user label while still cleaning the invocation container and image', async () => {
  const daemon = lifecycleDaemon();
  const network = 'dsh-team-net-abcdefghijkl';
  const container = 'dsh-team-u-abcdefghijkl';

  await expect(
    runUserImage(
      'container-start',
      () => undefined,
      daemon.command,
      (lifecycle) => {
        const ownership = { 'dsh-team.user': 'abcdefghijkl' };
        lifecycle.registerResource('network', network, ownership);
        lifecycle.registerResource('container', container, ownership);
        daemon.resources.set(`network:${network}`, { 'dsh-team.user': 'foreign-owner' });
        daemon.resources.set(`container:${container}`, ownership);
        return Promise.resolve('scenario completed');
      },
    ),
  ).rejects.toThrow('invocation label does not match');

  expect([...daemon.resources]).toEqual([
    [`container:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`volume:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
    [`network:${network}`, { 'dsh-team.user': 'foreign-owner' }],
  ]);
  expect(daemon.calls.some(({ args }) => args[0] === 'network' && args[1] === 'rm')).toBe(false);
});

it.each(['name mismatch', 'ID mismatch', 'active endpoint', 'unconfirmed removal'])(
  'network cleanup preserves unsafe resources and reports the original failure on %s',
  async (fault) => {
    const daemon = lifecycleDaemon();
    const name = 'dsh-team-test-run-cleanup-control';
    const command: DockerCommand = (args, timeout) => {
      if (fault === 'unconfirmed removal' && args[0] === 'network' && args[1] === 'rm') {
        daemon.calls.push({ args, timeout });
        return { status: 0, stdout: '', stderr: '' };
      }
      const result = daemon.command(args, timeout);
      if (args[0] !== 'network' || args[1] !== 'inspect' || result.status !== 0) return result;
      const document = {
        Id: fault === 'ID mismatch' ? 'd'.repeat(64) : NETWORK_ID,
        Name: fault === 'name mismatch' ? 'dsh-team-test-foreign' : name,
        Labels: daemon.resources.get(`network:${name}`),
        Containers: fault === 'active endpoint' ? { foreign: { Name: 'unrelated' } } : {},
      };
      return { ...result, stdout: JSON.stringify([document]) };
    };
    const failure: unknown = await runUserImage(
      'container-start',
      () => undefined,
      command,
      (lifecycle) => {
        const labels = { 'dsh-team.test-run': lifecycle.runId };
        lifecycle.registerResource('network', name, labels);
        daemon.resources.set(`network:${name}`, labels);
        try {
          lifecycle.removeNetwork(name, NETWORK_ID);
        } catch (error) {
          throw new AggregateError(
            [new Error('Original network scenario failure'), error],
            'Network cleanup control failed',
            { cause: error },
          );
        }
        throw new Error('Unsafe cleanup unexpectedly succeeded');
      },
    ).catch((error: unknown) => error);

    const diagnostic =
      fault === 'active endpoint'
        ? 'not verified empty'
        : fault === 'unconfirmed removal'
          ? 'remains after cleanup'
          : 'immutable identity';
    expect(String(failure)).toContain(diagnostic);
    expect(String(failure)).toContain('Original network scenario failure');
    expect(String(failure)).toContain('Invocation network inventory remains');
    expect(daemon.resources.has(`network:${name}`)).toBe(true);
    expect(daemon.resources.has(`container:${daemon.sentinel}`)).toBe(true);
    expect([...daemon.resources.keys()].some((key) => key.startsWith('image:'))).toBe(false);
    const removals = daemon.calls.filter(({ args }) => args[0] === 'network' && args[1] === 'rm');
    expect(removals.map(({ args }) => args.at(-1))).toEqual(
      fault === 'unconfirmed removal' ? [NETWORK_ID, NETWORK_ID] : [],
    );
  },
);

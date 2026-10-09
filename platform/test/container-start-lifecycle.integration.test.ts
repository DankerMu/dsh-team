import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

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
  daemon.resources.set(`network:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' });
  const command: DockerCommand = (args, timeout) => {
    if (args[0] === 'network' && args[1] === 'rm' && daemon.resources.has(`container:${container}`))
      return { status: 1, stdout: '', stderr: 'network has active endpoints' };
    if (args[0] === 'network' && args[1] === 'inspect' && args.includes('--format'))
      expect(args[args.indexOf('--format') + 1]).toBe('{{ index .Labels "dsh-team.user" }}');
    return daemon.command(args, timeout);
  };

  await expect(
    runUserImage(
      'container-start',
      () => undefined,
      command,
      (lifecycle) => {
        const ownership = { 'dsh-team.user': 'abcdefghijkl' };
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
    [`network:${daemon.sentinel}`, { 'dsh-team.user': 'other-owned-user' }],
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
    removed.indexOf(`network:${network}`),
  );
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

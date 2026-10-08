import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand } from './docker-command.ts';

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
    if (args[1] === 'inspect') {
      const labels = resources.get(key);
      if (labels === undefined)
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such ${kind}: ${name}`,
        };
      const format = args[args.indexOf('--format') + 1] ?? '';
      if (format === '{{.Id}}')
        return { status: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: '' };
      const label = /"([^"]+)"/.exec(format)?.[1];
      return {
        status: 0,
        stdout: label === undefined ? '{}' : `${labels[label] ?? ''}\n`,
        stderr: '',
      };
    }
    if (args[1] === 'rm') {
      resources.delete(key);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error('Unexpected lifecycle fixture Docker operation');
  };
  return { command, resources, calls, sentinel };
}

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

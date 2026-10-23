import type * as ChildProcessModule from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type * as Fs from 'node:fs/promises';
import type * as Os from 'node:os';
import { expect, it, vi } from 'vitest';
import { waitForDeployment } from './deployment-account-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import { createDeploymentSetupEvidence } from './deployment-setup-evidence.ts';
import type * as ObserverModule from './deployment-observer-fixture.ts';
import {
  substituteObservation,
  SUBSTITUTE_OBSERVER_OVERRIDE,
} from './deployment-observer-substitute.ts';
import type { DeploymentSetupSnapshot } from './deployment-setup-evidence.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const external = vi.hoisted(
  (): { command: DockerCommand | undefined; observe: ((event: string) => void) | undefined } => ({
    command: undefined,
    observe: undefined,
  }),
);
vi.mock('./deployment-observer-fixture.ts', async (importOriginal) => {
  const { observerSubstitute: substitute } = await import('./deployment-observer-substitute.ts');
  return substitute(await importOriginal<typeof ObserverModule>(), (event) => {
    external.observe?.(event);
  });
});
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => 'linux',
  arch: () => 'x64',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return {
    ...original,
    // Socket metadata is the only substituted filesystem boundary; owned files remain real.
    stat: async (path: Parameters<typeof original.stat>[0]) =>
      path === '/var/run/docker.sock' ? { gid: 1000 } : original.stat(path),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    spawnSync(binary: string, args: readonly string[]) {
      if (binary !== 'docker' || external.command === undefined)
        throw new Error('Unexpected synchronous external process');
      return external.command(args, 30_000);
    },
    spawn(binary: string, args: readonly string[], options: SpawnOptions) {
      if (binary === 'flock')
        return original.spawn(
          process.execPath,
          ['-e', "process.stdout.write('locked\\n');process.stdin.resume();"],
          options,
        );
      if (binary !== 'docker' || external.command === undefined)
        throw new Error('Unexpected asynchronous external process');
      const result = external.command(args, 30_000);
      // Preserve actual child streams/close settlement in the canonical Docker adapter.
      return original.spawn(
        process.execPath,
        [
          '-e',
          `const r=${JSON.stringify(result)};process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status;`,
        ],
        options,
      );
    },
  };
});

function deploymentDaemon(cleanupFails: boolean, drainFails = false) {
  const images = new Map<string, string>([['dsh-team-test-sentinel:kept', 'foreign-owner']]);
  const calls: string[][] = [];
  let platformOwner: string | undefined;
  let platformPresent = false;
  let platformInspections = 0;
  const platformId = 'b'.repeat(64);
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  function build(args: readonly string[]): DockerCommandResult {
    images.set(
      args[args.indexOf('--tag') + 1] ?? '',
      (args[args.indexOf('--label') + 1] ?? '').split('=')[1] ?? '',
    );
    return ok();
  }
  function compose(args: readonly string[]): DockerCommandResult {
    if (args[1] === 'version') return ok('2.39.1\n');
    if (args.includes('up')) {
      platformOwner = [...images].find(([tag]) => tag.endsWith(':platform'))?.[1];
      platformPresent = true;
      return ok();
    }
    throw new Error('Unexpected external Docker operation in deployment setup regression');
  }
  function inspectPlatform(args: readonly string[], name: string): DockerCommandResult | undefined {
    if (name === 'dsh-team-platform') {
      platformInspections++;
      if (drainFails && platformInspections === 3)
        return {
          status: 1,
          stdout: 'private-drain-output-canary',
          stderr: 'private-drain-error-canary',
        };
    }
    if (platformPresent && (name === 'dsh-team-platform' || name === platformId))
      return args.includes('--format')
        ? ok(`${platformOwner ?? ''}\n`)
        : ok(
            JSON.stringify([
              {
                Id: platformId,
                Name: '/dsh-team-platform',
                Config: { Labels: { 'dsh-team.test-run': platformOwner } },
                State: { Status: 'created' },
              },
            ]),
          );
    return undefined;
  }
  function inspect(kind: string, args: readonly string[], name: string): DockerCommandResult {
    if (kind === 'container') {
      const result = inspectPlatform(args, name);
      if (result !== undefined) return result;
    }
    if (kind === 'image' && images.has(name)) {
      if (!args.includes('{{.Id}}')) return ok(`${images.get(name) ?? ''}\n`);
      // Distinct identities prove which built image the observation receives.
      return ok(`sha256:${(name.endsWith(':platform') ? 'b' : 'a').repeat(64)}\n`);
    }
    return { status: 1, stdout: '[]\n', stderr: `Error: No such ${kind}: ${name}\n` };
  }
  function removeImage(name: string): DockerCommandResult {
    if (cleanupFails)
      return {
        status: 1,
        stdout: 'private-cleanup-output-canary',
        stderr: 'private-cleanup-error-canary',
      };
    images.delete(name);
    return ok();
  }
  const command: DockerCommand = (args) => {
    calls.push([...args]);
    const kind = args[0] ?? '';
    const name = args.at(-1) ?? '';
    if (kind === 'version') return ok('29.1.3\n');
    if (kind === 'build') return build(args);
    if (kind === 'compose') return compose(args);
    if (args[1] === 'inspect') return inspect(kind, args, name);
    if (kind === 'image' && args[1] === 'rm') return removeImage(name);
    if (kind === 'container' && args[1] === 'rm') {
      platformPresent = false;
      return ok();
    }
    if (kind === 'network' && args[1] === 'ls') return ok();
    throw new Error('Unexpected external Docker operation in deployment setup regression');
  };
  return { command, calls, images, platformPresent: () => platformPresent };
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'preserves an unfinished preparation parent after a completed health child with cleanup failure=%s and drainage failure=%s',
  async (cleanupFails, drainFails) => {
    const daemon = deploymentDaemon(cleanupFails, drainFails);
    external.command = daemon.command;
    external.observe = (event) => daemon.calls.push(['observer', event]);
    const uid =
      process.getuid === undefined ? undefined : vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const primary = Object.assign(
      new AggregateError(
        [new Error('private-nested-member-canary')],
        'private-preparation-message-canary',
        { cause: new Error('private-preparation-cause-canary') },
      ),
      { output: 'private-preparation-output-canary' },
    );
    const reports: DeploymentSetupSnapshot[] = [];
    const setup = createDeploymentSetupEvidence((snapshot) => {
      reports.push(snapshot);
    });
    let observed: unknown;
    let afterChild: DeploymentSetupSnapshot | undefined;

    try {
      await withDeployment(
        async (_lifecycle, start) => {
          await start();
        },
        async (_lifecycle, deployment) => {
          // Compose has not started; a parent-bound observation lets health complete as a child.
          await waitForDeployment(
            {
              ...deployment,
              request: () => Promise.resolve(Response.json({ status: 'ok' })),
              observation: substituteObservation(true),
            },
            setup,
          );
          afterChild = setup.snapshot();
          throw primary;
        },
        setup,
      ).catch((error: unknown) => {
        observed = error;
      });
      await setup.publish();
    } finally {
      external.command = undefined;
      external.observe = undefined;
      uid?.mockRestore();
    }

    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error('Missing lifecycle failure');
    const flatten = (error: unknown): unknown[] => {
      if (!(error instanceof AggregateError) || error === primary) return [error];
      const members: unknown[] = error.errors;
      return members.flatMap(flatten);
    };
    const failures = flatten(observed);
    expect(failures).toContain(primary);
    // Unbound observation retirement is a distinct failure appended after the primary.
    expect(
      failures.filter(
        (error) =>
          error instanceof Error && error.message === 'Deployment generation was never bound',
      ),
    ).toHaveLength(1);
    expect(afterChild).toMatchObject({
      current: 'scenario-preparation',
      lastCompleted: 'health',
      firstFailure: null,
      operations: {
        'deployment-creation': 'entered',
        'scenario-preparation': 'entered',
        health: 'completed',
      },
    });
    expect(daemon.calls.some((args) => args.includes('up'))).toBe(false);
    const observerCalls = daemon.calls.filter((args) => args[0] === 'observer');
    expect(observerCalls).toEqual([
      ['observer', `create:sha256:${'b'.repeat(64)}`],
      ['observer', 'ready'],
      ['observer', 'finish:false'],
    ]);
    // Observation retirement follows the canonical resource cleanup attempt.
    expect(daemon.calls.at(-1)).toEqual(['observer', 'finish:false']);
    expect(daemon.calls.some((args) => args[0] === 'image' && args[1] === 'rm')).toBe(true);
    expect(daemon.images.get('dsh-team-test-sentinel:kept')).toBe('foreign-owner');
    expect(reports).toEqual([
      {
        current: 'scenario-preparation',
        lastCompleted: 'health',
        firstFailure: { phase: 'scenario-preparation', code: 'operation-failed', cause: 'unknown' },
        operations: {
          'deployment-host-admission': 'completed',
          'deployment-lock-admission': 'completed',
          'user-image-preparation': 'completed',
          'deployment-creation': 'failed',
          'fixed-name-admission': 'completed',
          'compose-capability': 'completed',
          'resource-registration': 'completed',
          'platform-build': 'completed',
          'platform-image-identity': 'completed',
          'local-configuration': 'completed',
          'scenario-preparation': 'failed',
          health: 'completed',
        },
        cleanup: {
          deploymentDrain: drainFails ? 'unconfirmed' : 'not-required',
          resources: cleanupFails ? 'unconfirmed' : 'confirmed',
          // The created observation was never bound, so its own retirement cannot be confirmed.
          observation: 'unconfirmed',
        },
        evidence: 'retained',
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain('private-');
  },
);

it('records completed deployment setup separately from actual owned drainage and resource retirement', async () => {
  const daemon = deploymentDaemon(false);
  external.command = daemon.command;
  external.observe = (event) => daemon.calls.push(['observer', event]);
  const uid =
    process.getuid === undefined ? undefined : vi.spyOn(process, 'getuid').mockReturnValue(1000);
  const reports: DeploymentSetupSnapshot[] = [];
  const setup = createDeploymentSetupEvidence((snapshot) => {
    reports.push(snapshot);
  });
  let configured: DeploymentSetupSnapshot | undefined;

  try {
    await withDeployment(
      async (_lifecycle, start) => {
        await start();
        configured = setup.snapshot();
      },
      undefined,
      setup,
    );
    await setup.publish();
  } finally {
    external.command = undefined;
    external.observe = undefined;
    uid?.mockRestore();
  }

  expect(configured).toMatchObject({
    current: null,
    lastCompleted: 'deployment-creation',
    firstFailure: null,
    cleanup: {
      deploymentDrain: 'not-required',
      resources: 'unconfirmed',
      observation: 'unconfirmed',
    },
  });
  expect(reports).toEqual([
    {
      current: null,
      lastCompleted: 'deployment-creation',
      firstFailure: null,
      operations: {
        'deployment-host-admission': 'completed',
        'deployment-lock-admission': 'completed',
        'user-image-preparation': 'completed',
        'deployment-creation': 'completed',
        'fixed-name-admission': 'completed',
        'compose-capability': 'completed',
        'resource-registration': 'completed',
        'platform-build': 'completed',
        'platform-image-identity': 'completed',
        'local-configuration': 'completed',
        'compose-creation': 'completed',
      },
      cleanup: { deploymentDrain: 'confirmed', resources: 'confirmed', observation: 'confirmed' },
      evidence: 'retained',
    },
  ]);
  const up = daemon.calls.findIndex((args) => args.includes('up'));
  const upArgs = daemon.calls[up] ?? [];
  expect(
    upArgs.flatMap((value, index) => (upArgs[index - 1] === '--file' ? [value] : [])).at(-1),
  ).toBe(SUBSTITUTE_OBSERVER_OVERRIDE);
  const create = daemon.calls.findIndex((args) => args[1] === `create:sha256:${'b'.repeat(64)}`);
  const bind = daemon.calls.findIndex((args) => args[0] === 'observer' && args[1] === 'bind');
  expect(create).toBeGreaterThan(-1);
  expect(create).toBeLessThan(up);
  expect(bind).toBe(up + 1);
  expect(daemon.calls.filter((args) => args[0] === 'observer')).toEqual([
    ['observer', `create:sha256:${'b'.repeat(64)}`],
    ['observer', 'bind'],
    ['observer', 'finish:true'],
  ]);
  expect(daemon.calls.at(-1)).toEqual(['observer', 'finish:true']);
  expect(daemon.platformPresent()).toBe(false);
  expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'foreign-owner']]);
});

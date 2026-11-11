import type * as ChildProcessModule from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type * as Fs from 'node:fs/promises';
import type * as Os from 'node:os';
import { expect, it, vi } from 'vitest';
import { waitForDeployment } from './deployment-account-fixture.ts';
import { withDeployment } from './deployment-fixture.ts';
import { createDeploymentSetupEvidence } from './deployment-setup-evidence.ts';
import { withTlsDeployment } from './deployment-tls-fixture.ts';
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

/** The TLS proxy's invocation-owned container name, whose middle is the run's ownership label. */
const TLS_PROXY = /^dsh-team-test-(.+)-tls$/;

function deploymentDaemon(
  cleanupFails: boolean,
  drainFails = false,
  documentServer = false,
  // One compose `up` fails, selected by whether it starts only the TLS proxy service.
  composeFailure?: { readonly proxy: boolean; readonly stderr: string },
) {
  const images = new Map<string, string>([['dsh-team-test-sentinel:kept', 'foreign-owner']]);
  const calls: string[][] = [];
  let platformOwner: string | undefined;
  let platformPresent = false;
  let proxyPresent = false;
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
      const proxy = args.includes('proxy');
      if (composeFailure?.proxy === proxy)
        return {
          status: 1,
          stdout: 'private-compose-output-canary',
          stderr: composeFailure.stderr,
        };
      if (proxy) {
        proxyPresent = true;
        return ok();
      }
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
  function inspectProxy(args: readonly string[], name: string): DockerCommandResult | undefined {
    const owner = TLS_PROXY.exec(name)?.[1];
    if (!proxyPresent || owner === undefined) return undefined;
    if (args.includes('--format')) return ok(`${owner}\n`);
    return ok(
      JSON.stringify([
        {
          Id: 'd'.repeat(64),
          Name: `/${name}`,
          Config: { Labels: { 'dsh-team.test-run': owner } },
          NetworkSettings: {
            Networks: { [`dsh-team-test-${owner}_default`]: { IPAddress: '172.18.0.2' } },
          },
        },
      ]),
    );
  }
  function inspect(kind: string, args: readonly string[], name: string): DockerCommandResult {
    // A foreign fixed-name Document Server: present, never adopted.
    if (documentServer && kind === 'container' && name === 'dsh-team-documentserver')
      return ok(JSON.stringify([{ Id: 'c'.repeat(64), Name: '/dsh-team-documentserver' }]));
    if (kind === 'container') {
      const result = inspectProxy(args, name) ?? inspectPlatform(args, name);
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
      if (TLS_PROXY.test(name)) proxyPresent = false;
      else platformPresent = false;
      return ok();
    }
    if (kind === 'network' && args[1] === 'ls') return ok();
    throw new Error('Unexpected external Docker operation in deployment setup regression');
  };
  return {
    command,
    calls,
    images,
    platformPresent: () => platformPresent,
    proxyPresent: () => proxyPresent,
  };
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

it('refuses a pre-existing fixed Document Server before any build without adopting or removing it', async () => {
  const daemon = deploymentDaemon(false, false, true);
  external.command = daemon.command;
  external.observe = (event) => daemon.calls.push(['observer', event]);
  const uid =
    process.getuid === undefined ? undefined : vi.spyOn(process, 'getuid').mockReturnValue(1000);
  const reports: DeploymentSetupSnapshot[] = [];
  const setup = createDeploymentSetupEvidence((snapshot) => {
    reports.push(snapshot);
  });
  let observed: unknown;

  try {
    await withDeployment(
      async (_lifecycle, start) => {
        await start();
      },
      undefined,
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

  expect(observed).toBeInstanceOf(Error);
  expect((observed as Error).message).toBe(
    'Document Server container already exists or absence is unproven; refusing deployment',
  );
  // Both fixed names are admitted in order; nothing past admission ran.
  expect(
    daemon.calls
      .filter((args) => args[0] === 'container' && args[1] === 'inspect')
      .map((args) => args.at(-1)),
  ).toEqual(['dsh-team-platform', 'dsh-team-documentserver']);
  expect(
    daemon.calls.some((args) => args[0] === 'compose' || args.includes('platform/Dockerfile')),
  ).toBe(false);
  expect(daemon.calls.some((args) => args[0] === 'observer')).toBe(false);
  expect(
    daemon.calls.some((args) => args[1] === 'rm' && args.at(-1) === 'dsh-team-documentserver'),
  ).toBe(false);
  expect(reports).toEqual([
    {
      current: 'fixed-name-admission',
      lastCompleted: 'user-image-preparation',
      firstFailure: { phase: 'fixed-name-admission', code: 'operation-failed', cause: 'unknown' },
      operations: {
        'deployment-host-admission': 'completed',
        'deployment-lock-admission': 'completed',
        'user-image-preparation': 'completed',
        'deployment-creation': 'failed',
        'fixed-name-admission': 'failed',
      },
      cleanup: {
        deploymentDrain: 'not-required',
        resources: 'confirmed',
        observation: 'not-required',
      },
      evidence: 'retained',
    },
  ]);
});

function nestedMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(nestedMessages);
  return [error instanceof Error ? error.message : String(error)];
}

async function tlsDeployment(daemon: ReturnType<typeof deploymentDaemon>) {
  external.command = daemon.command;
  external.observe = (event) => daemon.calls.push(['observer', event]);
  const uid =
    process.getuid === undefined ? undefined : vi.spyOn(process, 'getuid').mockReturnValue(1000);
  const reports: DeploymentSetupSnapshot[] = [];
  let observed: unknown;
  try {
    // The substitute keeps the real execFileSync, so the TLS certificate comes from the host's
    // openssl: an integration host prerequisite.
    await withTlsDeployment(
      async (_lifecycle, start) => {
        await start();
      },
      (snapshot) => {
        reports.push(snapshot);
      },
    ).catch((error: unknown) => {
      observed = error;
    });
  } finally {
    external.command = undefined;
    external.observe = undefined;
    uid?.mockRestore();
  }
  return { reports, observed };
}

const ups = (calls: readonly string[][]) =>
  calls.filter((args) => args[0] === 'compose' && args.includes('up'));

it.each([
  [
    'scenario-preparation',
    true,
    'port-allocated',
    ' Container dsh-team-test-private-tls  Starting\nError response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint dsh-team-test-private-tls (5c9a): failed to bind host port 127.0.0.1:41234/tcp: address already in use\n',
  ],
  [
    'compose-creation',
    false,
    'container-name-conflict',
    ' Container dsh-team-platform  Creating\nError response from daemon: Conflict. The container name "/dsh-team-platform" is already in use by container "private-41234". You have to remove (or rename) that container to be able to reuse that name.\n',
  ],
] as const)(
  'attributes a failed TLS deployment compose up to %s with its closed category',
  async (phase, proxy, code, stderr) => {
    const daemon = deploymentDaemon(false, false, false, { proxy, stderr });

    const { reports, observed } = await tlsDeployment(daemon);

    // The proxy up precedes the stack up; only a successful proxy reaches the second.
    expect(ups(daemon.calls).map((args) => args.includes('proxy'))).toEqual(
      proxy ? [true] : [true, false],
    );
    expect(observed).toBeInstanceOf(AggregateError);
    const messages = nestedMessages(observed);
    expect(messages.filter((message) => message.includes(`compose-failure: ${code}`))).toHaveLength(
      1,
    );
    expect(messages).toContain('Deployment generation was never bound');
    for (const canary of ['private-', '41234'])
      expect(JSON.stringify({ messages, reports })).not.toContain(canary);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      firstFailure: { phase, code: 'operation-failed', cause: 'unknown' },
      operations: { 'deployment-creation': 'failed', [phase]: 'failed' },
      cleanup: { resources: 'confirmed', observation: 'unconfirmed' },
      evidence: 'retained',
    });
    // The original lifecycle error carries the snapshot its succeeding sink published.
    expect((observed as { setup?: unknown }).setup).toEqual(reports[0]);
    expect(daemon.proxyPresent()).toBe(false);
    expect(daemon.platformPresent()).toBe(false);
  },
);

it('publishes no setup evidence for a completed TLS deployment', async () => {
  const daemon = deploymentDaemon(false);

  const { reports, observed } = await tlsDeployment(daemon);

  expect(observed).toBeUndefined();
  expect(reports).toEqual([]);
  expect(ups(daemon.calls).map((args) => args.includes('proxy'))).toEqual([true, false]);
  expect(daemon.calls.at(-1)).toEqual(['observer', 'finish:true']);
  expect(daemon.proxyPresent()).toBe(false);
  expect(daemon.platformPresent()).toBe(false);
});

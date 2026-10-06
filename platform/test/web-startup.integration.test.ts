import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import type { WebStartupBoundary } from './web-startup-fixture.ts';

const privateToken = 'DO_NOT_REPORT_LAUNCH_TOKEN';
const imageId = `sha256:${'b'.repeat(64)}`;
interface WebDaemon {
  command: DockerCommand;
  resources: Record<'image' | 'container' | 'volume', Map<string, string>>;
  boundary: WebStartupBoundary;
  createdContainers: string[];
}

/** Stateful Docker boundary: ownership is separate from observed runtime facts. */
function webDaemon(fault = '', port = 43127): WebDaemon {
  const resources = {
    image: new Map([['foreign-image', 'foreign-owner']]),
    container: new Map([['foreign-container', 'foreign-owner']]),
    volume: new Map([['foreign-volume', 'foreign-owner']]),
  };
  const createdContainers: string[] = [];
  let snapshot: Record<string, unknown> = {};
  let time = 0;
  let runningInspections = 0;
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  function hostConfiguration(seccomp: string | undefined) {
    if (seccomp === undefined) throw new Error('Missing seccomp path');
    const policy =
      fault === 'relaxed-seccomp'
        ? '{"defaultAction":"SCMP_ACT_ALLOW"}'
        : readFileSync(seccomp.slice('seccomp='.length), 'utf8');
    return {
      Privileged: fault === 'privileged',
      CapAdd: fault === 'capability' ? ['SYS_ADMIN'] : [],
      SecurityOpt: [fault === 'unconfined' ? 'seccomp=unconfined' : `seccomp=${policy}`],
      MaskedPaths: ['/proc/kcore'],
      ReadonlyPaths: fault === 'systempaths' ? [] : ['/proc/sys'],
      PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    };
  }
  function createContainer(args: readonly string[], label: string): DockerCommandResult {
    if (fault === 'container-before-create') {
      return { status: 1, stdout: privateToken, stderr: privateToken };
    }
    const container = args[args.indexOf('--name') + 1] ?? '';
    resources.container.set(container, label);
    createdContainers.push(container);
    const mounts = args.flatMap((arg, index) => (arg === '--mount' ? [args[index + 1] ?? ''] : []));
    const sources = mounts.map(
      (mount) =>
        mount
          .split(',')
          .find((part) => part.startsWith('source='))
          ?.slice(7) ?? '',
    );
    const [state, work, overlay] = sources;
    if (overlay === undefined) throw new Error('Missing overlay');
    if (
      readFileSync(overlay, 'utf8') !==
      '- id: webserver\n  config:\n    host: 0.0.0.0\n    port: 3080\n'
    ) {
      throw new Error('Nonminimal Web overlay');
    }
    snapshot = {
      Image: fault === 'wrong-image' ? 'sha256:wrong' : imageId,
      Config: { Labels: { 'dsh-team.test-run': label } },
      HostConfig: hostConfiguration(args[args.indexOf('--security-opt') + 1]),
      NetworkSettings: {
        Ports: {
          '3080/tcp': [
            {
              HostIp: fault === 'public-port' ? '0.0.0.0' : '127.0.0.1',
              HostPort: String(port),
            },
          ],
        },
      },
      Mounts: [
        { Type: 'volume', Name: state, Destination: '/data/home', RW: true },
        {
          Type: 'volume',
          Name: fault === 'shared-mount' ? state : work,
          Destination: fault === 'wrong-mount' ? '/wrong' : '/data/work',
          RW: fault !== 'readonly-work',
        },
        {
          Type: 'bind',
          Source: overlay,
          Destination: '/managed/patch.yml',
          RW: fault === 'writable-overlay',
        },
      ],
    };
    return ok(container);
  }
  function resourceOperation(kind: 'image' | 'container' | 'volume', args: readonly string[]) {
    const name = args.at(-1) ?? '';
    if (args[1] === 'rm') {
      resources[kind].delete(name);
      return ok();
    }
    if (!resources[kind].has(name)) {
      return { status: 1, stdout: '', stderr: `Error: No such ${kind}: ${name}` };
    }
    if (args.includes('{{.Id}}')) return ok(imageId);
    if (args.includes('{{json .}}')) {
      runningInspections++;
      const running =
        fault !== 'early-exit' && !(fault === 'exit-after-http' && runningInspections > 1);
      return ok(JSON.stringify({ ...snapshot, State: { Running: running } }));
    }
    return ok(resources[kind].get(name));
  }
  function execution(operation: string | undefined): DockerCommandResult {
    if (operation === 'start') {
      if (fault === 'late-start') time = 60_000;
      return ok();
    }
    if (operation === 'logs') {
      if (fault === 'log-failure') {
        return {
          status: null,
          stdout: privateToken,
          stderr: privateToken,
          error: new Error(privateToken),
        };
      }
      if (fault === 'missing-token') return ok('DSH listening\n');
      if (fault === 'false-token-line')
        return ok(`not dsh web: http://127.0.0.1:3080/?token=${privateToken}\n`);
      return ok(
        `dsh web: http://127.0.0.1:3080/?token=${privateToken} (LAN: http://172.17.0.2:3080/?token=${privateToken})\n`,
      );
    }
    if (operation === 'exec') {
      if (fault === 'late-process') time = 60_000;
      return ok(
        fault === 'malformed-process'
          ? privateToken
          : JSON.stringify([
              {
                pid: fault === 'missing-pid' ? 0 : 1,
                parentPid: 0,
                effectiveUid: fault === 'root' ? 0 : 1001,
                telemetryDisabled: fault !== 'missing-telemetry',
                unselectedSecret: privateToken,
              },
            ]),
      );
    }
    throw new Error('Unexpected Docker boundary operation');
  }
  function createVolume(name: string, label: string): DockerCommandResult {
    if (fault === 'volume-before-create') {
      return { status: 1, stdout: privateToken, stderr: privateToken };
    }
    resources.volume.set(name, label);
    if (
      name.endsWith('-state') &&
      ['foreign-volume-label', 'missing-volume-label'].includes(fault)
    ) {
      resources.volume.set(name, fault === 'foreign-volume-label' ? 'foreign-owner' : '');
    }
    if (fault === 'partial-work-volume' && name.endsWith('-work')) {
      return { status: 1, stdout: privateToken, stderr: privateToken };
    }
    return ok(name);
  }
  const command: DockerCommand = (args) => {
    const [operation, subcommand] = args;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    if (operation === 'version') return ok('29.1.3');
    if (operation === 'build') {
      if (fault === 'build-before-create') {
        return { status: 1, stdout: privateToken, stderr: privateToken };
      }
      resources.image.set(args[args.indexOf('--tag') + 1] ?? '', label);
      return ok();
    }
    if (operation === 'create') return createContainer(args, label);
    if (operation === 'volume' && subcommand === 'create') {
      return createVolume(args.at(-1) ?? '', label);
    }
    if (operation === 'image' || operation === 'container' || operation === 'volume') {
      return resourceOperation(operation, args);
    }
    return execution(operation);
  };
  const statuses: Record<string, number | null> = {
    http200: 200,
    redirect: 302,
    disconnected: null,
  };
  const boundary: WebStartupBoundary = {
    now: () => time,
    pause: (milliseconds) => {
      time += milliseconds;
      return Promise.resolve();
    },
    httpStatus: () => {
      if (fault === 'late-http') time = 60_001;
      if (fault === 'just-before-deadline') time = 59_999;
      if (fault === 'http-failure') return Promise.reject(new Error(privateToken));
      return Promise.resolve(Object.hasOwn(statuses, fault) ? (statuses[fault] ?? null) : 401);
    },
  };
  return { command, resources, boundary, createdContainers };
}

function remainingResources(daemon: WebDaemon) {
  return Object.fromEntries(
    Object.entries(daemon.resources).map(([kind, resources]) => [kind, [...resources]]),
  );
}
const sentinels = {
  image: [['foreign-image', 'foreign-owner']],
  container: [['foreign-container', 'foreign-owner']],
  volume: [['foreign-volume', 'foreign-owner']],
};

it('accepts live observations immediately before the deadline, reports selected facts and cleans both volumes', async () => {
  const daemon = webDaemon('just-before-deadline');

  const result = await runUserImage(
    'web-startup',
    () => undefined,
    daemon.command,
    daemon.boundary,
  );

  expect(JSON.parse(result.stdout)).toEqual({
    tokenSeen: true,
    elapsedMs: 59_999,
    httpStatus: 401,
    configuredHost: 'dsh-team.test:3080',
    hostPort: 43127,
    pid: 1,
    parentPid: 0,
    effectiveUid: 1001,
    telemetryDisabled: true,
  });
  expect(result.stdout).not.toContain(privateToken);
  expect(remainingResources(daemon)).toEqual(sentinels);
});

it('waits for the genuine launch announcement before judging a homepage that initially returns 404', async () => {
  const daemon = webDaemon();
  let time = 0;
  const earlyHttpStatuses: number[] = [];
  const command: DockerCommand = (args, timeout) => {
    if (args[0] === 'logs' && time < 500) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return daemon.command(args, timeout);
  };
  const boundary: WebStartupBoundary = {
    now: () => time,
    pause: (milliseconds) => {
      time += milliseconds;
      return Promise.resolve();
    },
    httpStatus: () => {
      const status = time < 500 ? 404 : 401;
      if (time < 500) earlyHttpStatuses.push(status);
      return Promise.resolve(status);
    },
  };

  const result = await runUserImage('web-startup', () => undefined, command, boundary);

  const summary: unknown = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ tokenSeen: true, httpStatus: 401 });
  expect(time).toBeGreaterThanOrEqual(500);
  expect(time).toBeLessThan(60_000);
  expect(earlyHttpStatuses).toEqual([]);
  expect(remainingResources(daemon)).toEqual(sentinels);
});

it.each([
  ['missing-token', 'deadline'],
  ['false-token-line', 'deadline'],
  ['early-exit', 'exited'],
  ['late-start', 'deadline'],
  ['late-http', 'deadline'],
  ['late-process', 'deadline'],
  ['disconnected', 'deadline'],
  ['exit-after-http', 'exited'],
  ['http200', '401'],
  ['redirect', '401'],
  ['root', 'nonroot'],
  ['missing-telemetry', 'telemetry'],
  ['missing-pid', 'provenance'],
  ['shared-mount', 'mounts'],
  ['wrong-mount', 'mounts'],
  ['readonly-work', 'mounts'],
  ['writable-overlay', 'mounts'],
  ['public-port', 'loopback'],
  ['wrong-image', 'ownership'],
  ['unconfined', 'security'],
  ['privileged', 'security'],
  ['capability', 'security'],
  ['systempaths', 'security'],
  ['malformed-process', 'JSON'],
  ['relaxed-seccomp', 'security'],
  ['log-failure', 'failed'],
  ['http-failure', 'failed'],
  ['partial-work-volume', 'failed'],
  ['build-before-create', 'failed'],
  ['container-before-create', 'failed'],
  ['volume-before-create', 'failed'],
])(
  'rejects %s for its semantic reason without leaking secrets or deleting foreign resources',
  async (fault, reason) => {
    const daemon = webDaemon(fault);

    let failure: unknown;
    try {
      await runUserImage('web-startup', () => undefined, daemon.command, daemon.boundary);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (fault.endsWith('before-create') && failure instanceof AggregateError) {
      expect(failure.errors).toHaveLength(1);
    }
    expect(inspect(failure)).toContain(reason);
    expect(inspect(failure)).not.toContain(privateToken);
    expect(remainingResources(daemon)).toEqual(sentinels);
  },
);

it('cleans both volumes when a Web assertion fails after genuine acceptance', async () => {
  const daemon = webDaemon();

  await expect(
    runUserImage(
      'web-startup',
      () => {
        throw new Error('induced Web assertion');
      },
      daemon.command,
      daemon.boundary,
    ),
  ).rejects.toThrow('induced Web assertion');

  expect(remainingResources(daemon)).toEqual(sentinels);
});

it('uses real host HTTP with configured Host, no credentials and no redirect following', async () => {
  const requests: {
    path: string;
    host: string | undefined;
    cookie: string | undefined;
    authorization: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? '',
      host: request.headers.host,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    response
      .writeHead(request.url === '/redirected' ? 401 : 302, { Location: '/redirected' })
      .end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP test requires TCP');
  const daemon = webDaemon('', address.port);

  try {
    await expect(runUserImage('web-startup', () => undefined, daemon.command)).rejects.toThrow(
      '401',
    );
    expect(requests).toEqual([
      { path: '/', host: 'dsh-team.test:3080', cookie: undefined, authorization: undefined },
    ]);
    expect(remainingResources(daemon)).toEqual(sentinels);
  } finally {
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined) resolve(undefined);
      else reject(error);
    });
    await promise;
  }
});

it.each(['foreign-volume-label', 'missing-volume-label'])(
  'refuses %s before use, preserves the unowned state volume and cleans other owned resources',
  async (fault) => {
    const daemon = webDaemon(fault);

    await expect(
      runUserImage('web-startup', () => undefined, daemon.command, daemon.boundary),
    ).rejects.toThrow('Web volume ownership mismatch');

    expect(daemon.createdContainers).toEqual([]);
    expect([...daemon.resources.image]).toEqual(sentinels.image);
    expect([...daemon.resources.container]).toEqual(sentinels.container);
    expect([...daemon.resources.volume]).toEqual([
      ...sentinels.volume,
      [
        expect.stringMatching(/^dsh-team-test-.*-state$/),
        fault === 'foreign-volume-label' ? 'foreign-owner' : '',
      ],
    ]);
  },
);

it.each(['stalled', 'disconnected'])(
  'bounds real HTTP %s before headers and destroys the connection before owned cleanup completes',
  async (fault) => {
    let time = 0;
    const { promise: closed, resolve: onClose } = Promise.withResolvers<undefined>();
    const server = createServer((request) => {
      time = 60_001;
      if (fault === 'disconnected') request.socket.destroy();
      // Otherwise accept the request without sending headers: exercise the real timeout.
    });
    server.once('connection', (socket) => {
      socket.once('close', () => {
        onClose(undefined);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP test requires TCP');
    const daemon = webDaemon('', address.port);
    const command: DockerCommand = (args, timeout) => {
      const result = daemon.command(args, timeout);
      if (args[0] === 'logs') time = 59_800;
      return result;
    };
    // Real TCP timeout qualification: fake timers would replace the wall-clock abort boundary.
    // A broken adapter must fail this test without leaving its test server listening.
    const { promise: watchdog, reject: expire } = Promise.withResolvers<never>();
    const watchdogTimer = globalThis.setTimeout(() => {
      expire(new Error('Host HTTP observation did not settle'));
    }, 3_000);

    try {
      const run = runUserImage('web-startup', () => undefined, command, {
        now: () => time,
        pause: (milliseconds) => {
          time += milliseconds;
          return Promise.resolve();
        },
      });
      await expect(Promise.race([run, watchdog])).rejects.toThrow('deadline');
      await Promise.race([closed, watchdog]);
      expect(remainingResources(daemon)).toEqual(sentinels);
    } finally {
      globalThis.clearTimeout(watchdogTimer);
      const { promise, resolve, reject } = Promise.withResolvers<undefined>();
      server.closeAllConnections();
      server.close((error) => {
        if (error === undefined) resolve(undefined);
        else reject(error);
      });
      await promise;
    }
  },
);

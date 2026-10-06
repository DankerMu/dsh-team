import { describe, expect, it } from 'vitest';
import { assertDocxReadback, runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './user-image-fixture.ts';

/** Stateful substitute for the Docker daemon boundary, including partially created resources. */
function dockerFixture(
  failAt?:
    | 'build'
    | 'create'
    | 'cleanup'
    | 'inspect'
    | 'build-before-create'
    | 'network'
    | 'user'
    | 'volume-create'
    | 'volume-before-create'
    | 'volume-cleanup'
    | 'volume-inspect'
    | 'reuse-create'
    | 'reuse-start'
    | 'reuse-wait',
  version = '0.2.0-rc.2\n',
  absencePrefix: 'Error response from daemon:' | 'Error:' = 'Error response from daemon:',
) {
  const images = new Map<string, string>([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
  const containers = new Map<string, string>([['dsh-team-test-sentinel', 'sentinel-owner']]);
  const volumes = new Map<string, string>([['dsh-team-test-sentinel-state', 'sentinel-owner']]);
  const mounts = new Map<string, string>();
  const calls: { args: readonly string[]; timeout: number }[] = [];
  const resources = { image: images, container: containers, volume: volumes };
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const fail: DockerCommandResult = { status: 1, stdout: '', stderr: 'induced daemon failure' };
  function buildImage(args: readonly string[]): DockerCommandResult {
    if (failAt === 'build-before-create') return fail;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    images.set(args[args.indexOf('--tag') + 1] ?? '', label);
    return failAt === 'build' ? fail : ok();
  }
  function createContainer(args: readonly string[]): DockerCommandResult {
    if (args[args.indexOf('--label') + 2] !== `sha256:${'a'.repeat(64)}`) return fail;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    containers.set(args[args.indexOf('--name') + 1] ?? '', label);
    const container = args[args.indexOf('--name') + 1] ?? '';
    if (args.includes('--mount')) {
      const mount = args[args.indexOf('--mount') + 1] ?? '';
      const volume =
        mount
          .split(',')
          .find((part) => part.startsWith('source='))
          ?.slice(7) ?? '';
      if (!volumes.has(volume)) return fail;
      mounts.set(container, volume);
    }
    if (container.endsWith('-reuse') && failAt === 'reuse-create') return fail;
    return failAt === 'create' ? fail : ok();
  }
  function createVolume(args: readonly string[]): DockerCommandResult {
    if (failAt === 'volume-before-create') return fail;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    volumes.set(args.at(-1) ?? '', label);
    return failAt === 'volume-create' ? fail : ok(args.at(-1));
  }
  function inspectContainerConfiguration(
    args: readonly string[],
    name: string,
  ): DockerCommandResult | undefined {
    if (args.includes('{{.HostConfig.NetworkMode}}')) {
      return ok(failAt === 'network' ? 'bridge\n' : 'none\n');
    }
    if (args.includes('{{.Config.User}}')) return ok(failAt === 'user' ? 'root\n' : 'dsh\n');
    if (args.includes('{{json .Mounts}}')) {
      return ok(
        JSON.stringify([
          { Type: 'volume', Name: mounts.get(name), Destination: '/data/home', RW: true },
        ]),
      );
    }
    return undefined;
  }
  function inspectResource(
    kind: 'image' | 'container' | 'volume',
    args: readonly string[],
  ): DockerCommandResult {
    const owned = resources[kind];
    const name = args.at(-1) ?? '';
    if (failAt === 'inspect') return fail;
    if (kind === 'volume' && failAt === 'volume-inspect') return fail;
    if (!owned.has(name)) {
      return {
        status: 1,
        stdout: '',
        stderr:
          kind === 'volume'
            ? `Error response from daemon: get ${name}: no such volume\n`
            : `${absencePrefix} No such ${kind}: ${name}\n`,
      };
    }
    if (args.includes('{{.Id}}')) return ok(`sha256:${'a'.repeat(64)}\n`);
    const configuration = inspectContainerConfiguration(args, name);
    if (configuration !== undefined) return configuration;
    if (kind === 'volume' && args[3] !== '{{ index .Labels "dsh-team.test-run" }}') {
      throw new Error('Volume ownership must use its own Labels schema');
    }
    return ok(`${owned.get(name) ?? ''}\n`);
  }
  function removeResource(
    kind: 'image' | 'container' | 'volume',
    args: readonly string[],
  ): DockerCommandResult {
    if (failAt === 'cleanup' && kind === 'container') return fail;
    if (failAt === 'volume-cleanup' && kind === 'volume') return fail;
    if (
      kind === 'volume' &&
      [...mounts].some(([container, volume]) => containers.has(container) && volume === args.at(-1))
    ) {
      return { status: 1, stdout: '', stderr: 'owned volume is still in use' };
    }
    resources[kind].delete(args.at(-1) ?? '');
    return ok();
  }
  function containerExecutionResult(
    operation: 'start' | 'wait',
    args: readonly string[],
  ): DockerCommandResult {
    const reused = args.at(-1)?.endsWith('-reuse') === true;
    if (operation === 'start') {
      if (reused && failAt === 'reuse-start') return fail;
      return ok(version);
    }
    return ok(reused && failAt === 'reuse-wait' ? '7\n' : '0\n');
  }
  const command: DockerCommand = (args, timeout) => {
    calls.push({ args: [...args], timeout });
    const [operation, subcommand] = args;
    switch (operation) {
      case 'version':
        return ok('28.0.0\n');
      case 'build':
        return buildImage(args);
      case 'create':
        return createContainer(args);
      case 'start':
      case 'wait':
        return containerExecutionResult(operation, args);
      case 'image':
      case 'container':
      case 'volume':
        if (subcommand === 'create') return createVolume(args);
        if (subcommand === 'inspect') return inspectResource(operation, args);
        if (subcommand === 'rm') return removeResource(operation, args);
    }
    throw new Error(`Unexpected Docker boundary call: ${args.join(' ')}`);
  };
  return { command, images, containers, volumes, calls };
}

describe('invocation-owned Docker version lifecycle', () => {
  it('verifies a version and cleans owned resources without deleting another invocation sentinel', () => {
    const daemon = dockerFixture();

    runUserImage(
      'version',
      (stdout) => {
        expect(stdout).toBe('0.2.0-rc.2\n');
      },
      daemon.command,
    );

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each(['build', 'create'] as const)(
    'cleans partially created resources after %s fails',
    (stage) => {
      const daemon = dockerFixture(stage);

      const run = () =>
        runUserImage(
          'version',
          () => {
            throw new Error('Version must not be reached');
          },
          daemon.command,
        );

      expect(run).toThrow('induced daemon failure');
      expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
      expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    },
  );

  it('preserves the exact-version assertion failure while removing both owned resources', () => {
    const daemon = dockerFixture(undefined, '0.2.0-rc.3\n');

    const run = () =>
      runUserImage(
        'version',
        (stdout) => {
          if (stdout !== '0.2.0-rc.2\n') throw new Error(`Version mismatch: ${stdout}`);
        },
        daemon.command,
      );

    expect(run).toThrow('Version mismatch: 0.2.0-rc.3');
    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it('fails successful verification if container cleanup fails and still attempts image cleanup', () => {
    const daemon = dockerFixture('cleanup');
    let ownedContainer = '';
    const command: DockerCommand = (args, timeout) => {
      if (args[0] === 'create') ownedContainer = args[args.indexOf('--name') + 1] ?? '';
      return daemon.command(args, timeout);
    };

    const run = () =>
      runUserImage(
        'version',
        (stdout) => {
          expect(stdout).toBe('0.2.0-rc.2\n');
        },
        command,
      );

    expect(run).toThrow('induced daemon failure');
    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers.keys()]).toEqual(['dsh-team-test-sentinel', ownedContainer]);
  });

  it('does not mistake daemon inspection failure for an absent resource', () => {
    const daemon = dockerFixture('inspect');
    let ownedImage = '';
    let runId = '';
    const command: DockerCommand = (args, timeout) => {
      if (args[0] === 'build') {
        ownedImage = args[args.indexOf('--tag') + 1] ?? '';
        runId = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
      }
      return daemon.command(args, timeout);
    };

    const run = () =>
      runUserImage(
        'version',
        () => {
          throw new Error('Version must not be reached');
        },
        command,
      );

    expect(run).toThrow('induced daemon failure');
    expect([...daemon.images]).toEqual([
      ['dsh-team-test-sentinel:kept', 'sentinel-owner'],
      [ownedImage, runId],
    ]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each(['Error response from daemon:', 'Error:'] as const)(
    'accepts explicit absence (%s) after build failed before creating the owned tag',
    (prefix) => {
      const daemon = dockerFixture('build-before-create', '0.2.0-rc.2\n', prefix);

      const run = () =>
        runUserImage(
          'version',
          () => {
            throw new Error('Version must not be reached');
          },
          daemon.command,
        );

      expect(run).toThrow('induced daemon failure');
      expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
      expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    },
  );

  it('refuses to delete a target whose invocation label changed and still cleans the owned image', () => {
    const daemon = dockerFixture();
    let changedContainer = '';

    const run = () =>
      runUserImage(
        'version',
        () => {
          for (const name of daemon.containers.keys()) {
            if (name !== 'dsh-team-test-sentinel') {
              changedContainer = name;
              daemon.containers.set(name, 'another-owner');
            }
          }
        },
        daemon.command,
      );

    expect(run).toThrow('invocation label does not match');
    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([
      ['dsh-team-test-sentinel', 'sentinel-owner'],
      [changedContainer, 'another-owner'],
    ]);
  });
});

describe('offline DOCX verification', () => {
  it('removes offline resources after exact readback while preserving unrelated owners', () => {
    const daemon = dockerFixture(
      undefined,
      '{"effectiveUid":1001,"path":"/data/work/offline.docx",' +
        '"paragraphs":["离线办公验证","中文段落：无需联网即可生成文档。"],' +
        '"tables":[[["项目","状态"],["文档生成","成功"]]]}\n',
    );

    runUserImage('offline-docx', assertDocxReadback, daemon.command);

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it('rejects an import-only marker instead of reopened content and cleans owned resources', () => {
    const daemon = dockerFixture(undefined, 'import succeeded\n');

    expect(() => runUserImage('offline-docx', assertDocxReadback, daemon.command)).toThrow(
      'Unexpected token',
    );

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each([
    ['network', 'Expected offline Docker network none, got bridge'],
    ['user', 'Expected default Docker user dsh, got root'],
  ] as const)('rejects incorrect %s isolation and cleans owned resources', (stage, message) => {
    const daemon = dockerFixture(stage);
    let started = false;
    const command: DockerCommand = (args, timeout) => {
      if (args[0] === 'start') started = true;
      return daemon.command(args, timeout);
    };

    expect(() => runUserImage('offline-docx', assertDocxReadback, command)).toThrow(message);

    expect(started).toBe(false);
    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each([
    { name: 'effective root identity', invalid: { effectiveUid: 0 } },
    { name: 'wrong workspace', invalid: { path: '/tmp/offline.docx' } },
    {
      name: 'altered Chinese paragraph',
      invalid: { paragraphs: ['离线办公验证', '中文段落被改变'] },
    },
    {
      name: 'altered table cell',
      invalid: {
        tables: [
          [
            ['项目', '状态'],
            ['文档生成', '失败'],
          ],
        ],
      },
    },
  ])('rejects $name readback and still cleans owned resources', ({ invalid }) => {
    const readback = {
      effectiveUid: 1001,
      path: '/data/work/offline.docx',
      paragraphs: ['离线办公验证', '中文段落：无需联网即可生成文档。'],
      tables: [
        [
          ['项目', '状态'],
          ['文档生成', '成功'],
        ],
      ],
      ...invalid,
    };
    const daemon = dockerFixture(undefined, `${JSON.stringify(readback)}\n`);

    expect(() => runUserImage('offline-docx', assertDocxReadback, daemon.command)).toThrow(
      'Offline DOCX readback must match exact non-root workspace and Chinese content',
    );

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });
});

interface DockerResourceInventory {
  readonly images: ReadonlyMap<string, string>;
  readonly containers: ReadonlyMap<string, string>;
  readonly volumes: ReadonlyMap<string, string>;
}

function assertProfileInventory(
  daemon: DockerResourceInventory,
  remainingContainers: readonly [string, string][] = [],
  remainingVolumes: readonly [string, string][] = [],
): void {
  expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
  expect([...daemon.containers]).toEqual([
    ['dsh-team-test-sentinel', 'sentinel-owner'],
    ...remainingContainers,
  ]);
  expect([...daemon.volumes]).toEqual([
    ['dsh-team-test-sentinel-state', 'sentinel-owner'],
    ...remainingVolumes,
  ]);
}

describe('invocation-owned profile volume lifecycle', () => {
  it.each([
    'volume-before-create',
    'volume-create',
    'reuse-create',
    'reuse-start',
    'reuse-wait',
  ] as const)(
    'cleans exact owned resources after %s fails while retaining unrelated sentinels',
    (stage) => {
      const daemon = dockerFixture(stage);

      expect(() => runUserImage('profile-seed', () => undefined, daemon.command)).toThrow(
        stage === 'reuse-wait' ? 'container exited 7' : 'induced daemon failure',
      );

      assertProfileInventory(daemon);
      const removals = daemon.calls
        .filter(({ args }) => args[1] === 'rm')
        .map(({ args }) => args[0]);
      expect(removals).toEqual(
        stage === 'volume-before-create'
          ? ['image']
          : stage === 'volume-create'
            ? ['volume', 'image']
            : ['container', 'container', 'volume', 'image'],
      );
      expect(daemon.calls.every(({ timeout }) => timeout > 0 && timeout <= 600_000)).toBe(true);
    },
  );

  it('preserves a failing seed oracle and cleans the fresh volume before removing the image', () => {
    const daemon = dockerFixture();

    expect(() =>
      runUserImage(
        'profile-seed',
        () => {
          throw new Error('Observed profile bytes do not match seed');
        },
        daemon.command,
      ),
    ).toThrow('Observed profile bytes do not match seed');

    assertProfileInventory(daemon);
    expect(daemon.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args[0])).toEqual([
      'container',
      'volume',
      'image',
    ]);
  });

  it.each([
    {
      stage: 'cleanup',
      name: 'attempts every remaining owned cleanup after container removal fails, without deleting sentinels',
      containersRemain: true,
    },
    {
      stage: 'volume-cleanup',
      name: 'fails cleanup when volume removal fails and still removes both containers and the image',
      containersRemain: false,
    },
  ] as const)('$name', ({ stage, containersRemain }) => {
    const daemon = dockerFixture(stage);
    const ownedContainers: [string, string][] = [];
    let ownedVolume = '';
    let ownedRunId = '';
    const command: DockerCommand = (args, timeout) => {
      if (args[0] === 'create') {
        ownedContainers.push([
          args[args.indexOf('--name') + 1] ?? '',
          args[args.indexOf('--label') + 1]?.split('=')[1] ?? '',
        ]);
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        ownedVolume = args.at(-1) ?? '';
        ownedRunId = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
      }
      return daemon.command(args, timeout);
    };

    expect(() => runUserImage('profile-seed', () => undefined, command)).toThrow(
      'induced daemon failure',
    );

    assertProfileInventory(daemon, containersRemain ? ownedContainers : [], [
      [ownedVolume, ownedRunId],
    ]);
    expect(daemon.calls.filter(({ args }) => args[1] === 'rm').map(({ args }) => args[0])).toEqual([
      'container',
      'container',
      'volume',
      'image',
    ]);
  });

  it('does not mistake failed volume ownership inspection for absence or use the volume', () => {
    const daemon = dockerFixture('volume-inspect');

    expect(() => runUserImage('profile-seed', () => undefined, daemon.command)).toThrow(
      'induced daemon failure',
    );

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    expect(daemon.calls.some(({ args }) => args[0] === 'create')).toBe(false);
    expect([...daemon.volumes.keys()]).toEqual([
      'dsh-team-test-sentinel-state',
      daemon.calls.find(({ args }) => args[0] === 'volume' && args[1] === 'create')?.args.at(-1),
    ]);
  });

  it('refuses to use an initially wrong-owned volume and preserves it without creating a container', () => {
    const daemon = dockerFixture();
    let changedVolume = '';
    const command: DockerCommand = (args, timeout) => {
      const result = daemon.command(args, timeout);
      if (args[0] === 'volume' && args[1] === 'create') {
        changedVolume = args.at(-1) ?? '';
        daemon.volumes.set(changedVolume, 'another-owner');
      }
      return result;
    };

    expect(() => runUserImage('profile-seed', () => undefined, command)).toThrow(
      'Refusing use of state volume: invocation label does not match',
    );

    assertProfileInventory(daemon, [], [[changedVolume, 'another-owner']]);
    expect(daemon.calls.some(({ args }) => args[0] === 'create')).toBe(false);
    expect(daemon.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
  });

  it('refuses a volume whose label changed and still removes all owned containers and image', () => {
    const daemon = dockerFixture();
    let changedVolume = '';

    expect(() =>
      runUserImage(
        'profile-seed',
        () => {
          for (const name of daemon.volumes.keys()) {
            if (name !== 'dsh-team-test-sentinel-state') {
              changedVolume = name;
              daemon.volumes.set(name, 'another-owner');
            }
          }
        },
        daemon.command,
      ),
    ).toThrow('invocation label does not match');

    assertProfileInventory(daemon, [], [[changedVolume, 'another-owner']]);
    expect(daemon.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
  });
});

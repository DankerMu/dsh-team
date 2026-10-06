import { describe, expect, it } from 'vitest';
import { runDockerVersion } from './docker-version-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-version-fixture.ts';

/** Stateful substitute for the Docker daemon boundary, including partially created resources. */
function dockerFixture(
  failAt?: 'build' | 'create' | 'cleanup' | 'inspect' | 'build-before-create',
  version = '0.2.0-rc.2\n',
  absencePrefix: 'Error response from daemon:' | 'Error:' = 'Error response from daemon:',
) {
  const images = new Map<string, string>([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
  const containers = new Map<string, string>([['dsh-team-test-sentinel', 'sentinel-owner']]);
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const fail: DockerCommandResult = { status: 1, stdout: '', stderr: 'induced daemon failure' };
  function buildImage(args: readonly string[]): DockerCommandResult {
    if (failAt === 'build-before-create') return fail;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    images.set(args[args.indexOf('--tag') + 1] ?? '', label);
    return failAt === 'build' ? fail : ok();
  }
  function createContainer(args: readonly string[]): DockerCommandResult {
    if (args.at(-3) !== `sha256:${'a'.repeat(64)}`) return fail;
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    containers.set(args[args.indexOf('--name') + 1] ?? '', label);
    return failAt === 'create' ? fail : ok();
  }
  function inspectResource(
    kind: 'image' | 'container',
    args: readonly string[],
  ): DockerCommandResult {
    const resources = kind === 'image' ? images : containers;
    const name = args.at(-1) ?? '';
    if (failAt === 'inspect') return fail;
    if (!resources.has(name)) {
      return {
        status: 1,
        stdout: '',
        stderr: `${absencePrefix} No such ${kind}: ${name}\n`,
      };
    }
    if (args.includes('{{.Id}}')) return ok(`sha256:${'a'.repeat(64)}\n`);
    return ok(`${resources.get(name) ?? ''}\n`);
  }
  function removeResource(
    kind: 'image' | 'container',
    args: readonly string[],
  ): DockerCommandResult {
    if (failAt === 'cleanup' && kind === 'container') return fail;
    const resources = kind === 'image' ? images : containers;
    resources.delete(args.at(-1) ?? '');
    return ok();
  }
  const command: DockerCommand = (args) => {
    const [operation, subcommand] = args;
    switch (operation) {
      case 'version':
        return ok('28.0.0\n');
      case 'build':
        return buildImage(args);
      case 'create':
        return createContainer(args);
      case 'start':
        return ok(version);
      case 'wait':
        return ok('0\n');
      case 'image':
      case 'container':
        if (subcommand === 'inspect') return inspectResource(operation, args);
        if (subcommand === 'rm') return removeResource(operation, args);
    }
    throw new Error(`Unexpected Docker boundary call: ${args.join(' ')}`);
  };
  return { command, images, containers };
}

describe('invocation-owned Docker version lifecycle', () => {
  it('verifies a version and cleans owned resources without deleting another invocation sentinel', () => {
    const daemon = dockerFixture();

    runDockerVersion((stdout) => {
      expect(stdout).toBe('0.2.0-rc.2\n');
    }, daemon.command);

    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each(['build', 'create'] as const)(
    'cleans partially created resources after %s fails',
    (stage) => {
      const daemon = dockerFixture(stage);

      const run = () =>
        runDockerVersion(() => {
          throw new Error('Version must not be reached');
        }, daemon.command);

      expect(run).toThrow('induced daemon failure');
      expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
      expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    },
  );

  it('preserves the exact-version assertion failure while removing both owned resources', () => {
    const daemon = dockerFixture(undefined, '0.2.0-rc.3\n');

    const run = () =>
      runDockerVersion((stdout) => {
        if (stdout !== '0.2.0-rc.2\n') throw new Error(`Version mismatch: ${stdout}`);
      }, daemon.command);

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
      runDockerVersion((stdout) => {
        expect(stdout).toBe('0.2.0-rc.2\n');
      }, command);

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
      runDockerVersion(() => {
        throw new Error('Version must not be reached');
      }, command);

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
        runDockerVersion(() => {
          throw new Error('Version must not be reached');
        }, daemon.command);

      expect(run).toThrow('induced daemon failure');
      expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
      expect([...daemon.containers]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    },
  );

  it('refuses to delete a target whose invocation label changed and still cleans the owned image', () => {
    const daemon = dockerFixture();
    let changedContainer = '';

    const run = () =>
      runDockerVersion(() => {
        for (const name of daemon.containers.keys()) {
          if (name !== 'dsh-team-test-sentinel') {
            changedContainer = name;
            daemon.containers.set(name, 'another-owner');
          }
        }
      }, daemon.command);

    expect(run).toThrow('invocation label does not match');
    expect([...daemon.images]).toEqual([['dsh-team-test-sentinel:kept', 'sentinel-owner']]);
    expect([...daemon.containers]).toEqual([
      ['dsh-team-test-sentinel', 'sentinel-owner'],
      [changedContainer, 'another-owner'],
    ]);
  });
});

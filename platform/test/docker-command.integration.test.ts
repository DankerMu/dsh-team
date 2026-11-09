import type * as Fs from 'node:fs';
import { readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { output } from './docker-cleanup.ts';
import { createDockerCommands } from './docker-command.ts';
import type { DockerCommandResult } from './docker-command.ts';

// Docker Desktop's CLI resolves through its application bundle; the host need not have one.
const DESKTOP_DOCKER = '/Applications/Docker.app/Contents/Resources/bin/docker';
const DESKTOP_PLUGINS = '/Applications/Docker.app/Contents/Resources/cli-plugins';
const host = vi.hoisted(() => ({
  platform: 'darwin',
  docker: undefined as string | undefined,
  resolved: [] as string[],
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => host.platform,
}));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  const realpathSync = (path: string) => {
    host.resolved.push(path);
    if (path !== '/usr/local/bin/docker') return original.realpathSync(path);
    if (host.docker === undefined)
      throw Object.assign(new Error('missing docker'), { code: 'ENOENT' });
    return host.docker;
  };
  return { ...original, realpathSync, default: { ...original, realpathSync } };
});

afterEach(() => {
  host.platform = 'darwin';
  host.docker = undefined;
  host.resolved.length = 0;
});

async function privateConfig(run: (directory: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-docker-config-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Construction alone runs no Docker process.
const construct = (config: string) => createDockerCommands('/', config, true);

it('points the darwin private configuration at the Docker Desktop CLI plugin directory', async () => {
  host.docker = DESKTOP_DOCKER;
  await privateConfig((directory) => {
    construct(directory);

    const file = join(directory, 'config.json');
    expect(readdirSync(directory)).toEqual(['config.json']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      cliPluginsExtraDirs: [DESKTOP_PLUGINS],
    });
    expect(statSync(file).mode & 0o7777).toBe(0o600);
    expect(host.resolved).toEqual(['/usr/local/bin/docker']);
  });
});

it('leaves an identical darwin plugin configuration untouched', async () => {
  host.docker = DESKTOP_DOCKER;
  await privateConfig((directory) => {
    construct(directory);
    const file = join(directory, 'config.json');
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, past, past);

    construct(directory);

    expect(statSync(file).mtimeMs).toBe(past.getTime());
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      cliPluginsExtraDirs: [DESKTOP_PLUGINS],
    });
  });
});

it('writes nothing on linux', async () => {
  host.platform = 'linux';
  host.docker = DESKTOP_DOCKER;
  await privateConfig((directory) => {
    construct(directory);

    expect(readdirSync(directory)).toEqual([]);
    expect(host.resolved).toEqual([]);
  });
});

it('neither writes nor throws when the Docker CLI path cannot be resolved', async () => {
  await privateConfig((directory) => {
    expect(() => construct(directory)).not.toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});

it('writes nothing for an injected command boundary, which never reads the configuration', async () => {
  host.docker = DESKTOP_DOCKER;
  await privateConfig((directory) => {
    createDockerCommands('/', directory, true, () => ({ status: 0, stdout: '', stderr: '' }));
    expect(readdirSync(directory)).toEqual([]);
  });
});

it('neither writes nor throws when the private configuration directory is unwritable', async () => {
  host.docker = DESKTOP_DOCKER;
  await privateConfig((directory) => {
    const missing = join(directory, 'absent');
    expect(() => construct(missing)).not.toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("compose's required-variable rejection projection", () => {
  const REJECTION =
    'error while interpolating services.platform.environment.DOCUMENT_SERVER_JWT_SECRET: required variable DOCUMENT_SERVER_JWT_SECRET is missing a value: Set DOCUMENT_SERVER_JWT_SECRET for the bundled Document Server\n';
  const FIXED = { status: 1, stdout: '', stderr: 'Web Docker operation failed' };
  const commands = (result: DockerCommandResult) =>
    createDockerCommands('unused', 'unused', true, () => result);

  it('projects only the variable name of a declared compose interpolation exit', () => {
    const { command } = commands({ status: 1, stdout: 'private-stdout', stderr: REJECTION });

    expect(command(['compose', 'up', '-d'], 30_000, 1)).toEqual({
      status: 1,
      stdout: '',
      stderr: 'required variable DOCUMENT_SERVER_JWT_SECRET is missing a value',
    });
  });

  it.each<[string, readonly string[], DockerCommandResult, number | undefined, string | undefined]>(
    [
      [
        'an undeclared status',
        ['compose', 'up'],
        { status: 1, stdout: '', stderr: REJECTION },
        undefined,
        'required-variable',
      ],
      [
        'a different status',
        ['compose', 'up'],
        { status: 2, stdout: '', stderr: REJECTION },
        1,
        'required-variable',
      ],
      [
        'a non-compose command',
        ['exec', 'compose'],
        { status: 1, stdout: '', stderr: REJECTION },
        1,
        undefined,
      ],
      [
        'a process error',
        ['compose', 'up'],
        { status: 1, stdout: '', stderr: REJECTION, error: new Error('private-process-error') },
        1,
        undefined,
      ],
      [
        'a signal',
        ['compose', 'up'],
        { status: 1, stdout: '', stderr: REJECTION, signal: 'SIGKILL' },
        1,
        undefined,
      ],
      [
        'an extra line',
        ['compose', 'up'],
        { status: 1, stdout: '', stderr: `private-line\n${REJECTION}` },
        1,
        'required-variable',
      ],
      [
        'other text',
        ['compose', 'up'],
        { status: 1, stdout: '', stderr: REJECTION.replace('error while', 'private error while') },
        1,
        'unknown',
      ],
      [
        'a lowercase name',
        ['compose', 'up'],
        {
          status: 1,
          stdout: '',
          stderr: REJECTION.replaceAll('DOCUMENT_SERVER', 'document_server'),
        },
        1,
        'unknown',
      ],
    ],
  )('keeps the fixed redaction for %s', (_name, args, result, acceptedStatus, code) => {
    const { command } = commands(result);

    expect(command(args, 30_000, acceptedStatus)).toEqual({
      ...FIXED,
      status: result.status,
      ...(code === undefined ? {} : { stderr: `${FIXED.stderr}\ncompose-failure: ${code}` }),
    });
  });

  it('keeps the fixed redaction on the asynchronous path, which declares no status', async () => {
    const { commandAsync } = commands({ status: 1, stdout: '', stderr: REJECTION });

    expect(await commandAsync(['compose', 'up'], 30_000)).toEqual({
      ...FIXED,
      stderr: `${FIXED.stderr}\ncompose-failure: required-variable`,
    });
  });
});

describe('compose failure category projection', () => {
  const FIXED = 'Web Docker operation failed';
  const commands = (result: DockerCommandResult) =>
    createDockerCommands('unused', 'unused', true, () => result);
  const PORT_BIND =
    'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint dsh-team-test-0f1e-tls (5c9a0d2e7b41): failed to bind host port 127.0.0.1:41234/tcp: address already in use\n';

  it.each<[string, string, string]>([
    [
      'an interpolation line',
      'required-variable',
      'error while interpolating services.platform.environment.PLATFORM_PUBLIC_URL: required variable PLATFORM_PUBLIC_URL is missing a value\n',
    ],
    [
      'an Engine 28 host port bind',
      'port-allocated',
      ` Container dsh-team-test-0f1e-tls  Starting\n${PORT_BIND}`,
    ],
    [
      'an allocated published port',
      'port-allocated',
      'Error response from daemon: driver failed programming external connectivity on endpoint dsh-team-platform (9e1c): Bind for 127.0.0.1:8080 failed: port is already allocated\n',
    ],
    [
      'a missing image identity',
      'image-missing',
      ` Container dsh-team-platform  Creating\nError response from daemon: No such image: sha256:${'a'.repeat(64)}\n`,
    ],
    [
      'a denied pull',
      'image-missing',
      " proxy Pulling \n proxy Error pull access denied for dsh-team-test-0f1e, repository does not exist or may require 'docker login': denied: requested access to the resource is denied\nError response from daemon: pull access denied for dsh-team-test-0f1e, repository does not exist or may require 'docker login'\n",
    ],
    [
      'no available IPv4 pool',
      'network-pool-exhausted',
      ' Network dsh-team-test-0f1e_default  Creating\nfailed to create network dsh-team-test-0f1e_default: Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network\n',
    ],
    [
      'fully subnetted pools',
      'network-pool-exhausted',
      'failed to create network dsh-team-test-0f1e_default: Error response from daemon: all predefined address pools have been fully subnetted\n',
    ],
    [
      'an overlapping pool',
      'network-conflict',
      ' Network dsh-team-test-0f1e_default  Creating\nfailed to create network dsh-team-test-0f1e_default: Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n',
    ],
    [
      'an existing network name',
      'network-conflict',
      'Error response from daemon: network with name dsh-team-test-0f1e_default already exists\n',
    ],
    [
      'a container name in use',
      'container-name-conflict',
      ` Container dsh-team-platform  Creating\nError response from daemon: Conflict. The container name "/dsh-team-platform" is already in use by container "${'c'.repeat(64)}". You have to remove (or rename) that container to be able to reuse that name.\n`,
    ],
    [
      // Categories win in their fixed order, not in the order their lines appear.
      'mixed lines',
      'port-allocated',
      `Error response from daemon: No such image: dsh-team-test-0f1e:platform\nError response from daemon: Conflict. The container name "/dsh-team-platform" is already in use\n${PORT_BIND}`,
    ],
    [
      'an unmatched daemon error',
      'unknown',
      ' Container dsh-team-platform  Starting\nError response from daemon: private failure\n',
    ],
    ['empty stderr', 'unknown', ''],
  ])('projects only the closed code for %s: %s', (_name, code, stderr) => {
    const { command } = commands({ status: 1, stdout: 'private-stdout', stderr });

    expect(command(['compose', 'up', '-d'], 30_000)).toEqual({
      status: 1,
      stdout: '',
      stderr: `${FIXED}\ncompose-failure: ${code}`,
    });
  });

  it('keeps the status and projects the same code on the asynchronous path', async () => {
    const { commandAsync } = commands({ status: 17, stdout: '', stderr: PORT_BIND });

    expect(await commandAsync(['compose', 'up'], 30_000)).toEqual({
      status: 17,
      stdout: '',
      stderr: `${FIXED}\ncompose-failure: port-allocated`,
    });
  });

  it('keeps every secret-shaped token and port out of the projection and its output() failure', async () => {
    // Assembled at run time so the repository holds no JWT-shaped literal for gitleaks to flag.
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJjYW5hcnkifQ', 'c2lnbmF0dXJlLWNhbmFyeQ'].join(
      '.',
    );
    const key = 'sk-private-model-key-canary';
    const canaries = ['user:secret@host', jwt, key, '47219'];
    const stderr = [
      'pulling https://user:secret@host/x',
      `Authorization: Bearer ${jwt}`,
      `DSH_TEAM_MODEL_API_KEY=${key}`,
      'Bind for 127.0.0.1:47219 failed: port is already allocated',
      '',
    ].join('\n');
    const { command, commandAsync } = commands({ status: 1, stdout: stderr, stderr });

    for (const result of [
      command(['compose', 'up'], 30_000),
      await commandAsync(['compose', 'up'], 30_000),
    ]) {
      expect(result).toEqual({
        status: 1,
        stdout: '',
        stderr: `${FIXED}\ncompose-failure: port-allocated`,
      });
      const failure = (() => {
        try {
          output(result, ['compose', 'up']);
        } catch (error) {
          return error;
        }
        throw new Error('Expected the compose failure to throw');
      })();
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('compose-failure: port-allocated');
      for (const canary of [...canaries, 'Bearer', 'DSH_TEAM_MODEL_API_KEY'])
        expect(JSON.stringify(result) + message).not.toContain(canary);
    }
  });
});

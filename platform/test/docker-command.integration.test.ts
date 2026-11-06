import type * as Fs from 'node:fs';
import { readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it.each<[string, readonly string[], DockerCommandResult, number | undefined]>([
    [
      'an undeclared status',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: REJECTION },
      undefined,
    ],
    ['a different status', ['compose', 'up'], { status: 2, stdout: '', stderr: REJECTION }, 1],
    ['a non-compose command', ['exec', 'compose'], { status: 1, stdout: '', stderr: REJECTION }, 1],
    [
      'a process error',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: REJECTION, error: new Error('private-process-error') },
      1,
    ],
    [
      'a signal',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: REJECTION, signal: 'SIGKILL' },
      1,
    ],
    [
      'an extra line',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: `private-line\n${REJECTION}` },
      1,
    ],
    [
      'other text',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: REJECTION.replace('error while', 'private error while') },
      1,
    ],
    [
      'a lowercase name',
      ['compose', 'up'],
      { status: 1, stdout: '', stderr: REJECTION.replaceAll('DOCUMENT_SERVER', 'document_server') },
      1,
    ],
  ])('keeps the fixed redaction for %s', (_name, args, result, acceptedStatus) => {
    const { command } = commands(result);

    expect(command(args, 30_000, acceptedStatus)).toEqual({ ...FIXED, status: result.status });
  });

  it('keeps the fixed redaction on the asynchronous path, which declares no status', async () => {
    const { commandAsync } = commands({ status: 1, stdout: '', stderr: REJECTION });

    expect(await commandAsync(['compose', 'up'], 30_000)).toEqual(FIXED);
  });
});

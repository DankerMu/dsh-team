import type * as Fs from 'node:fs';
import { readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type * as Os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDockerCommands } from './docker-command.ts';

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

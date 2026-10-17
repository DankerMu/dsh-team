import { execFile, spawn } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import {
  inspect,
  inspectNetwork,
  record,
  registerStartupUsers,
  runNetworkAcceptance,
  startDockerInstance,
  startupClient,
} from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

async function runE2e(lifecycle: UserImageLifecycle): Promise<void> {
  const child = spawn('pnpm', ['run', 'e2e'], {
    cwd: lifecycle.repositoryRoot,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // The public command must override this shared socket, not trust an opt-in flag.
      PLATFORM_DOCKER_SOCKET: '/var/run/docker.sock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  let output = '';
  const outcome = { expired: false, spawnFailed: false };
  child.on('error', () => {
    outcome.spawnFailed = true;
  });
  const collect = (chunk: Buffer) => {
    if (output.length < 2 * 1024 * 1024) output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  // Keep the real owner's unchanged 60s startup deadline meaningful.
  const timer = setTimeout(() => {
    outcome.expired = true;
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  }, 45_000);
  try {
    const code = await closed;
    if (outcome.expired || outcome.spawnFailed || code !== 0) {
      // Build and hurl output are from this credential-free invocation only.
      process.stderr.write(output);
      throw new Error('Concurrent built-artifact verification failed');
    }
    expect(output).toContain('e2e: database schema/migration OK');
    expect(output).toContain('e2e: built artifact served smoke/*.hurl');
  } finally {
    clearTimeout(timer);
  }
}

async function heldStartup(lifecycle: UserImageLifecycle): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'platform.db'));
  const { client } = startupClient(lifecycle);
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const owner = createOrchestrator({
    client: {
      ...client,
      async json(method, path, body, signal, maxBytes) {
        if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${userId}`) {
          reached.resolve(undefined);
          await release.promise;
        }
        return client.json(method, path, body, signal, maxBytes);
      },
    },
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  let starting: ReturnType<typeof startDockerInstance> | undefined;
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userId], 'e2e-isolation.test');
    starting = startDockerInstance(owner, lifecycle, userId, 'e2e-isolation.test:8443');
    // Observe rejection immediately and do not leave a held startup on any assertion failure.
    const settled = starting.then(
      () => {
        throw new Error('Startup completed without the hold');
      },
      () => {
        throw new Error('Startup failed before the hold');
      },
    );
    await Promise.race([reached.promise, settled]);
    const network = inspectNetwork(lifecycle, `dsh-team-net-${userId}`);
    expect(network.Containers).toEqual({});
    expect(network.Labels).toMatchObject({ 'dsh-team.user': userId });
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
    ).toBeUndefined();
    const absent = await client
      .json('GET', `/containers/dsh-team-u-${userId}/json`)
      .catch((error: unknown) => {
        expect(error).toMatchObject({ statusCode: 404 });
        return null;
      });
    expect(absent).toBeNull();

    await runE2e(lifecycle);

    expect(inspectNetwork(lifecycle, `dsh-team-net-${userId}`).Id).toBe(network.Id);
    release.resolve(undefined);
    const result = await starting;
    expect(record(inspect(lifecycle, result.containerId).State).Running).toBe(true);
    expect(database.prepare('SELECT status FROM instances WHERE user_id = ?').get(userId)).toEqual({
      status: 'running',
    });
    return 'held bridge preserved; original startup ready; built e2e passed';
  } finally {
    release.resolve(undefined);
    await starting?.catch(() => undefined);
    database.close();
  }
}

it('keeps another real startup bridge intact while built e2e reconciles its own Engine', async () => {
  await runNetworkAcceptance(heldStartup, 'e2e-engine-isolation', (summary) => {
    expect(summary).toBe('held bridge preserved; original startup ready; built e2e passed');
  });
});

it.each([
  'prerequisite',
  'executable',
  'setup',
  'partial',
  'identity',
  'eof',
  'parent-kill',
  'supervisor-kill',
])('retires only owned runtime processes after %s', async (mode) => {
  const { stdout } = await promisify(execFile)(
    '/usr/bin/sudo',
    [
      '-n',
      '/usr/bin/python3',
      fileURLToPath(new URL('./e2e-engine-fixture.py', import.meta.url)),
      mode,
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      timeout: 120_000,
      maxBuffer: 65_536,
    },
  );
  const observed: unknown = JSON.parse(stdout);
  expect(observed).toEqual({
    mode,
    faultRejected: true,
    ownedTreeGone: true,
    unrelatedSentinelAlive: true,
    gracefulRootsRemoved: mode !== 'supervisor-kill',
  });
});

it.each([
  [
    'gracefully retires its private runtime after a public-command process-group signal',
    'public-group',
  ],
  ['preserves the calling network namespace default bridge during actual e2e', 'network-sentinel'],
])('%s', async (_description, mode) => {
  const path = process.env.PATH;
  if (path === undefined) throw new Error('Missing trusted toolchain path');
  const network = mode === 'network-sentinel';
  const { stdout } = await promisify(execFile)(
    '/usr/bin/sudo',
    [
      '-n',
      ...(network ? ['/usr/bin/unshare', '--net'] : []),
      '/usr/bin/python3',
      fileURLToPath(new URL('./e2e-engine-fixture.py', import.meta.url)),
      mode,
      path,
      ...(network ? [await readlink('/proc/self/ns/net')] : []),
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      timeout: 150_000,
      maxBuffer: 65_536,
    },
  );
  const observed: unknown = JSON.parse(stdout);
  expect(observed).toEqual({
    mode,
    actualHttpCompleted: true,
    ownedTreeGone: true,
    rootRemoved: true,
    sentinelAlive: true,
  });
});

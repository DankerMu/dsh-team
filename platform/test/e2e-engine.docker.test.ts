import { execFile } from 'node:child_process';
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
import { runE2e } from './e2e-command-fixture.ts';

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

    await runE2e(lifecycle.repositoryRoot);

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

async function runFaultFixture(mode: string): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(
    '/usr/bin/sudo',
    [
      '-n',
      '/usr/bin/unshare',
      '--net',
      '/usr/bin/python3',
      fileURLToPath(new URL('./e2e-engine-fixture.py', import.meta.url)),
      mode,
      await readlink('/proc/self/ns/net'),
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      timeout: 120_000,
      maxBuffer: 65_536,
    },
  );
}

it('rejects an unrelated early failure instead of qualifying identity refusal', async () => {
  const failure: unknown = await runFaultFixture('unrelated-identity').catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ code: 1 });
  const stdout = record(failure).stdout;
  if (typeof stdout !== 'string') throw new Error('Missing fault qualification result');
  expect(JSON.parse(stdout)).toEqual({
    outcome: 'unqualified',
    reason: 'fault-phase-unobserved',
  });
});

it.each([
  'prerequisite',
  'network',
  'executable',
  'setup',
  'partial',
  'identity',
  'eof',
  'parent-kill',
  'supervisor-kill',
])('retires only owned runtime processes after %s', async (mode) => {
  const { stdout } = await runFaultFixture(mode);
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

it('joins actual detached e2e and private Engine retirement before custody cancellation completes', async () => {
  const path = process.env.PATH;
  if (path === undefined) throw new Error('Missing trusted toolchain path');
  const { stdout } = await promisify(execFile)(
    '/usr/bin/sudo',
    [
      '-n',
      '/usr/bin/python3',
      fileURLToPath(new URL('./e2e-engine-fixture.py', import.meta.url)),
      'custody',
      path,
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      timeout: 150_000,
      maxBuffer: 65_536,
    },
  );

  expect(JSON.parse(stdout) as unknown).toEqual({
    actualHttpCompleted: true,
    ownedTreeGoneAtTerminal: true,
    canonicalRootsRemoved: true,
    sentinelAlive: true,
    originalCancellationPreserved: true,
  });
});

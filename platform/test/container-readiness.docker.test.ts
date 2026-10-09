import { chmod, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createOrchestrator, extractLaunchToken } from '../src/orchestrator/index.ts';
import { START_MODEL, START_PERMISSION } from './container-start-fixture.ts';
import {
  cookieHttpStatus,
  inspect,
  record,
  startupClient,
} from './container-start-docker-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { isAbsentResource } from './docker-command.ts';

async function corruptOwnedOverlay(
  lifecycle: UserImageLifecycle,
  userId: string,
  containerId: string,
): Promise<void> {
  const container = inspect(lifecycle, containerId);
  expect(container.Id).toBe(containerId);
  expect(container.Name).toBe(`/dsh-team-u-${userId}`);
  expect(container.Image).toBe(lifecycle.imageId);
  expect(record(container.Config).Labels).toMatchObject({ 'dsh-team.user': userId });
  expect(record(container.State).Running).toBe(false);
  const overlay = join(lifecycle.overlayDirectory, `${userId}.patch.yml`);
  expect(container.Mounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'bind',
        Source: overlay,
        Destination: '/managed/patch.yml',
        RW: false,
      }),
    ]),
  );
  const before = await stat(overlay);
  expect(before.isFile()).toBe(true);
  expect(before.mode & 0o777).toBe(0o444);
  // In-place overwrite preserves the inode Docker bound during real container creation.
  await chmod(overlay, 0o644);
  try {
    await writeFile(overlay, '- id: webserver\n  config: [\n', 'utf8');
  } finally {
    await chmod(overlay, 0o444);
  }
  const after = await stat(overlay);
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
  expect(after.mode & 0o777).toBe(0o444);
}

async function assertAuthenticatedReadiness(
  container: Record<string, unknown>,
  row: Record<string, unknown>,
  authority: string,
  diagnostic: string,
): Promise<void> {
  expect(row.status).toBe('running');
  expect(row.last_error).toBeNull();
  if (typeof row.dsh_cookie !== 'string') throw new Error('Missing backend readiness credential');
  const bindings = record(record(container.NetworkSettings).Ports)['3080/tcp'];
  if (!Array.isArray(bindings) || bindings.length !== 1)
    throw new Error('Independent readiness endpoint missing');
  const binding = record(bindings[0]);
  expect(binding.HostIp).toBe('127.0.0.1');
  if (typeof binding.HostPort !== 'string') throw new Error('Invalid readiness endpoint');
  expect(await cookieHttpStatus(Number(binding.HostPort), authority, row.dsh_cookie)).toBe(200);
  for (const secret of [row.dsh_cookie, row.dsh_cookie.slice(row.dsh_cookie.indexOf('=') + 1)])
    expect(diagnostic.includes(secret)).toBe(false);
}

function assertFailedStartupLogs(row: Record<string, unknown>, actualOutput: string): void {
  expect(row.status).toBe('error');
  expect(row.dsh_cookie === null).toBe(true);
  if (typeof row.last_error !== 'string') throw new Error('Missing startup failure diagnostic');
  const actualLines = actualOutput.split(/\r?\n/).map((line) =>
    Array.from(line)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
      })
      .join(''),
  );
  const retained = row.last_error.split('\n').slice(1);
  expect(retained.some((line) => line.length > 0 && actualLines.includes(line))).toBe(true);
  expect(retained.every((line) => !line.startsWith('Startup logs unavailable:'))).toBe(true);
}

async function readinessScenario(
  lifecycle: UserImageLifecycle,
  badOverlay: boolean,
): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const name = `dsh-team-u-${userId}`;
  const ownership = { 'dsh-team.user': userId };
  lifecycle.registerResource('volume', lifecycle.stateVolume, ownership);
  lifecycle.registerResource('volume', lifecycle.workVolume, ownership);
  lifecycle.registerResource('container', name, ownership);
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'readiness-platform.db'));
  const { client: base } = startupClient(lifecycle);
  const authority = 'readiness.example:8443';
  let createdId: string | undefined;
  let injected = false;
  const client: typeof base = {
    logs: (path, signal) => base.logs(path, signal),
    async json(method, path, body, signal) {
      const create = method === 'POST' && path === `/containers/create?name=${name}`;
      if (create) {
        const configuration = record(body);
        expect(configuration.Image).toBe(lifecycle.imageId);
        expect(configuration.Labels).toEqual(ownership);
        expect(record(configuration.HostConfig).Mounts).toEqual(
          expect.arrayContaining([
            {
              Type: 'bind',
              Source: join(lifecycle.overlayDirectory, `${userId}.patch.yml`),
              Target: '/managed/patch.yml',
              ReadOnly: true,
            },
          ]),
        );
      }
      if (
        badOverlay &&
        createdId !== undefined &&
        method === 'POST' &&
        path === `/containers/${createdId}/start`
      ) {
        expect(injected).toBe(false);
        expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
          status: 'starting',
          container_id: createdId,
        });
        await corruptOwnedOverlay(lifecycle, userId, createdId);
        injected = true;
      }
      const result = await base.json(method, path, body, signal);
      if (create) {
        const id = record(result).Id;
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
          throw new Error('Owned readiness create returned invalid identity');
        createdId = id;
      }
      return result;
    },
  };
  const { startUserContainer, waitForUserContainerReady } = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  try {
    applyMigrations(database);
    database
      .prepare(
        "INSERT INTO users VALUES (?, 'readiness@example.test', 'unused-hash', 'employee', 'active', 1)",
      )
      .run(userId);
    let startFailed = false;
    try {
      const started = await startUserContainer({
        userId,
        config: {
          userImage: lifecycle.imageId,
          seccompProfilePath: lifecycle.seccomp,
          managedConfigDir: lifecycle.overlayDirectory,
          authority,
          subnetPool: '172.30.0.0/16',
        },
        modelSettings: START_MODEL,
        modelKey: 'docker-acceptance-only-not-a-model-credential',
        permission: START_PERMISSION,
      });
      expect(started.outcome).toBe('starting');
    } catch (error) {
      if (!badOverlay) throw error;
      // A fast real exit may precede endpoint persistence; readiness still owns the indexed row.
      startFailed = true;
    }
    if (createdId === undefined)
      throw new Error('Readiness acceptance did not create its container');
    expect(injected).toBe(badOverlay);
    expect(record(database.prepare('SELECT status, container_id FROM instances').get())).toEqual({
      status: 'starting',
      container_id: createdId,
    });
    let failure: Error | undefined;
    let unexpectedFailure = false;
    try {
      await waitForUserContainerReady({ userId, authority });
    } catch (error) {
      if (error instanceof Error) failure = error;
      else unexpectedFailure = true;
    }
    if (unexpectedFailure) throw new Error('Unexpected readiness result');
    expect(failure !== undefined).toBe(badOverlay);
    const row = record(
      database
        .prepare('SELECT status, dsh_cookie, last_error FROM instances WHERE user_id = ?')
        .get(userId),
    );
    const container = inspect(lifecycle, createdId);
    expect(container.Id).toBe(createdId);
    expect(container.Image).toBe(lifecycle.imageId);
    expect(record(container.Config).Labels).toMatchObject(ownership);
    expect(record(container.State).Running).toBe(!badOverlay);
    const events = database
      .prepare('SELECT event_type, details FROM audit_events ORDER BY id')
      .all();
    expect(events).toEqual([
      { event_type: 'instance.created', details: '{}' },
      ...(!startFailed ? [{ event_type: 'instance.started', details: '{}' }] : []),
      { event_type: badOverlay ? 'instance.start-failed' : 'instance.ready', details: '{}' },
    ]);
    const observed = lifecycle.command(['logs', '--tail', '1000', createdId], 15_000);
    if (observed.status !== 0 || observed.error !== undefined)
      throw new Error('Independent readiness log observation failed');
    const diagnostic =
      JSON.stringify(failure, failure === undefined ? [] : Object.getOwnPropertyNames(failure)) +
      JSON.stringify(events) +
      JSON.stringify({ last_error: row.last_error });
    const launchToken = extractLaunchToken(observed.stdout);
    if (launchToken !== undefined) expect(diagnostic.includes(launchToken)).toBe(false);
    if (badOverlay) {
      assertFailedStartupLogs(row, observed.stdout + observed.stderr);
      const networkName = `dsh-team-net-${userId}`;
      expect(
        isAbsentResource(
          lifecycle.command(['network', 'inspect', networkName], 15_000),
          'network',
          networkName,
        ),
      ).toBe(true);
    } else {
      expect(launchToken !== undefined).toBe(true);
      await assertAuthenticatedReadiness(container, row, authority, diagnostic);
    }
    return JSON.stringify({
      status: badOverlay ? 'error' : 'running',
      authenticated200: !badOverlay,
      ownedOverlayCorrupted: injected,
      actualSafeLogs: badOverlay,
      secretSafe: true,
    });
  } finally {
    database.close();
  }
}

it.each([false, true])(
  'completes production readiness with real owned Docker and bad overlay: %s',
  async (badOverlay) => {
    if (platform() !== 'linux' || arch() !== 'x64')
      throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
    const result = await runUserImage(
      'container-start',
      (summary) => {
        expect(JSON.parse(summary)).toEqual({
          status: badOverlay ? 'error' : 'running',
          authenticated200: !badOverlay,
          ownedOverlayCorrupted: badOverlay,
          actualSafeLogs: badOverlay,
          secretSafe: true,
        });
      },
      undefined,
      (lifecycle) => readinessScenario(lifecycle, badOverlay),
    );
    process.stdout.write(
      `Docker readiness verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
    );
  },
);

import { stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import { startupEvidence, START_MODEL, START_PERMISSION } from './container-start-fixture.ts';
import {
  cookieHttpStatus,
  inspect,
  record,
  startupClient,
} from './container-start-docker-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

async function capacityScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  // Invocation IDs are hexadecimal; non-hex suffixes guarantee distinct owned user identities.
  const userB = `${userA.slice(0, 10)}zz`;
  const userC = `${userA.slice(0, 10)}yy`;
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'capacity-platform.db'));
  const { raw, client, helperIds, requests } = startupClient(lifecycle);
  const owner = createOrchestrator({ client, database });
  const authority = 'capacity.example:8443';
  const input = {
    userId: userA,
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
  };
  try {
    applyMigrations(database);
    writeSettings(database, { maxRunningInstances: 1 });
    for (const user of [userA, userB, userC]) {
      const ownership = { 'dsh-team.user': user };
      lifecycle.registerResource('volume', `dsh-team-home-${user}`, ownership);
      lifecycle.registerResource('volume', `dsh-team-work-${user}`, ownership);
      lifecycle.registerResource('container', `dsh-team-u-${user}`, ownership);
      database
        .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
        .run(user, `${user}@capacity.example`);
    }
    const a = await owner.startUserContainer(input);
    expect(a.outcome).toBe('starting');
    if (a.outcome !== 'starting') throw new Error('Expected admitted A startup');
    await owner.waitForUserContainerReady({ userId: userA, authority });
    const rowA = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userA));
    expect(rowA.status).toBe('running');
    if (typeof rowA.dsh_cookie !== 'string') throw new Error('Ready A has no cookie');
    expect(await cookieHttpStatus(a.upstreamPort, authority, rowA.dsh_cookie)).toBe(200);
    const beforeA = await startupEvidence(database, input);
    const inspectedA = inspect(lifecycle, a.containerId);
    const requestsBefore = [...requests];
    const helpersBefore = [...helperIds];
    const changes: unknown = database.prepare('SELECT total_changes() AS count').get();

    const full = await owner.startUserContainer({ ...input, userId: userB });

    expect(full).toEqual({ outcome: 'full' });
    expect(requests).toEqual(requestsBefore);
    expect(helperIds).toEqual(helpersBefore);
    expect(await startupEvidence(database, input)).toEqual(beforeA);
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB),
    ).toBeUndefined();
    const afterA = inspect(lifecycle, a.containerId);
    expect(afterA.Id).toBe(inspectedA.Id);
    expect(afterA.Config).toEqual(inspectedA.Config);
    expect(afterA.HostConfig).toEqual(inspectedA.HostConfig);
    expect(record(afterA.State).Running).toBe(true);
    expect(await cookieHttpStatus(a.upstreamPort, authority, rowA.dsh_cookie)).toBe(200);
    await expect(
      stat(join(lifecycle.overlayDirectory, `${userB}.patch.yml`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    for (const volume of [`dsh-team-home-${userB}`, `dsh-team-work-${userB}`]) {
      await expect(
        raw.json('GET', `/volumes/${volume}`, undefined, AbortSignal.timeout(15_000)),
      ).rejects.toMatchObject({ statusCode: 404 });
    }

    await owner.stopUserContainer({ userId: userA, reason: 'admin' });
    expect(
      database.prepare('SELECT status, container_id FROM instances WHERE user_id = ?').get(userA),
    ).toEqual({ status: 'stopped', container_id: null });
    await expect(
      raw.json('GET', `/containers/${a.containerId}/json`, undefined, AbortSignal.timeout(15_000)),
    ).rejects.toMatchObject({ statusCode: 404 });
    const bInput = { ...input, userId: userB };
    const b = await owner.startUserContainer(bInput);
    expect(b.outcome).toBe('starting');
    if (b.outcome !== 'starting') throw new Error('Expected B startup after A retirement');
    await owner.waitForUserContainerReady({ userId: userB, authority });
    const rowB = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB));
    expect(rowB.status).toBe('running');
    if (typeof rowB.dsh_cookie !== 'string') throw new Error('Ready B has no cookie');
    expect(await cookieHttpStatus(b.upstreamPort, authority, rowB.dsh_cookie)).toBe(200);
    const beforeB = await startupEvidence(database, bInput);
    const requestsConfigured = [...requests];
    const configuredChanges: unknown = database.prepare('SELECT total_changes() AS count').get();

    const clearedB = await owner.startUserContainer({ ...bInput, modelKey: undefined });
    const clearedNewUser = await owner.startUserContainer({
      ...input,
      userId: userC,
      modelSettings: { ...START_MODEL, models: [] },
    });

    expect(clearedB).toEqual({ outcome: 'unconfigured' });
    expect(clearedNewUser).toEqual({ outcome: 'unconfigured' });
    expect(requests).toEqual(requestsConfigured);
    expect(await startupEvidence(database, bInput)).toEqual(beforeB);
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(configuredChanges);
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userC),
    ).toBeUndefined();
    await expect(
      stat(join(lifecycle.overlayDirectory, `${userC}.patch.yml`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      raw.json(
        'GET',
        `/containers/dsh-team-u-${userC}/json`,
        undefined,
        AbortSignal.timeout(15_000),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    for (const volume of [`dsh-team-home-${userC}`, `dsh-team-work-${userC}`]) {
      await expect(
        raw.json('GET', `/volumes/${volume}`, undefined, AbortSignal.timeout(15_000)),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(
      database.prepare('SELECT event_type, target FROM audit_events ORDER BY id').all(),
    ).toEqual([
      { event_type: 'instance.created', target: userA },
      { event_type: 'instance.started', target: userA },
      { event_type: 'instance.ready', target: userA },
      { event_type: 'instance.stopped', target: userA },
      { event_type: 'instance.created', target: userB },
      { event_type: 'instance.started', target: userB },
      { event_type: 'instance.ready', target: userB },
    ]);
    expect(helperIds).toHaveLength(2);
    return JSON.stringify({
      limit: 1,
      first: a.outcome,
      denied: full.outcome,
      aPreservedStatus: 200,
      aRetired: true,
      retry: b.outcome,
      bReadyStatus: 200,
      clearedExisting: clearedB.outcome,
      clearedNew: clearedNewUser.outcome,
      noDenialMutations: true,
      helpers: 2,
    });
  } finally {
    database.close();
  }
}

it('limit1 preserves ready A when B is full, admits B after retirement and gives missing-model precedence', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        limit: 1,
        first: 'starting',
        denied: 'full',
        aPreservedStatus: 200,
        aRetired: true,
        retry: 'starting',
        bReadyStatus: 200,
        clearedExisting: 'unconfigured',
        clearedNew: 'unconfigured',
        noDenialMutations: true,
        helpers: 2,
      });
    },
    undefined,
    capacityScenario,
  );
  process.stdout.write(
    `Docker admitted capacity verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});

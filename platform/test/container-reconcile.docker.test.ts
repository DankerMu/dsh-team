import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { allocateSubnet, createOrchestrator } from '../src/orchestrator/index.ts';
import { startupEvidence, START_MODEL, START_PERMISSION } from './container-start-fixture.ts';
import {
  inspect,
  record,
  startupClient,
  createStandInPlatform,
  platformHttpStatus,
  inspectNetwork,
} from './container-start-docker-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

async function reconciliationScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.slice(0, 10)}zz`;
  const platformName = `dsh-team-test-reconcile-${lifecycle.runId}`;
  const originalPlatform = String(createStandInPlatform(lifecycle, platformName).Id);
  const config = { upstreamMode: 'network' as const, platformContainerName: platformName };
  const database = openDatabase(
    join(dirname(lifecycle.overlayDirectory), 'reconciliation-platform.db'),
  );
  const { raw, client } = startupClient(lifecycle);
  const owner = createOrchestrator({
    client,
    database,
    config,
  });
  const authority = 'reconcile.example:8443';
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
    const survivors: {
      user: string;
      id: string;
      host: string;
      cookie: string;
      row: Record<string, unknown>;
      physical: Record<string, unknown>;
    }[] = [];
    for (const user of [userA, userB]) {
      const labels = { 'dsh-team.user': user };
      lifecycle.registerResource('container', `dsh-team-u-${user}`, labels);
      for (const kind of ['home', 'work'])
        lifecycle.registerResource('volume', `dsh-team-${kind}-${user}`, labels);
      database
        .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
        .run(user, `${user}@reconcile.example`);
      const started = await owner.startUserContainer({ ...input, userId: user });
      if (started.outcome !== 'starting') throw new Error('Expected production startup');
      await owner.waitForUserContainerReady({ userId: user, authority });
      const row = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(user));
      if (typeof row.dsh_cookie !== 'string') throw new Error('Missing ready cookie');
      expect(
        platformHttpStatus(
          lifecycle,
          originalPlatform,
          started.upstreamHost,
          authority,
          row.dsh_cookie,
        ),
      ).toBe(200);
      survivors.push({
        user,
        id: started.containerId,
        host: started.upstreamHost,
        cookie: row.dsh_cookie,
        row,
        physical: inspect(lifecycle, started.containerId),
      });
    }
    const before = await Promise.all(
      [userA, userB].map((userId) => startupEvidence(database, { ...input, userId })),
    );
    expect(lifecycle.command(['container', 'rm', '--force', originalPlatform], 15_000).status).toBe(
      0,
    );
    const replacement = createStandInPlatform(lifecycle, platformName);
    const platformId = String(replacement.Id);
    expect(platformId).not.toBe(originalPlatform);
    const primary = structuredClone(record(record(replacement.NetworkSettings).Networks).bridge);
    const orphanUser = `${userA.slice(0, 10)}yy`;
    const orphanName = `dsh-team-net-${orphanUser}`;
    lifecycle.registerResource('network', orphanName, { 'dsh-team.user': orphanUser });
    const inventory = await raw.json('GET', '/networks', undefined, AbortSignal.timeout(15_000));
    if (!Array.isArray(inventory)) throw new Error('Missing network inventory');
    const occupied = inventory.flatMap((entry: unknown) => {
      const configs = record(record(entry).IPAM).Config;
      return Array.isArray(configs)
        ? configs.map((value: unknown) => String(record(value).Subnet))
        : [];
    });
    const created = record(
      await raw.json(
        'POST',
        '/networks/create',
        {
          Name: orphanName,
          Driver: 'bridge',
          Internal: false,
          EnableIPv6: false,
          Labels: { 'dsh-team.user': orphanUser },
          IPAM: {
            Driver: 'default',
            Config: [{ Subnet: allocateSubnet('172.30.0.0/16', occupied) }],
          },
        },
        AbortSignal.timeout(15_000),
      ),
    );
    const orphanId = String(created.Id);
    expect(Object.keys(record(inspectNetwork(lifecycle, orphanId).Containers))).toEqual([]);
    const reconstructed = createOrchestrator({
      client,
      database,
      config,
    });

    await reconstructed.reconcile();
    await reconstructed.reconcile();

    expect(
      await Promise.all(
        [userA, userB].map((userId) => startupEvidence(database, { ...input, userId })),
      ),
    ).toEqual(before);
    await expect(
      raw.json('GET', `/networks/${orphanId}`, undefined, AbortSignal.timeout(15_000)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(record(record(inspect(lifecycle, platformId).NetworkSettings).Networks).bridge).toEqual(
      primary,
    );
    for (const survivor of survivors) {
      expect(
        database.prepare('SELECT * FROM instances WHERE user_id = ?').get(survivor.user),
      ).toEqual(survivor.row);
      const physical = inspect(lifecycle, survivor.id);
      expect(physical.Id).toBe(survivor.id);
      expect(physical.Config).toEqual(survivor.physical.Config);
      expect(physical.HostConfig).toEqual(survivor.physical.HostConfig);
      expect(physical.NetworkSettings).toEqual(survivor.physical.NetworkSettings);
      expect(record(physical.State).Running).toBe(true);
      expect(Object.values(record(record(physical.NetworkSettings).Ports))).toEqual([null]);
      expect(record(physical.HostConfig).PublishAllPorts).toBe(false);
      const owned = record(
        record(record(physical.NetworkSettings).Networks)[`dsh-team-net-${survivor.user}`],
      );
      const bridge = inspectNetwork(lifecycle, String(owned.NetworkID));
      expect(Object.keys(record(bridge.Containers)).sort()).toEqual(
        [survivor.id, platformId].sort(),
      );
      expect(platformHttpStatus(lifecycle, platformId, survivor.host, authority)).toBe(401);
      expect(
        platformHttpStatus(lifecycle, platformId, survivor.host, authority, survivor.cookie),
      ).toBe(200);
    }
    const first = survivors[0];
    const second = survivors[1];
    if (first === undefined || second === undefined) throw new Error('Missing survivor evidence');
    // Independent exact-owned removal, not a platform lifecycle call or reusable-name deletion.
    const removed = lifecycle.command(['container', 'rm', '--force', first.id], 15_000);
    expect(removed.status).toBe(0);
    expect(removed.error).toBeUndefined();
    await reconstructed.reconcile();
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(second.user)).toEqual(
      second.row,
    );
    expect(platformHttpStatus(lifecycle, platformId, second.host, authority, second.cookie)).toBe(
      200,
    );
    database.prepare('UPDATE instances SET dsh_cookie = NULL WHERE user_id = ?').run(second.user);
    await reconstructed.reconcile();
    const audits = database
      .prepare('SELECT event_type, target, details FROM audit_events ORDER BY id')
      .all();
    expect(audits).toEqual([
      { event_type: 'instance.created', target: userA, details: '{}' },
      { event_type: 'instance.started', target: userA, details: '{}' },
      { event_type: 'instance.ready', target: userA, details: '{}' },
      { event_type: 'instance.created', target: userB, details: '{}' },
      { event_type: 'instance.started', target: userB, details: '{}' },
      { event_type: 'instance.ready', target: userB, details: '{}' },
      { event_type: 'instance.stopped', target: userA, details: '{"reason":"error"}' },
      { event_type: 'instance.stopped', target: userB, details: '{"reason":"error"}' },
    ]);
    for (const survivor of survivors) {
      expect(
        database.prepare('SELECT * FROM instances WHERE user_id = ?').get(survivor.user),
      ).toEqual({
        ...survivor.row,
        status: 'stopped',
        container_id: null,
        image_id: null,
        image_tag: null,
        upstream_host: null,
        upstream_port: null,
        dsh_cookie: null,
      });
      await expect(
        raw.json('GET', `/containers/${survivor.id}/json`, undefined, AbortSignal.timeout(15_000)),
      ).rejects.toMatchObject({ statusCode: 404 });
      for (const kind of ['home', 'work']) {
        const name = `dsh-team-${kind}-${survivor.user}`;
        const volume = record(
          await raw.json('GET', `/volumes/${name}`, undefined, AbortSignal.timeout(15_000)),
        );
        expect(volume.Name).toBe(name);
        expect(volume.Labels).toEqual({ 'dsh-team.user': survivor.user });
      }
    }
    await reconstructed.reconcile();
    expect(
      database.prepare('SELECT event_type, target, details FROM audit_events ORDER BY id').all(),
    ).toEqual(audits);
    return JSON.stringify({
      survivors: 2,
      authenticatedBefore: [200, 200],
      authenticatedAfter: [200, 200],
      missingCorrected: true,
      missingCookieCorrected: true,
      retainedVolumes: 4,
      stopAudits: 2,
      platformRecreated: true,
      orphanDeleted: true,
    });
  } finally {
    database.close();
  }
}

it('reconstructs the owner without replacing two ready survivors then corrects missing-container and missing-cookie state', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        survivors: 2,
        authenticatedBefore: [200, 200],
        authenticatedAfter: [200, 200],
        missingCorrected: true,
        missingCookieCorrected: true,
        retainedVolumes: 4,
        stopAudits: 2,
        platformRecreated: true,
        orphanDeleted: true,
      });
    },
    undefined,
    reconciliationScenario,
  );
  process.stdout.write(
    `Docker reconciliation verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import {
  allocateSubnet,
  createOrchestrator,
  instanceAddressLayout,
} from '../src/orchestrator/index.ts';
import { startupEvidence, START_MODEL } from './container-start-fixture.ts';
import {
  inspect,
  record,
  startupClient,
  createStandInPlatform,
  platformHttpStatus,
  inspectNetwork,
  registerStartupUsers,
  startDockerInstance,
} from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** Real Docker accepts the requested layout platform address on connect and echoes it. */
function expectPlatformAtLayout(
  lifecycle: UserImageLifecycle,
  platformId: string,
  user: string,
  networkId: string,
): void {
  const bridge = inspectNetwork(lifecycle, networkId);
  const configs = record(bridge.IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1)
    throw new Error('Unexpected instance network IPAM');
  const { platform: address } = instanceAddressLayout(String(record(configs[0]).Subnet));
  expect(record(record(bridge.Containers)[platformId]).IPv4Address).toBe(`${address}/28`);
  const attachment = record(
    record(record(inspect(lifecycle, platformId).NetworkSettings).Networks)[`dsh-team-net-${user}`],
  );
  expect(attachment.NetworkID).toBe(networkId);
  expect(attachment.IPAddress).toBe(address);
  expect(record(attachment.IPAMConfig).IPv4Address).toBe(address);
}

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
    for (const survivor of survivors) {
      const owned = record(
        record(record(survivor.physical.NetworkSettings).Networks)[`dsh-team-net-${survivor.user}`],
      );
      expectPlatformAtLayout(lifecycle, originalPlatform, survivor.user, String(owned.NetworkID));
    }
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
      expectPlatformAtLayout(lifecycle, platformId, survivor.user, String(owned.NetworkID));
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
        instance_token_hash: null,
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

type RawDocker = ReturnType<typeof startupClient>['raw'];
const SURVIVOR_MARKER = 'survivor-data-retained';

function bridgeSubnet(lifecycle: UserImageLifecycle, networkId: string): string {
  const configs = record(inspectNetwork(lifecycle, networkId).IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1)
    throw new Error('Unexpected instance network IPAM');
  return String(record(configs[0]).Subnet);
}

/** The stage-1 range rule of `validateEndpointAddress`: strictly between base and base+15. */
function inInstanceRange(address: unknown, subnet: string): boolean {
  if (typeof address !== 'string') return false;
  const base = subnet.slice(0, -3);
  const lastDot = base.lastIndexOf('.');
  const prefix = base.slice(0, lastDot + 1);
  if (!address.startsWith(prefix)) return false;
  const host = Number(address.slice(prefix.length));
  const start = Number(base.slice(lastDot + 1));
  return (
    Number.isInteger(host) &&
    host > start &&
    host < start + 15 &&
    address === `${prefix}${String(host)}`
  );
}

function ownedAttachment(
  lifecycle: UserImageLifecycle,
  id: string,
  user: string,
): Record<string, unknown> {
  return record(
    record(record(inspect(lifecycle, id).NetworkSettings).Networks)[`dsh-team-net-${user}`],
  );
}

function survivorMarker(lifecycle: UserImageLifecycle, id: string, code: string): string {
  const result = lifecycle.command(['exec', id, 'python3', '-c', code], 10_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Survivor marker access failed');
  return result.stdout.trim();
}

/**
 * Rewrite the instance's managed overlay so its `webserver` row names `to`, then restart the
 * container so DSH rebinds there. The read-only file bind (`start.ts` `/managed/patch.yml`) is
 * by inode: write in place, never rename, so the container sees the new bytes.
 */
function rebindSurvivorWeb(
  lifecycle: UserImageLifecycle,
  user: string,
  containerId: string,
  from: string,
  to: string,
): void {
  const path = join(lifecycle.overlayDirectory, `${user}.patch.yml`);
  const original = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(original);
  // generateManagedConfig writes compact JSON (a YAML subset); require an exact round trip.
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== original)
    throw new Error('Unexpected managed overlay format');
  const rows: unknown[] = parsed;
  const webserver = rows.filter((row) => record(row).id === 'webserver').map(record);
  const config = record(webserver[0]?.config);
  if (webserver.length !== 1 || config.host !== from || config.port !== 3080)
    throw new Error('Unexpected managed overlay webserver row');
  const rebound = rows.map((row) =>
    record(row).id === 'webserver' ? { ...record(row), config: { ...config, host: to } } : row,
  );
  const inode = statSync(path).ino;
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(rebound));
  chmodSync(path, 0o444);
  expect(statSync(path).ino).toBe(inode);
  const restarted = lifecycle.command(['restart', containerId], 30_000);
  if (restarted.status !== 0 || restarted.error !== undefined)
    throw new Error('Survivor restart failed');
}

/**
 * Test-owned stage-1 survivor: the running container is re-attached through the raw Engine API
 * with only its alias (no `IPAMConfig` key), while a placeholder holds the freed layout address.
 * A real stage-1 survivor is a DSH 0.2.0 container bound to 0.0.0.0, reachable at any address;
 * DSH 0.2.1 binds only the overlay's literal (the +2 address), so nothing would listen at the
 * moved address. Emulate that reachability by rebinding the overlay to it and restarting, while
 * the placeholder still holds +2 so the restart cannot land back on the layout address.
 */
async function constructSurvivor(
  lifecycle: UserImageLifecycle,
  raw: RawDocker,
  user: string,
  containerId: string,
  platformId: string,
): Promise<string> {
  const networkId = String(ownedAttachment(lifecycle, containerId, user).NetworkID);
  const subnet = bridgeSubnet(lifecycle, networkId);
  await raw.json(
    'POST',
    `/networks/${networkId}/disconnect`,
    { Container: containerId, Force: false },
    AbortSignal.timeout(15_000),
  );
  const placeholder = `dsh-team-test-placeholder-${lifecycle.runId}`;
  lifecycle.registerResource('container', placeholder, { 'dsh-team.test-run': lifecycle.runId });
  const occupied = lifecycle.command(
    [
      'run',
      '--detach',
      '--name',
      placeholder,
      '--network',
      networkId,
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      lifecycle.imageId,
      'sleep',
      'infinity',
    ],
    30_000,
  );
  if (occupied.status !== 0 || occupied.error !== undefined)
    throw new Error('Placeholder startup failed');
  await raw.json(
    'POST',
    `/networks/${networkId}/connect`,
    { Container: containerId, EndpointConfig: { Aliases: [`u-${user}`] } },
    AbortSignal.timeout(15_000),
  );
  const moved = String(ownedAttachment(lifecycle, containerId, user).IPAddress);
  rebindSurvivorWeb(lifecycle, user, containerId, instanceAddressLayout(subnet).container, moved);
  const removed = lifecycle.command(['container', 'rm', '--force', placeholder], 15_000);
  expect(removed.status).toBe(0);
  expect(removed.error).toBeUndefined();
  const document = inspect(lifecycle, containerId);
  const networks = record(record(document.NetworkSettings).Networks);
  const endpoint = record(networks[`dsh-team-net-${user}`]);
  if (endpoint.IPAddress === instanceAddressLayout(subnet).container)
    throw new Error('Survivor construction landed on the layout address');
  if (endpoint.IPAddress !== moved) throw new Error('Survivor address moved across the restart');
  expect(Object.keys(networks)).toEqual([`dsh-team-net-${user}`]);
  expect(endpoint.NetworkID).toBe(networkId);
  expect(endpoint.NetworkID).toBe(record(document.HostConfig).NetworkMode);
  expect(endpoint.Aliases).toContain(`u-${user}`);
  expect(endpoint.IPAMConfig).toBeNull();
  expect(inInstanceRange(endpoint.IPAddress, subnet)).toBe(true);
  expect(Object.keys(record(inspectNetwork(lifecycle, networkId).Containers)).sort()).toEqual(
    [containerId, platformId].sort(),
  );
  return moved;
}

/** Reconciliation re-attached the recreated platform without requesting an address. */
function expectSurvivorRestored(
  lifecycle: UserImageLifecycle,
  survivor: { user: string; id: string; address: string; cookie: string },
  platformId: string,
  authority: string,
): number {
  const document = inspect(lifecycle, survivor.id);
  expect(document.Id).toBe(survivor.id);
  expect(record(document.State).Running).toBe(true);
  const endpoint = ownedAttachment(lifecycle, survivor.id, survivor.user);
  expect(endpoint.IPAddress).toBe(survivor.address);
  const networkId = String(endpoint.NetworkID);
  const subnet = bridgeSubnet(lifecycle, networkId);
  const bridge = inspectNetwork(lifecycle, networkId);
  expect(Object.keys(record(bridge.Containers)).sort()).toEqual([survivor.id, platformId].sort());
  const attachment = ownedAttachment(lifecycle, platformId, survivor.user);
  expect(attachment.NetworkID).toBe(networkId);
  // The only Docker-observable evidence that connect carried no `EndpointConfig.IPAMConfig`.
  expect(attachment.IPAMConfig).toBeNull();
  expect(inInstanceRange(attachment.IPAddress, subnet)).toBe(true);
  expect(attachment.IPAddress).not.toBe(survivor.address);
  expect(record(record(bridge.Containers)[platformId]).IPv4Address).toBe(
    `${String(attachment.IPAddress)}/28`,
  );
  expect(platformHttpStatus(lifecycle, platformId, survivor.address, authority)).toBe(401);
  return platformHttpStatus(lifecycle, platformId, survivor.address, authority, survivor.cookie);
}

function expectRetired(
  lifecycle: UserImageLifecycle,
  user: string,
  containerId: string,
  networkId: string,
): void {
  for (const [kind, id] of [
    ['container', containerId],
    ['network', networkId],
  ] as const)
    expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(true);
  for (const kind of ['home', 'work'])
    expect(
      lifecycle.command(['volume', 'inspect', `dsh-team-${kind}-${user}`], 15_000).status,
    ).toBe(0);
}

/** Admin stop through the reconstructed owner, then a fresh start lands on the layout. */
async function stopThenRestartAtLayout(
  lifecycle: UserImageLifecycle,
  owner: ReturnType<typeof createOrchestrator>,
  database: DatabaseHandle,
  survivor: { user: string; id: string },
  platformId: string,
  authority: string,
): Promise<boolean> {
  const survivorNetwork = String(ownedAttachment(lifecycle, survivor.id, survivor.user).NetworkID);
  await owner.stopUserContainer({ userId: survivor.user, reason: 'admin' });
  expectRetired(lifecycle, survivor.user, survivor.id, survivorNetwork);
  expect(
    database.prepare('SELECT event_type, target, details FROM audit_events ORDER BY id').all(),
  ).toEqual([
    { event_type: 'instance.created', target: survivor.user, details: '{}' },
    { event_type: 'instance.started', target: survivor.user, details: '{}' },
    { event_type: 'instance.ready', target: survivor.user, details: '{}' },
    { event_type: 'instance.stopped', target: survivor.user, details: '{"reason":"admin"}' },
  ]);
  const restarted = await startDockerInstance(owner, lifecycle, survivor.user, authority);
  expect(restarted.containerId).not.toBe(survivor.id);
  const endpoint = ownedAttachment(lifecycle, restarted.containerId, survivor.user);
  const networkId = String(endpoint.NetworkID);
  const { container } = instanceAddressLayout(bridgeSubnet(lifecycle, networkId));
  expect(endpoint.IPAddress).toBe(container);
  expect(record(endpoint.IPAMConfig).IPv4Address).toBe(container);
  expectPlatformAtLayout(lifecycle, platformId, survivor.user, networkId);
  const marker = survivorMarker(
    lifecycle,
    restarted.containerId,
    "from pathlib import Path; print(Path('/data/work/survivor-marker').read_text())",
  );
  expect(marker).toBe(SURVIVOR_MARKER);
  await owner.stopUserContainer({ userId: survivor.user, reason: 'admin' });
  expectRetired(lifecycle, survivor.user, restarted.containerId, networkId);
  return marker === SURVIVOR_MARKER;
}

function rowCookie(database: DatabaseHandle, user: string): string {
  const row = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(user));
  if (typeof row.dsh_cookie !== 'string') throw new Error('Missing ready cookie');
  return row.dsh_cookie;
}

async function survivorScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const user = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const platformName = `dsh-team-test-survivor-${lifecycle.runId}`;
  const originalPlatform = String(createStandInPlatform(lifecycle, platformName).Id);
  const config = { upstreamMode: 'network' as const, platformContainerName: platformName };
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'survivor-platform.db'));
  const { raw, client } = startupClient(lifecycle);
  const owner = createOrchestrator({ client, database, config });
  const authority = 'survivor.example:8443';
  const input = {
    userId: user,
    config: {
      userImage: lifecycle.imageId,
      seccompProfilePath: lifecycle.seccomp,
      managedConfigDir: lifecycle.overlayDirectory,
      authority,
      subnetPool: '172.30.0.0/16',
    },
    modelSettings: START_MODEL,
    modelKey: 'docker-acceptance-only-not-a-model-credential',
  };
  try {
    applyMigrations(database);
    // (1) Every resource a failed run may leave is registered before production creates it.
    registerStartupUsers(lifecycle, database, [user], 'survivor.example');
    lifecycle.registerResource('network', `dsh-team-net-${user}`, { 'dsh-team.user': user });
    const started = await startDockerInstance(owner, lifecycle, user, authority);
    rowCookie(database, user);
    survivorMarker(
      lifecycle,
      started.containerId,
      `from pathlib import Path; Path('/data/work/survivor-marker').write_text('${SURVIVOR_MARKER}')`,
    );
    // (2) Stage-1 shape: undeclared endpoint off +2, row pointing at it.
    const address = await constructSurvivor(
      lifecycle,
      raw,
      user,
      started.containerId,
      originalPlatform,
    );
    database.prepare('UPDATE instances SET upstream_host = ? WHERE user_id = ?').run(address, user);
    // DSH 0.2.1 launch tokens are per process (dsh-client-connection lib/index.js:294-300, 420),
    // so the restarted Web process needs a fresh cookie: re-acquire through the owner's production
    // path against the moved address (it clears, then commits the row cookie; no audit events).
    await owner.acquireDshCookie({ userId: user, authority });
    const cookie = rowCookie(database, user);
    expect(platformHttpStatus(lifecycle, originalPlatform, address, authority, cookie)).toBe(200);
    // (3) Platform recreation, then a fresh owner reconciles twice.
    const before = await startupEvidence(database, input);
    expect(before.row).toMatchObject({
      status: 'running',
      container_id: started.containerId,
      upstream_host: address,
      dsh_cookie: cookie,
    });
    expect(before.audit.map((event) => record(event).event_type)).toEqual([
      'instance.created',
      'instance.started',
      'instance.ready',
    ]);
    expect(lifecycle.command(['container', 'rm', '--force', originalPlatform], 15_000).status).toBe(
      0,
    );
    const platformId = String(createStandInPlatform(lifecycle, platformName).Id);
    expect(platformId).not.toBe(originalPlatform);
    const reconstructed = createOrchestrator({ client, database, config });
    await reconstructed.reconcile();
    await reconstructed.reconcile();
    expect(await startupEvidence(database, input)).toEqual(before);
    const survivor = { user, id: started.containerId, address, cookie };
    const authenticated = expectSurvivorRestored(lifecycle, survivor, platformId, authority);
    expect(authenticated).toBe(200);
    // (4) and (5) The original owner is pinned to the removed platform; only the reconstructed one works.
    const markerRetained = await stopThenRestartAtLayout(
      lifecycle,
      reconstructed,
      database,
      survivor,
      platformId,
      authority,
    );
    return JSON.stringify({
      survivorAddressOffLayout: true,
      reattachedUndeclared: true,
      authenticatedAfterRecreation: authenticated,
      auditsUnchanged: true,
      restartedAtLayout: true,
      markerRetained,
    });
  } finally {
    database.close();
  }
}

it('reconciles a stage-1 survivor off the layout address after platform recreation without requesting an address, then restarts it at the layout', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        survivorAddressOffLayout: true,
        reattachedUndeclared: true,
        authenticatedAfterRecreation: 200,
        auditsUnchanged: true,
        restartedAtLayout: true,
        markerRetained: true,
      });
    },
    undefined,
    survivorScenario,
  );
  process.stdout.write(
    `Docker survivor reconciliation verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});

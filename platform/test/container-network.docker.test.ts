import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createOrchestrator, instanceAddressLayout } from '../src/orchestrator/index.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  bridgeSubnet,
  cookieHttpStatus,
  createStandInPlatform,
  expectPlatformAtLayout,
  inspect,
  inspectNetwork,
  normalizeInspectMounts,
  record,
  startupClient,
  registerStartupUsers,
  startDockerInstance,
  runNetworkAcceptance,
} from './container-start-docker-fixture.ts';
import {
  bridgeEndpoints,
  containerNetworks,
  documentServerConfig,
  expectDocumentServerAtLayout,
  gatewayStatus,
  userNetworkId,
} from './container-document-server-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { listen, probe, probeScript } from './network-probe-fixture.ts';

function exec(
  lifecycle: UserImageLifecycle,
  id: string,
  script: string,
  hosts: string[] = [],
): unknown {
  const result = lifecycle.command(['exec', id, 'python3', '-c', script, ...hosts], 15_000);
  if (result.status !== 0 || result.error !== undefined) throw new Error('Isolation probe failed');
  const document: unknown = JSON.parse(result.stdout);
  return document;
}

function network(lifecycle: UserImageLifecycle, user: string, id: string) {
  const container = normalizeInspectMounts(inspect(lifecycle, id));
  const attachments = record(record(container.NetworkSettings).Networks);
  expect(Object.keys(attachments)).toEqual([`dsh-team-net-${user}`]);
  const endpoint = record(attachments[`dsh-team-net-${user}`]);
  const inspected = inspectNetwork(lifecycle, String(endpoint.NetworkID));
  expect(inspected).toMatchObject({
    Id: endpoint.NetworkID,
    Name: `dsh-team-net-${user}`,
    Driver: 'bridge',
    Internal: false,
    Labels: { 'dsh-team.user': user },
    EnableIPv6: false,
  });
  expect(Object.keys(record(inspected.Containers))).toEqual([id]);
  const ipam = record(inspected.IPAM).Config;
  if (!Array.isArray(ipam) || ipam.length !== 1) throw new Error('Expected one IPv4 subnet');
  const subnet = record(ipam[0]).Subnet;
  expect(subnet).toEqual(expect.stringMatching(/\/28$/));
  const layout = instanceAddressLayout(String(subnet)).container;
  expect(endpoint.IPAddress).toBe(layout);
  expect(record(endpoint.IPAMConfig).IPv4Address).toBe(layout);
  expect(record(record(inspected.Containers)[id]).IPv4Address).toBe(`${layout}/28`);
  expect(record(container.Config).User).toBe('1001');
  expect(endpoint.Aliases).toEqual(expect.arrayContaining([`u-${user}`]));
  return {
    id: String(endpoint.NetworkID),
    ip: String(endpoint.IPAddress),
    subnet,
    container,
    inspected,
  };
}

async function isolation(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.slice(0, 10)}zz`;
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'network-platform.db'));
  const { client } = startupClient(lifecycle);
  const owner = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const authority = 'isolation.example:8443';
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userA, userB], 'isolation.example');
    const start = async (userId: string) => {
      const result = await startDockerInstance(owner, lifecycle, userId, authority);
      const row = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId));
      expect(row.status).toBe('running');
      if (typeof row.dsh_cookie !== 'string') throw new Error('Ready instance missing cookie');
      expect(await cookieHttpStatus(result.upstreamPort, authority, row.dsh_cookie)).toBe(200);
      const owned = network(lifecycle, userId, result.containerId);
      const host = record(owned.container.HostConfig);
      expect(host.PublishAllPorts).not.toBe(true);
      expect(host.PortBindings).toEqual({ '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
      expect(record(owned.container.NetworkSettings).Ports).toEqual({
        '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(result.upstreamPort) }],
      });
      return { result, row, network: owned };
    };
    const a = await start(userA);
    const b = await start(userB);
    expect(a.network.id).not.toBe(b.network.id);
    expect(a.network.subnet).not.toBe(b.network.subnet);
    for (const instance of [a, b]) {
      expect(exec(lifecycle, instance.result.containerId, listen)).toEqual({
        uid: 1001,
        port: 3099,
      });
    }
    // Positive controls precede every negative: neither a closed port nor a failed probe proves isolation.
    // DSH 0.2.1 binds only the instance's +2 address, so the container's own loopback never reaches
    // 3080; 3099 proves loopback itself works.
    expect(
      exec(lifecycle, a.result.containerId, probe, ['127.0.0.1', a.network.ip, `u-${userA}`]),
    ).toEqual([false, true, true, true, true, true]);
    expect(
      exec(lifecycle, b.result.containerId, probe, ['127.0.0.1', b.network.ip, `u-${userB}`]),
    ).toEqual([false, true, true, true, true, true]);
    expect(exec(lifecycle, a.result.containerId, probe, [b.network.ip, `u-${userB}`])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(exec(lifecycle, b.result.containerId, probe, [a.network.ip, `u-${userA}`])).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const bBefore = network(lifecycle, userB, b.result.containerId);
    await owner.stopUserContainer({ userId: userA, reason: 'admin' });
    for (const [kind, id] of [
      ['container', a.result.containerId],
      ['network', a.network.id],
    ] as const)
      expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(
        true,
      );
    for (const kind of ['home', 'work']) {
      const result = lifecycle.command(['volume', 'inspect', `dsh-team-${kind}-${userA}`], 15_000);
      expect(result.status).toBe(0);
      const rows: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) throw new Error('Volume inspect unavailable');
      expect(record(rows[0]).Labels).toEqual({ 'dsh-team.user': userA });
    }
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB)).toEqual(b.row);
    expect(network(lifecycle, userB, b.result.containerId)).toEqual(bBefore);
    if (typeof b.row.dsh_cookie !== 'string') throw new Error('Ready B missing cookie');
    expect(await cookieHttpStatus(b.result.upstreamPort, authority, b.row.dsh_cookie)).toBe(200);
    await owner.stopUserContainer({ userId: userB, reason: 'admin' });
    expect(
      isAbsentResource(
        lifecycle.command(['network', 'inspect', b.network.id], 15_000),
        'network',
        b.network.id,
      ),
    ).toBe(true);
    return JSON.stringify({
      instances: 2,
      ports: [3080, 3099],
      isolatedBothWays: true,
      siblingPreserved: true,
      atLayout: true,
      loopbackOnly: true,
    });
  } finally {
    database.close();
  }
}

it('production-ready instances isolate both listening ports by address and hostname and retire independently', async () => {
  await runNetworkAcceptance(isolation, 'network isolation', (summary) => {
    expect(JSON.parse(summary)).toEqual({
      instances: 2,
      ports: [3080, 3099],
      isolatedBothWays: true,
      siblingPreserved: true,
      atLayout: true,
      loopbackOnly: true,
    });
  });
});

const BUNDLED_AUTHORITY = 'isolation.example:8443';
// Only 3080 and 3099 have positive controls; the rest cover the spec's common ports.
const SWEEP_PORTS = [3080, 3099, 22, 80, 443, 3000, 8080] as const;
const sweep = probeScript(SWEEP_PORTS);

interface BundledInstance {
  readonly user: string;
  readonly containerId: string;
  readonly networkId: string;
  readonly subnet: string;
  readonly layout: ReturnType<typeof instanceAddressLayout>;
  readonly documentServer: { endpointId: string; address: string };
}

/** Exactly the employee (+2), the platform stand-in (+3) and the Document Server stand-in (+4). */
function threeEndpoints(
  lifecycle: UserImageLifecycle,
  user: string,
  started: Awaited<ReturnType<typeof startDockerInstance>>,
  platformId: string,
  documentServerId: string,
): BundledInstance {
  const networkId = userNetworkId(lifecycle, started.containerId, user);
  const subnet = bridgeSubnet(lifecycle, user);
  const layout = instanceAddressLayout(subnet);
  expect(bridgeEndpoints(lifecycle, networkId)).toEqual(
    [started.containerId, platformId, documentServerId].sort(),
  );
  expect(started.upstreamHost).toBe(layout.container);
  const employee = record(
    record(inspectNetwork(lifecycle, networkId).Containers)[started.containerId],
  );
  expect(employee.IPv4Address).toBe(`${layout.container}/28`);
  expectPlatformAtLayout(lifecycle, platformId, user, networkId);
  const documentServer = expectDocumentServerAtLayout(lifecycle, documentServerId, user, networkId);
  return { user, containerId: started.containerId, networkId, subnet, layout, documentServer };
}

/** Every reachability the negatives rely on, proven first: a failed probe alone proves nothing. */
function positiveControls(
  lifecycle: UserImageLifecycle,
  database: DatabaseHandle,
  platformId: string,
  documentServerId: string,
  instances: readonly [BundledInstance, BundledInstance],
): void {
  for (const instance of instances)
    expect(gatewayStatus(lifecycle, database, platformId, instance.user, BUNDLED_AUTHORITY)).toBe(
      200,
    );
  for (const id of [
    ...instances.map((instance) => instance.containerId),
    platformId,
    documentServerId,
  ])
    expect(exec(lifecycle, id, listen)).toEqual({ uid: 1001, port: 3099 });
  // The Document Server is the shared peer: both networks carry its traffic to each +2.
  expect(
    exec(
      lifecycle,
      documentServerId,
      probe,
      instances.map((instance) => instance.layout.container),
    ),
  ).toEqual([true, true, true, true]);
  // The same stand-in listeners answer 3099 on the own network; nothing listens on their 3080.
  for (const { containerId, layout } of instances)
    expect(
      exec(lifecycle, containerId, probe, [
        layout.container,
        layout.platform,
        layout.documentServer,
      ]),
    ).toEqual([true, true, false, true, false, true]);
}

/** One exec per address: dropped connects each wait the full 1s, so 7 ports stay under 15s. */
function unreachable(lifecycle: UserImageLifecycle, from: BundledInstance, to: BundledInstance) {
  for (const address of [to.layout.container, to.layout.platform, to.layout.documentServer])
    expect(exec(lifecycle, from.containerId, sweep, [address])).toEqual(
      SWEEP_PORTS.map(() => false),
    );
}

function expectAbsent(lifecycle: UserImageLifecycle, kind: 'container' | 'network', id: string) {
  expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(true);
}

async function bundledIsolation(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.slice(0, 10)}zz`;
  const platformName = `dsh-team-test-isolation-platform-${lifecycle.runId}`;
  const documentServerName = `dsh-team-test-isolation-ds-${lifecycle.runId}`;
  const platformId = String(createStandInPlatform(lifecycle, platformName).Id);
  const documentServerId = String(createStandInPlatform(lifecycle, documentServerName).Id);
  const database = openDatabase(
    join(dirname(lifecycle.overlayDirectory), 'network-document-server.db'),
  );
  const { client } = startupClient(lifecycle);
  const owner = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'network', platformContainerName: platformName },
  });
  const configured = documentServerConfig(documentServerName);
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userA, userB], 'isolation.example');
    const startedA = await startDockerInstance(
      owner,
      lifecycle,
      userA,
      BUNDLED_AUTHORITY,
      configured,
    );
    const startedB = await startDockerInstance(
      owner,
      lifecycle,
      userB,
      BUNDLED_AUTHORITY,
      configured,
    );
    const a = threeEndpoints(lifecycle, userA, startedA, platformId, documentServerId);
    const b = threeEndpoints(lifecycle, userB, startedB, platformId, documentServerId);
    expect(a.networkId).not.toBe(b.networkId);
    expect(a.subnet).not.toBe(b.subnet);
    expect(containerNetworks(lifecycle, documentServerId)).toEqual(
      ['bridge', `dsh-team-net-${userA}`, `dsh-team-net-${userB}`].sort(),
    );
    positiveControls(lifecycle, database, platformId, documentServerId, [a, b]);
    // B reaches none of A's +2/+3/+4 (its +4 peer cannot be a next hop for uid1001), and vice versa.
    unreachable(lifecycle, b, a);
    unreachable(lifecycle, a, b);
    const siblingEndpoints = inspectNetwork(lifecycle, b.networkId).Containers;
    const siblingRow = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB);

    await owner.stopUserContainer({ userId: userA, reason: 'admin' });

    expectAbsent(lifecycle, 'container', a.containerId);
    expectAbsent(lifecycle, 'network', a.networkId);
    expect(containerNetworks(lifecycle, documentServerId)).toEqual([
      'bridge',
      `dsh-team-net-${userB}`,
    ]);
    expect(inspectNetwork(lifecycle, b.networkId).Containers).toEqual(siblingEndpoints);
    expect(bridgeEndpoints(lifecycle, b.networkId)).toEqual(
      [b.containerId, platformId, documentServerId].sort(),
    );
    expectPlatformAtLayout(lifecycle, platformId, userB, b.networkId);
    expect(expectDocumentServerAtLayout(lifecycle, documentServerId, userB, b.networkId)).toEqual(
      b.documentServer,
    );
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB)).toEqual(
      siblingRow,
    );
    expect(gatewayStatus(lifecycle, database, platformId, userB, BUNDLED_AUTHORITY)).toBe(200);
    await owner.stopUserContainer({ userId: userB, reason: 'admin' });
    expectAbsent(lifecycle, 'network', b.networkId);
    expect(containerNetworks(lifecycle, documentServerId)).toEqual(['bridge']);
    return JSON.stringify({
      instances: 2,
      endpointsPerNetwork: 3,
      ports: [...SWEEP_PORTS],
      isolatedBothWays: true,
      viaDocumentServer: false,
      siblingPreserved: true,
    });
  } finally {
    database.close();
  }
}

it('bundled Document Server joins both instance networks without bridging them', async () => {
  await runNetworkAcceptance(bundledIsolation, 'bundled Document Server isolation', (summary) => {
    expect(JSON.parse(summary)).toEqual({
      instances: 2,
      endpointsPerNetwork: 3,
      ports: [3080, 3099, 22, 80, 443, 3000, 8080],
      isolatedBothWays: true,
      viaDocumentServer: false,
      siblingPreserved: true,
    });
  });
});

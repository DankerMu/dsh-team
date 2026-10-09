import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  cookieHttpStatus,
  inspect,
  inspectNetwork,
  normalizeInspectMounts,
  record,
  startupClient,
  registerStartupUsers,
  startDockerInstance,
  runNetworkAcceptance,
} from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const listen = `
import json, os, socket, subprocess, sys, time
subprocess.Popen([sys.executable, '-m', 'http.server', '3099', '--bind', '0.0.0.0'],
                 cwd='/data/work', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, start_new_session=True)
deadline = time.monotonic() + 5
while True:
    try:
        with socket.create_connection(('127.0.0.1', 3099), timeout=.25): break
    except OSError:
        if time.monotonic() >= deadline: raise RuntimeError('Listener unavailable')
        time.sleep(.05)
print(json.dumps({'uid': os.geteuid(), 'port': 3099}))
`;
const probe = `
import json, socket, sys
results = []
for host in sys.argv[1:]:
    for port in (3080, 3099):
        try:
            with socket.create_connection((host, port), timeout=1): results.append(True)
        except OSError: results.append(False)
print(json.dumps(results))
`;

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
      return { result, row, network: network(lifecycle, userId, result.containerId) };
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
    expect(
      exec(lifecycle, a.result.containerId, probe, ['127.0.0.1', a.network.ip, `u-${userA}`]),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      exec(lifecycle, b.result.containerId, probe, ['127.0.0.1', b.network.ip, `u-${userB}`]),
    ).toEqual([true, true, true, true, true, true]);
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
    });
  });
});

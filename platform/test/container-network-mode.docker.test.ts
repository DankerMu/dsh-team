import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { loadConfig } from '../src/config.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  inspect,
  inspectNetwork,
  record,
  startupClient,
  registerStartupUsers,
  startDockerInstance,
  runNetworkAcceptance,
} from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

function fromPlatform(lifecycle: UserImageLifecycle, id: string, host: string, authority: string) {
  const script = `
import urllib.request, urllib.error, sys
request = urllib.request.Request('http://' + sys.argv[1] + ':3080/', headers={'Host': sys.argv[2]})
try:
    response = urllib.request.urlopen(request, timeout=5)
    print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
`;
  const result = lifecycle.command(['exec', id, 'python3', '-c', script, host, authority], 10_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Stand-in HTTP connection failed');
  expect(result.stdout.trim()).toBe('401');
}

async function networkMode(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.slice(0, 10)}zz`;
  const platformName = `dsh-team-test-platform-${lifecycle.runId}`;
  const labels = { 'dsh-team.test-run': lifecycle.runId };
  lifecycle.registerResource('container', platformName, labels);
  const created = lifecycle.command(
    [
      'run',
      '--detach',
      '--name',
      platformName,
      '--network',
      'bridge',
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      lifecycle.imageId,
      'sleep',
      'infinity',
    ],
    30_000,
  );
  if (created.status !== 0 || created.error !== undefined)
    throw new Error('Stand-in startup failed');
  const original = inspect(lifecycle, platformName);
  expect(original.Image).toBe(lifecycle.imageId);
  const platformId = String(original.Id);
  const primary = structuredClone(record(record(original.NetworkSettings).Networks));
  const database = openDatabase(
    join(dirname(lifecycle.overlayDirectory), 'network-mode-platform.db'),
  );
  const { client } = startupClient(lifecycle);
  const authority = 'network-mode.example:8443';
  // The unspecified mode exercises the deployment default, not a host-only publication shortcut.
  const config = loadConfig({
    PLATFORM_PUBLIC_URL: `http://${authority}`,
    PLATFORM_CONTAINER_NAME: platformName,
  });
  const owner = createOrchestrator({ client, database, config });
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userA, userB], 'network-mode.example');
    const start = async (userId: string) => {
      const started = await startDockerInstance(owner, lifecycle, userId, authority);
      const container = inspect(lifecycle, started.containerId);
      const host = record(container.HostConfig);
      expect(host.PublishAllPorts).not.toBe(true);
      expect(
        host.PortBindings === null || Object.keys(record(host.PortBindings)).length === 0,
      ).toBe(true);
      expect(
        Object.values(record(record(container.NetworkSettings).Ports)).every(
          (binding) => binding === null,
        ),
      ).toBe(true);
      const networks = record(record(container.NetworkSettings).Networks);
      expect(Object.keys(networks)).toEqual([`dsh-team-net-${userId}`]);
      const endpoint = record(networks[`dsh-team-net-${userId}`]);
      expect(started.upstreamHost).toBe(endpoint.IPAddress);
      expect(started.upstreamPort).toBe(3080);
      const networkId = String(endpoint.NetworkID);
      const network = inspectNetwork(lifecycle, networkId);
      expect(Object.keys(record(network.Containers)).sort()).toEqual(
        [started.containerId, platformId].sort(),
      );
      expect(record(record(network.Containers)[started.containerId])).toMatchObject({
        IPv4Address: `${started.upstreamHost}/28`,
        EndpointID: endpoint.EndpointID,
      });
      expect(
        record(
          record(record(inspect(lifecycle, platformId).NetworkSettings).Networks)[
            `dsh-team-net-${userId}`
          ],
        ).NetworkID,
      ).toBe(networkId);
      fromPlatform(lifecycle, platformId, started.upstreamHost, authority);
      return { started, networkId };
    };
    const a = await start(userA);
    const b = await start(userB);
    const sibling = inspectNetwork(lifecycle, b.networkId);
    const siblingRow = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB);
    const marker = lifecycle.command(
      [
        'exec',
        a.started.containerId,
        'python3',
        '-c',
        "from pathlib import Path; Path('/data/work/network-mode-marker').write_text('network-mode-data-retained')",
      ],
      10_000,
    );
    if (marker.status !== 0 || marker.error !== undefined)
      throw new Error('Data marker write failed');

    await owner.stopUserContainer({ userId: userA, reason: 'admin' });

    const after = record(record(inspect(lifecycle, platformId).NetworkSettings).Networks);
    expect(after).not.toHaveProperty(`dsh-team-net-${userA}`);
    for (const [name, endpoint] of Object.entries(primary)) expect(after[name]).toEqual(endpoint);
    expect(inspectNetwork(lifecycle, b.networkId)).toEqual(sibling);
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userB)).toEqual(
      siblingRow,
    );
    fromPlatform(lifecycle, platformId, b.started.upstreamHost, authority);
    for (const [kind, id] of [
      ['container', a.started.containerId],
      ['network', a.networkId],
    ] as const)
      expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(
        true,
      );
    for (const volume of ['home', 'work'])
      expect(
        lifecycle.command(['volume', 'inspect', `dsh-team-${volume}-${userA}`], 15_000).status,
      ).toBe(0);
    const reader = `dsh-team-test-network-data-${lifecycle.runId}`;
    lifecycle.registerResource('container', reader, labels);
    const data = lifecycle.command(
      [
        'run',
        '--name',
        reader,
        '--network',
        'none',
        '--label',
        `dsh-team.test-run=${lifecycle.runId}`,
        '--mount',
        `type=volume,source=dsh-team-work-${userA},target=/data/work`,
        lifecycle.imageId,
        'python3',
        '-c',
        "from pathlib import Path; print(Path('/data/work/network-mode-marker').read_text())",
      ],
      30_000,
    );
    if (data.status !== 0 || data.error !== undefined)
      throw new Error('Retained volume read failed');
    expect(data.stdout.trim()).toBe('network-mode-data-retained');
    await owner.stopUserContainer({ userId: userB, reason: 'admin' });
    expect(record(record(inspect(lifecycle, platformId).NetworkSettings).Networks)).toEqual(
      primary,
    );
    expect(
      isAbsentResource(
        lifecycle.command(['network', 'inspect', b.networkId], 15_000),
        'network',
        b.networkId,
      ),
    ).toBe(true);
    return JSON.stringify({
      instances: 2,
      platformHttpStatus: 401,
      hostPublications: 0,
      siblingPreserved: true,
      dataRetained: true,
    });
  } finally {
    database.close();
  }
}

it('the deployment-default platform stand-in reaches unpublished instances and retirement preserves sibling networks and data', async () => {
  await runNetworkAcceptance(networkMode, 'network transport', (summary) => {
    expect(JSON.parse(summary)).toEqual({
      instances: 2,
      platformHttpStatus: 401,
      hostPublications: 0,
      siblingPreserved: true,
      dataRetained: true,
    });
  });
});

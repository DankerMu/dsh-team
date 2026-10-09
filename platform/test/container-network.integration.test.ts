import { expect, it } from 'vitest';
import {
  CREATED_AND_STARTED,
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';

it('public start directly owns its sole bridge endpoint over real Unix Docker and SQLite', async () => {
  const fixture = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-network-wire-',
    users: { [START_USER]: 'employee@example.test' },
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/26',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const { database, daemon, owner, input } = fixture;
  try {
    const result = await owner.startUserContainer(input);

    expect(result).toEqual({
      outcome: 'starting',
      containerId: START_CONTAINER,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
    // This observes the external Engine's actual attachment, not a mocked collaborator or request echo.
    const container = daemon.containers.get(START_CONTAINER);
    expect(Object.keys(container?.NetworkSettings.Networks ?? {})).toEqual([
      `dsh-team-net-${START_USER}`,
    ]);
    expect(container?.NetworkSettings.Networks).toEqual({
      [`dsh-team-net-${START_USER}`]: {
        NetworkID: START_NETWORK,
        EndpointID: START_CONTAINER,
        IPAddress: '172.30.0.2',
        Aliases: [`u-${START_USER}`],
      },
    });
    expect(daemon.networks.get(START_NETWORK)).toEqual({
      Id: START_NETWORK,
      Name: `dsh-team-net-${START_USER}`,
      Driver: 'bridge',
      Internal: false,
      EnableIPv6: false,
      Labels: { 'dsh-team.user': START_USER },
      IPAM: { Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] },
      Containers: {
        [START_CONTAINER]: {
          Name: `dsh-team-u-${START_USER}`,
          IPv4Address: '172.30.0.2/28',
          EndpointID: START_CONTAINER,
        },
      },
    });
    const created = daemon.requests.find(
      ({ path }) => path === `/containers/create?name=dsh-team-u-${START_USER}`,
    );
    expect(created?.body).toMatchObject({
      Hostname: `u-${START_USER}`,
      HostConfig: { NetworkMode: START_NETWORK },
      NetworkingConfig: {
        EndpointsConfig: { [START_NETWORK]: { Aliases: [`u-${START_USER}`] } },
      },
    });
    const helpers = daemon.requests.filter(({ path }) =>
      path.startsWith('/containers/create?name=dsh-team-compose-'),
    );
    for (const helper of helpers)
      expect(helper.body).toMatchObject({ HostConfig: { NetworkMode: 'none' } });
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toMatchObject({
      status: 'starting',
      container_id: START_CONTAINER,
      upstream_host: '127.0.0.1',
      upstream_port: 49173,
    });
    expect(
      database
        .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
        .all(),
    ).toEqual(CREATED_AND_STARTED);
  } finally {
    await fixture.close();
  }
});

function hostPublications(ports: unknown): unknown {
  if (typeof ports !== 'object' || ports === null || Array.isArray(ports)) return ports;
  return Object.values(ports).filter((binding) => binding !== null);
}

it('network transport gives the public owner an unpublished verified IPv4 upstream and attaches the configured platform', async () => {
  const transport: { upstreamMode: 'network'; platformContainerName: string } = {
    upstreamMode: 'network',
    platformContainerName: 'dsh-team-test-platform-network',
  };
  const fixture = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-network-mode-wire-',
    users: { [START_USER]: 'employee@example.test' },
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/26',
    transport,
  });
  const { database, daemon, owner, input } = fixture;
  const platformId = 'f'.repeat(64);
  const primaryNetwork = structuredClone(
    seedPlatform(daemon, transport.platformContainerName, platformId),
  );
  try {
    const result = await owner.startUserContainer(input);

    const container = daemon.containers.get(START_CONTAINER);
    expect(container?.State.Running).toBe(true);
    expect.soft(hostPublications(container?.NetworkSettings.Ports)).toEqual([]);
    expect.soft(container?.HostConfig?.PortBindings ?? {}).toEqual({});
    expect.soft(container?.HostConfig?.PublishAllPorts).not.toBe(true);
    expect.soft(result).toEqual({
      outcome: 'starting',
      containerId: START_CONTAINER,
      upstreamHost: '172.30.0.2',
      upstreamPort: 3080,
    });
    const expectedEndpoint: unknown = expect.objectContaining({
      NetworkID: START_NETWORK,
      IPAddress: '172.30.0.2',
      Aliases: [`u-${START_USER}`],
    });
    expect.soft(container?.NetworkSettings.Networks).toEqual({
      [`dsh-team-net-${START_USER}`]: expectedEndpoint,
    });
    const endpoints = daemon.networks.get(START_NETWORK)?.Containers;
    expect.soft(Object.keys(endpoints ?? {}).sort()).toEqual([START_CONTAINER, platformId]);
    expect.soft(endpoints?.[START_CONTAINER]).toMatchObject({
      IPv4Address: '172.30.0.2/28',
      EndpointID: START_CONTAINER,
    });
    expect.soft(endpoints?.[platformId]).toMatchObject({
      Name: transport.platformContainerName,
    });
    expect.soft(daemon.containers.get(platformId)?.NetworkSettings.Networks).toMatchObject({
      [`dsh-team-net-${START_USER}`]: { NetworkID: START_NETWORK },
      bridge: { NetworkID: '0'.repeat(64), IPAddress: '172.17.0.2' },
    });
    expect(daemon.networks.get('0'.repeat(64))).toEqual(primaryNetwork);
    expect
      .soft(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER))
      .toMatchObject({
        status: 'starting',
        container_id: START_CONTAINER,
        upstream_host: '172.30.0.2',
        upstream_port: 3080,
      });
    expect(
      database
        .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
        .all(),
    ).toEqual(CREATED_AND_STARTED);
  } finally {
    await fixture.close();
  }
});

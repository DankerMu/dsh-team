import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import {
  CREATED_AND_STARTED,
  START_CONTAINER,
  START_MODEL,
  START_NETWORK,
  START_PERMISSION,
  START_USER,
  startupDaemon,
  startupUnixServer,
} from './container-start-fixture.ts';

it('public start directly owns its sole bridge endpoint over real Unix Docker and SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-network-wire-'));
  const database = openDatabase(join(root, 'platform.db'));
  const daemon = startupDaemon();
  const server = startupUnixServer(
    (request) => daemon.reply(request),
    () => undefined,
  );
  try {
    applyMigrations(database);
    database
      .prepare(
        "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
      )
      .run(START_USER);
    const seccompProfilePath = join(root, 'seccomp.json');
    await writeFile(seccompProfilePath, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
    const socket = join(root, 'engine.sock');
    server.listen(socket);
    await once(server, 'listening');
    const owner = createOrchestrator({ client: createDockerClient(socket), database });
    const config = {
      userImage: 'dsh-team-user:local',
      seccompProfilePath,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
      subnetPool: '172.30.0.0/26',
    };

    const result = await owner.startUserContainer({
      userId: START_USER,
      config,
      modelSettings: START_MODEL,
      modelKey: 'fixture-private-key',
      permission: START_PERMISSION,
    });

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
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

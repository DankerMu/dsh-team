import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import {
  START_CONTAINER,
  START_MODEL,
  START_NETWORK,
  START_PERMISSION,
  START_USER,
  startupDaemon,
  startupUnixServer,
} from './container-start-fixture.ts';

const OTHER = 'mnopqrstuvwx';
const OTHER_CONTAINER = 'd'.repeat(64);

async function unixFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-allocation-wire-'));
  const database = openDatabase(join(root, 'platform.db'));
  applyMigrations(database);
  for (const user of [START_USER, OTHER])
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(user, `${user}@example.test`);
  const daemon = startupDaemon();
  daemon.beforeRequest(({ path }) => {
    if (path === `/containers/create?name=dsh-team-u-${OTHER}`)
      daemon.setContainerId(OTHER_CONTAINER);
    if (path === `/containers/create?name=dsh-team-u-${START_USER}`)
      daemon.setContainerId(START_CONTAINER);
  });
  let barrier: ((method: string, path: string) => Promise<undefined> | undefined) | undefined;
  const server = startupUnixServer(
    (request) => daemon.reply(request),
    (method, path) => barrier?.(method, path),
  );
  const socket = join(root, 'engine.sock');
  server.listen(socket);
  await once(server, 'listening');
  const seccompProfilePath = join(root, 'seccomp.json');
  await writeFile(seccompProfilePath, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
  const owner = createOrchestrator({ client: createDockerClient(socket), database });
  const input = {
    userId: START_USER,
    config: {
      userImage: 'image:test',
      seccompProfilePath,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
      subnetPool: '172.30.0.0/26',
    },
    modelSettings: START_MODEL,
    modelKey: 'fixture-private-key',
    permission: START_PERMISSION,
  };
  return {
    root,
    database,
    daemon,
    owner,
    input,
    hold(callback: typeof barrier) {
      barrier = callback;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('fresh all-network allocation serializes creation but releases before an unrelated container start settles', async () => {
  const fixture = await unixFixture();
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  fixture.hold((method, path) => {
    if (method === 'POST' && path === `/containers/${START_CONTAINER}/start`) {
      reached.resolve(undefined);
      return release.promise;
    }
    return undefined;
  });
  const a = fixture.owner.startUserContainer(fixture.input);
  const settlement = Promise.allSettled([a]);
  try {
    await reached.promise;

    const b = await fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER });

    expect(b).toMatchObject({ outcome: 'starting', containerId: OTHER_CONTAINER });
    expect(fixture.daemon.networks.get(START_NETWORK)?.IPAM).toEqual({
      Driver: 'default',
      Config: [{ Subnet: '172.30.0.0/28' }],
    });
    const other = [...fixture.daemon.networks.values()].find(
      (network) => network.Name === `dsh-team-net-${OTHER}`,
    );
    expect(other?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.16/28' }] });
    expect(
      fixture.database.prepare('SELECT user_id, status FROM instances ORDER BY user_id').all(),
    ).toEqual([
      { user_id: START_USER, status: 'starting' },
      { user_id: OTHER, status: 'starting' },
    ]);
  } finally {
    release.resolve(undefined);
    await settlement;
    await fixture.close();
  }
});

it('canceled network validation settles its independent rollback before the queued selector reuses the released subnet', async () => {
  const fixture = await unixFixture();
  const validating = Promise.withResolvers<undefined>();
  const validateRelease = Promise.withResolvers<undefined>();
  const deleting = Promise.withResolvers<undefined>();
  const deleteRelease = Promise.withResolvers<undefined>();
  const bWaiting = Promise.withResolvers<undefined>();
  let held = false;
  fixture.hold((method, path) => {
    if (method === 'GET' && path === `/networks/${START_NETWORK}` && !held) {
      held = true;
      validating.resolve(undefined);
      return validateRelease.promise;
    }
    if (method === 'DELETE' && path === `/networks/${START_NETWORK}`) {
      deleting.resolve(undefined);
      return deleteRelease.promise;
    }
    return undefined;
  });
  // External Engine request observation, never an application collaborator mock.
  fixture.daemon.beforeRequest(({ path }) => {
    if (path === `/containers/create?name=dsh-team-u-${OTHER}`)
      fixture.daemon.setContainerId(OTHER_CONTAINER);
    if (path === '/networks/dsh-team-net-mnopqrstuvwx') bWaiting.resolve(undefined);
  });
  const cancellation = new AbortController();
  const a = fixture.owner.startUserContainer({ ...fixture.input, signal: cancellation.signal });
  const aSettled = Promise.allSettled([a]);
  let b: Promise<unknown> | undefined;
  let bSettled: Promise<unknown> | undefined;
  try {
    await validating.promise;
    cancellation.abort();
    await deleting.promise;
    b = fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER });
    bSettled = Promise.allSettled([b]);
    // A's independent cleanup is still held. No successor network create can occur yet.
    expect(fixture.daemon.networks.get(START_NETWORK)?.Containers).toEqual({});
    expect(fixture.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    deleteRelease.resolve(undefined);
    await aSettled;
    await bWaiting.promise;
    expect(await b).toMatchObject({ outcome: 'starting', containerId: OTHER_CONTAINER });
    const other = [...fixture.daemon.networks.values()].find(
      (network) => network.Name === `dsh-team-net-${OTHER}`,
    );
    expect(other?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] });
    expect(await aSettled).toMatchObject([{ status: 'rejected' }]);
    expect(fixture.database.prepare('SELECT user_id FROM instances').all()).toEqual([
      { user_id: OTHER },
    ]);
  } finally {
    deleteRelease.resolve(undefined);
    validateRelease.resolve(undefined);
    await aSettled;
    await bSettled;
    await fixture.close();
  }
});

it('full and unconfigured Unix starts leave network inventory, database change count and overlay directories untouched', async () => {
  const fixture = await unixFixture();
  try {
    writeSettings(fixture.database, { maxRunningInstances: 1 });
    await fixture.owner.startUserContainer(fixture.input);
    const before = {
      requests: structuredClone(fixture.daemon.requests),
      networks: structuredClone([...fixture.daemon.networks]),
      rows: fixture.database.prepare('SELECT * FROM instances').all(),
      changes: fixture.database.prepare('SELECT total_changes() AS count').get(),
    };

    expect(await fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER })).toEqual({
      outcome: 'full',
    });
    expect(
      await fixture.owner.startUserContainer({
        ...fixture.input,
        userId: OTHER,
        modelKey: undefined,
      }),
    ).toEqual({ outcome: 'unconfigured' });

    expect({
      requests: fixture.daemon.requests,
      networks: [...fixture.daemon.networks],
      rows: fixture.database.prepare('SELECT * FROM instances').all(),
      changes: fixture.database.prepare('SELECT total_changes() AS count').get(),
    }).toEqual(before);
    await expect(
      stat(join(fixture.input.config.managedConfigDir, `${OTHER}.patch.yml`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
});

it.each(['daemon-delete', 'database-audit'] as const)(
  'Unix retirement %s failure preserves the indexed identity and never emits stopped',
  async (kind) => {
    const fixture = await unixFixture();
    try {
      await fixture.owner.startUserContainer(fixture.input);
      const before = fixture.database.prepare('SELECT * FROM instances').get();
      if (kind === 'daemon-delete')
        fixture.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });
      else
        fixture.database.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON audit_events
          WHEN NEW.event_type = 'instance.stopped' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);

      await expect(
        fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' }),
      ).rejects.toThrow('retirement failed');

      expect(fixture.database.prepare('SELECT * FROM instances').get()).toEqual(before);
      expect(
        fixture.database
          .prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'")
          .all(),
      ).toEqual([]);
      expect(fixture.daemon.networks.has(START_NETWORK)).toBe(kind === 'daemon-delete');
      expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it('Unix network deletion cannot atomically stop a newer database identity', async () => {
  const fixture = await unixFixture();
  const deleting = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  fixture.hold((method, path) => {
    if (method === 'DELETE' && path === `/networks/${START_NETWORK}`) {
      deleting.resolve(undefined);
      return release.promise;
    }
    return undefined;
  });
  let retirement: Promise<void> | undefined;
  let settlement: Promise<unknown> | undefined;
  try {
    await fixture.owner.startUserContainer(fixture.input);
    retirement = fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    settlement = Promise.allSettled([retirement]);
    await deleting.promise;
    fixture.database
      .prepare('UPDATE instances SET container_id = ?, last_started_at = 2')
      .run(OTHER_CONTAINER);
    const replacement = fixture.database.prepare('SELECT * FROM instances').get();

    release.resolve(undefined);
    await expect(retirement).rejects.toThrow('retirement failed');

    expect(fixture.database.prepare('SELECT * FROM instances').get()).toEqual(replacement);
    expect(
      fixture.database
        .prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'")
        .all(),
    ).toEqual([]);
  } finally {
    release.resolve(undefined);
    await settlement;
    await fixture.close();
  }
});

it('overlapping Unix starts select distinct fresh subnets while another user completes offline composition', async () => {
  const fixture = await unixFixture();
  const creating = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const composed = Promise.withResolvers<undefined>();
  let creations = 0;
  let helperDeletes = 0;
  fixture.hold((method, path) => {
    if (method === 'POST' && path === '/networks/create' && creations++ === 0) {
      creating.resolve(undefined);
      return release.promise;
    }
    return undefined;
  });
  fixture.daemon.beforeRequest(({ method, path }) => {
    if (path === `/containers/create?name=dsh-team-u-${OTHER}`)
      fixture.daemon.setContainerId(OTHER_CONTAINER);
    if (path === `/containers/create?name=dsh-team-u-${START_USER}`)
      fixture.daemon.setContainerId(START_CONTAINER);
    if (method === 'DELETE' && path.includes('/containers/') && ++helperDeletes === 2)
      composed.resolve(undefined);
  });
  const a = fixture.owner.startUserContainer(fixture.input);
  const aSettlement = Promise.allSettled([a]);
  let b: Promise<unknown> | undefined;
  let bSettlement: Promise<unknown> | undefined;
  try {
    await creating.promise;
    b = fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER });
    bSettlement = Promise.allSettled([b]);
    await composed.promise;
    expect(creations).toBe(1);
    expect(fixture.daemon.networks.has(START_NETWORK)).toBe(false);

    release.resolve(undefined);
    expect(await a).toMatchObject({ outcome: 'starting', containerId: START_CONTAINER });
    expect(await b).toMatchObject({ outcome: 'starting', containerId: OTHER_CONTAINER });

    const owned = [...fixture.daemon.networks.values()].filter(({ Name }) =>
      Name.startsWith('dsh-team-net-'),
    );
    expect(owned.map(({ IPAM }) => IPAM)).toEqual([
      { Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] },
      { Driver: 'default', Config: [{ Subnet: '172.30.0.16/28' }] },
    ]);
  } finally {
    release.resolve(undefined);
    await aSettlement;
    await bSettlement;
    await fixture.close();
  }
});

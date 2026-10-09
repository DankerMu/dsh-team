import { once } from 'node:events';
import { mkdtemp, rm, stat, watch, writeFile } from 'node:fs/promises';
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
import type { StartupRequest } from './container-start-fixture.ts';

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
  let responseBarrier: ((request: StartupRequest) => Promise<undefined> | undefined) | undefined;
  let loseNetworkIdentity = false;
  const server = startupUnixServer(
    (request) => {
      const result = daemon.reply(request);
      if (
        loseNetworkIdentity &&
        request.method === 'POST' &&
        request.path === '/networks/create' &&
        result.status === 201 &&
        request.body.Name === `dsh-team-net-${START_USER}`
      ) {
        loseNetworkIdentity = false;
        // Preserve the real Engine mutation but lose its identity on the Unix HTTP response.
        return { ...result, document: { Warning: '' } };
      }
      return result;
    },
    (method, path) => barrier?.(method, path),
    (request) => responseBarrier?.(request),
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
    holdResponse(callback: typeof responseBarrier) {
      responseBarrier = callback;
    },
    loseNextNetworkIdentity() {
      loseNetworkIdentity = true;
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

it.each(['fd00::/129', 'invalid:colon/28'])(
  'public Unix allocation rejects malformed foreign CIDR %s before creating a bridge',
  async (subnet) => {
    const fixture = await unixFixture();
    try {
      fixture.daemon.overrides.set('GET /networks', {
        status: 200,
        document: [
          ...fixture.daemon.networks.values(),
          {
            Id: 'f'.repeat(64),
            Name: 'foreign-ipv6-looking',
            Driver: 'bridge',
            Internal: false,
            EnableIPv6: true,
            Labels: {},
            IPAM: { Config: [{ Subnet: subnet }] },
            Containers: {},
          },
        ],
      });
      const before = structuredClone([...fixture.daemon.networks]);

      await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toThrow(
        'network allocation',
      );

      expect([...fixture.daemon.networks]).toEqual(before);
      expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(fixture.database.prepare('SELECT * FROM instances').all()).toEqual([]);
      expect(fixture.database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
      expect(fixture.daemon.requests.some(({ path }) => path === '/networks/create')).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it('public Unix allocation retains valid IPv6 inventory while selecting the first free IPv4 subnet', async () => {
  const fixture = await unixFixture();
  try {
    fixture.daemon.overrides.set('GET /networks', {
      status: 200,
      document: [
        ...fixture.daemon.networks.values(),
        {
          Id: 'f'.repeat(64),
          Name: 'foreign-ipv6',
          Driver: 'bridge',
          Internal: false,
          EnableIPv6: true,
          Labels: {},
          IPAM: { Config: [{ Subnet: 'fd00::/64' }] },
          Containers: {},
        },
      ],
    });

    expect(await fixture.owner.startUserContainer(fixture.input)).toMatchObject({
      outcome: 'starting',
      containerId: START_CONTAINER,
    });

    expect(fixture.daemon.networks.get(START_NETWORK)?.IPAM).toEqual({
      Driver: 'default',
      Config: [{ Subnet: '172.30.0.0/28' }],
    });
  } finally {
    await fixture.close();
  }
});

async function observeOverlay(
  directory: string,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of watch(directory, { signal })) {
    if (event.filename === `${userId}.patch.yml`) {
      await stat(join(directory, event.filename));
      return;
    }
  }
  throw new Error('Overlay observer closed without an owned committed file');
}

it.each(['before mutation', 'after mutation before response'] as const)(
  'canceling an accepted create %s retains allocation ownership until response and empty compensation settle',
  async (phase) => {
    const fixture = await unixFixture();
    const accepted = Promise.withResolvers<undefined>();
    const createRelease = Promise.withResolvers<undefined>();
    const mutationObserved = Promise.withResolvers<undefined>();
    const compensating = Promise.withResolvers<undefined>();
    const compensationRelease = Promise.withResolvers<undefined>();
    const observer = new AbortController();
    const earlyAllocations: { method: string; path: string }[] = [];
    let createHeld = false;
    let compensationSettled = false;
    let bLaunched = false;
    let aFinished = false;
    let bFinished = false;
    let compensatedEmpty = false;
    fixture.hold((method, path) => {
      if (
        phase === 'before mutation' &&
        method === 'POST' &&
        path === '/networks/create' &&
        !createHeld
      ) {
        createHeld = true;
        accepted.resolve(undefined);
        return createRelease.promise;
      }
      return undefined;
    });
    fixture.holdResponse((request) => {
      if (
        request.method === 'POST' &&
        request.path === '/networks/create' &&
        request.body.Name === `dsh-team-net-${START_USER}`
      ) {
        mutationObserved.resolve(undefined);
        if (phase === 'after mutation before response' && !createHeld) {
          createHeld = true;
          accepted.resolve(undefined);
          return createRelease.promise;
        }
      }
      if (request.method === 'DELETE' && request.path === `/networks/${START_NETWORK}`) {
        compensating.resolve(undefined);
        return compensationRelease.promise;
      }
      return undefined;
    });
    fixture.daemon.beforeRequest(({ method, path, body }) => {
      if (path === `/containers/create?name=dsh-team-u-${START_USER}`)
        fixture.daemon.setContainerId(START_CONTAINER);
      if (path === `/containers/create?name=dsh-team-u-${OTHER}`)
        fixture.daemon.setContainerId(OTHER_CONTAINER);
      if (method === 'DELETE' && path === `/networks/${START_NETWORK}`) {
        const network = fixture.daemon.networks.get(START_NETWORK);
        compensatedEmpty = network !== undefined && Object.keys(network.Containers).length === 0;
      }
      if (
        bLaunched &&
        !compensationSettled &&
        (path === `/networks/dsh-team-net-${OTHER}` ||
          (method === 'GET' && path === '/networks') ||
          (method === 'POST' &&
            path === '/networks/create' &&
            body.Name === `dsh-team-net-${OTHER}`))
      )
        earlyAllocations.push({ method, path });
    });
    const cancellation = new AbortController();
    const a = fixture.owner.startUserContainer({ ...fixture.input, signal: cancellation.signal });
    const aSettlement = Promise.allSettled([a]).then((results) => {
      aFinished = true;
      return results;
    });
    let b: Promise<unknown> | undefined;
    let bSettlement: Promise<unknown> | undefined;
    let overlaySettlement: Promise<unknown> | undefined;
    try {
      await accepted.promise;
      // B must reach a genuine filesystem output checkpoint before checking that allocation is held.
      // The observation deadline only bounds a broken fixture; it is not an ordering assertion.
      const overlay = observeOverlay(
        fixture.input.config.managedConfigDir,
        OTHER,
        AbortSignal.any([observer.signal, AbortSignal.timeout(8_000)]),
      );
      overlaySettlement = Promise.allSettled([overlay]);
      cancellation.abort();
      bLaunched = true;
      b = fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER });
      bSettlement = Promise.allSettled([b]).then((results) => {
        bFinished = true;
        return results;
      });
      await overlay;

      expect(aFinished).toBe(false);
      expect(bFinished).toBe(false);
      expect(earlyAllocations).toEqual([]);
      createRelease.resolve(undefined);
      await mutationObserved.promise;
      await compensating.promise;

      expect(compensatedEmpty).toBe(true);
      expect(fixture.daemon.networks.has(START_NETWORK)).toBe(false);
      expect(aFinished).toBe(false);
      expect(bFinished).toBe(false);
      expect(earlyAllocations).toEqual([]);
      expect(fixture.database.prepare('SELECT * FROM instances').all()).toEqual([]);
      compensationSettled = true;
      compensationRelease.resolve(undefined);
      expect(await aSettlement).toMatchObject([{ status: 'rejected' }]);
      expect(await b).toMatchObject({ outcome: 'starting', containerId: OTHER_CONTAINER });

      expect(fixture.daemon.networks.has(START_NETWORK)).toBe(false);
      expect(
        [...fixture.daemon.networks.values()].some(
          ({ Name }) => Name === `dsh-team-net-${START_USER}`,
        ),
      ).toBe(false);
      const other = [...fixture.daemon.networks.values()].find(
        ({ Name }) => Name === `dsh-team-net-${OTHER}`,
      );
      expect(other?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] });
      expect(fixture.database.prepare('SELECT user_id FROM instances').all()).toEqual([
        { user_id: OTHER },
      ]);
      expect(await fixture.owner.startUserContainer(fixture.input)).toMatchObject({
        outcome: 'starting',
        containerId: START_CONTAINER,
      });
      const retried = [...fixture.daemon.networks.values()].find(
        ({ Name }) => Name === `dsh-team-net-${START_USER}`,
      );
      expect(retried?.Id).not.toBe(START_NETWORK);
      expect(retried?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.16/28' }] });
    } finally {
      createRelease.resolve(undefined);
      compensationRelease.resolve(undefined);
      observer.abort();
      await overlaySettlement;
      await mutationObserved.promise;
      await aSettlement;
      await bSettlement;
      await fixture.close();
    }
  },
);

async function uncertainReplacementFixture() {
  const fixture = await unixFixture();
  try {
    expect(await fixture.owner.startUserContainer(fixture.input)).toMatchObject({
      outcome: 'starting',
      containerId: START_CONTAINER,
    });
    const oldRow = fixture.database
      .prepare('SELECT * FROM instances WHERE user_id = ?')
      .get(START_USER);
    const oldAudit = fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    fixture.database.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'instance.stopped' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    await expect(
      fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' }),
    ).rejects.toThrow('retirement failed');
    expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(fixture.daemon.networks.has(START_NETWORK)).toBe(false);
    expect(
      fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toEqual(oldRow);
    expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
      oldAudit,
    );
    fixture.database.exec('DROP TRIGGER reject_stop');
    const replacementId = 'f'.repeat(64);
    fixture.daemon.beforeRequest(({ path }) => {
      if (path === `/containers/create?name=dsh-team-u-${START_USER}`)
        fixture.daemon.setContainerId(replacementId);
      if (path === `/containers/create?name=dsh-team-u-${OTHER}`)
        fixture.daemon.setContainerId(OTHER_CONTAINER);
    });
    fixture.loseNextNetworkIdentity();
    await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toThrow(
      'network creation outcome unconfirmed',
    );
    const network = [...fixture.daemon.networks.values()].find(
      ({ Name }) => Name === `dsh-team-net-${START_USER}`,
    );
    if (network === undefined) throw new Error('Missing mutated unconfirmed bridge');
    expect(network.Containers).toEqual({});
    expect(
      fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toEqual(oldRow);
    expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
      oldAudit,
    );
    return { fixture, oldRow, oldAudit, replacementId, network: structuredClone(network) };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

it.each(['delete', 'audit'] as const)(
  'same-owner stale-index retry preserves an unconfirmed bridge until explicit retirement commits (failed stop=%s)',
  async (failure) => {
    const { fixture, oldRow, oldAudit, replacementId, network } =
      await uncertainReplacementFixture();
    try {
      await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toBeInstanceOf(Error);

      expect(
        fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
      ).toEqual(oldRow);
      expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
        oldAudit,
      );
      expect(fixture.daemon.containers.has(replacementId)).toBe(false);
      expect(fixture.daemon.networks.get(network.Id)).toEqual(network);
      expect(
        await fixture.owner.startUserContainer({ ...fixture.input, userId: OTHER }),
      ).toMatchObject({ outcome: 'starting', containerId: OTHER_CONTAINER });
      const bRow = fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(OTHER);
      const bContainer = structuredClone(fixture.daemon.containers.get(OTHER_CONTAINER));
      const bNetwork = [...fixture.daemon.networks.values()].find(
        ({ Name }) => Name === `dsh-team-net-${OTHER}`,
      );
      if (bNetwork === undefined) throw new Error('Missing unrelated admitted bridge');
      const bBefore = structuredClone(bNetwork);
      if (failure === 'delete')
        fixture.daemon.overrides.set(`DELETE /networks/${network.Id}`, { status: 500 });
      else
        fixture.database.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON audit_events
          WHEN NEW.event_type = 'instance.stopped' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
      await expect(
        fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' }),
      ).rejects.toThrow('retirement failed');
      const failedRetirement = {
        rows: fixture.database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
        audit: fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
        containers: structuredClone([...fixture.daemon.containers]),
        networks: structuredClone([...fixture.daemon.networks]),
      };

      await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toBeInstanceOf(Error);

      expect({
        rows: fixture.database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
        audit: fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
        containers: [...fixture.daemon.containers],
        networks: [...fixture.daemon.networks],
      }).toEqual(failedRetirement);
      expect(fixture.daemon.networks.has(network.Id)).toBe(failure === 'delete');
      if (failure === 'delete') fixture.daemon.overrides.delete(`DELETE /networks/${network.Id}`);
      else fixture.database.exec('DROP TRIGGER reject_stop');
      await fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
      expect(fixture.daemon.networks.has(network.Id)).toBe(false);
      expect(
        fixture.database
          .prepare('SELECT status, container_id FROM instances WHERE user_id = ?')
          .get(START_USER),
      ).toEqual({ status: 'stopped', container_id: null });
      expect(
        fixture.database
          .prepare("SELECT details FROM audit_events WHERE event_type = 'instance.stopped'")
          .all(),
      ).toEqual([{ details: '{"reason":"admin"}' }]);
      expect(await fixture.owner.startUserContainer(fixture.input)).toMatchObject({
        outcome: 'starting',
        containerId: replacementId,
      });
      const fresh = [...fixture.daemon.networks.values()].find(
        ({ Name }) => Name === `dsh-team-net-${START_USER}`,
      );
      expect(fresh?.Id).not.toBe(network.Id);
      expect(fresh?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] });
      expect(
        fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(OTHER),
      ).toEqual(bRow);
      expect(fixture.daemon.containers.get(OTHER_CONTAINER)).toEqual(bContainer);
      expect(fixture.daemon.networks.get(bBefore.Id)).toEqual(bBefore);
    } finally {
      await fixture.close();
    }
  },
);

it('automatic reconciliation cannot name-discover and retire an unconfirmed replacement bridge', async () => {
  const { fixture, oldRow, oldAudit, replacementId, network } = await uncertainReplacementFixture();
  try {
    await expect(fixture.owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(
      fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toEqual(oldRow);
    expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
      oldAudit,
    );
    expect(fixture.daemon.containers.has(replacementId)).toBe(false);
    expect(fixture.daemon.networks.get(network.Id)).toEqual(network);
    await fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    expect(await fixture.owner.startUserContainer(fixture.input)).toMatchObject({
      outcome: 'starting',
      containerId: replacementId,
    });
  } finally {
    await fixture.close();
  }
});

it('a no-op stopped-index retirement cannot clear uncertainty when that index later changes', async () => {
  const { fixture, oldRow, oldAudit, replacementId, network } = await uncertainReplacementFixture();
  try {
    // External SQLite index changes do not establish retirement of the unconfirmed Engine identity.
    fixture.database
      .prepare("UPDATE instances SET status = 'stopped', container_id = NULL WHERE user_id = ?")
      .run(START_USER);
    await fixture.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    expect(fixture.daemon.networks.get(network.Id)).toEqual(network);
    expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
      oldAudit,
    );
    fixture.database
      .prepare("UPDATE instances SET status = 'starting', container_id = ? WHERE user_id = ?")
      .run(START_CONTAINER, START_USER);

    await expect(fixture.owner.startUserContainer(fixture.input)).rejects.toBeInstanceOf(Error);

    expect(
      fixture.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toEqual(oldRow);
    expect(fixture.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
      oldAudit,
    );
    expect(fixture.daemon.containers.has(replacementId)).toBe(false);
    expect(fixture.daemon.networks.get(network.Id)).toEqual(network);
  } finally {
    await fixture.close();
  }
});

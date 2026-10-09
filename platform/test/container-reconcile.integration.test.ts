import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import type { Orchestrator } from '../src/orchestrator/index.ts';
import {
  startupDaemon,
  startupUnixServer,
  startupBarrier,
  startupUnixOwnerFixture,
  seedPlatform,
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  START_IMAGE,
} from './container-start-fixture.ts';
import {
  RECONCILE_LIST,
  seedReconciliation,
  reconciliationState,
  stoppedRow,
  expectReconciliationRejected,
  expireReconciliation,
  expectReconciliationRetired,
} from './container-reconcile-fixture.ts';

let root: string;
let database: DatabaseHandle;
let owner: Orchestrator;
let daemon = startupDaemon();
let hold: (method: string, path: string) => Promise<undefined> | undefined = () => undefined;
const server = startupUnixServer(
  (request) => daemon.reply(request),
  (method, path) => hold(method, path),
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-reconcile-wire-'));
  database = openDatabase(join(root, 'platform.db'));
  applyMigrations(database);
  daemon = startupDaemon();
  seedReconciliation(database, daemon);
  hold = () => undefined;
  const socket = join(root, 'engine.sock');
  server.listen(socket);
  await once(server, 'listening');
  owner = createOrchestrator({
    client: createDockerClient(socket),
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  database.close();
  await rm(root, { recursive: true, force: true });
});

it('corrects an indexed missing container on exact-ID404 without touching its same-name replacement', async () => {
  const replacementId = 'd'.repeat(64);
  const original = daemon.containers.get(START_CONTAINER);
  if (original === undefined) throw new Error('Missing fixture');
  const bridgeId = '0'.repeat(64);
  const replacement = {
    ...original,
    Id: replacementId,
    HostConfig: { NetworkMode: 'bridge' },
    NetworkSettings: {
      Ports: original.NetworkSettings.Ports,
      Networks: {
        bridge: {
          NetworkID: bridgeId,
          EndpointID: replacementId,
          IPAddress: '172.17.0.2',
          Aliases: null,
        },
      },
    },
  };
  daemon.removeContainer(START_CONTAINER);
  const bridge = daemon.networks.get(bridgeId);
  if (bridge === undefined) throw new Error('Missing default bridge fixture');
  bridge.Containers[replacementId] = {
    Name: `dsh-team-u-${START_USER}`,
    IPv4Address: '172.17.0.2/16',
    EndpointID: replacementId,
  };
  const bridgeBefore = structuredClone(bridge);
  daemon.containers.set(replacementId, replacement);

  await owner.reconcile();

  expect(daemon.requests.map(({ method, path }) => ({ method, path }))).toEqual(
    expect.arrayContaining([
      { method: 'GET', path: RECONCILE_LIST },
      { method: 'GET', path: `/containers/${START_CONTAINER}/json` },
    ]),
  );
  expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({
      event_type: 'instance.stopped',
      target: START_USER,
      target_email: `${START_USER}@example.test`,
      details: '{"reason":"error"}',
    }),
  ]);
  expect([...daemon.containers.values()]).toEqual([replacement]);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
  expect(daemon.networks.get(bridgeId)).toEqual(bridgeBefore);
  expect(
    daemon.requests
      .filter(({ method }) => method !== 'GET')
      .map(({ method, path }) => ({ method, path })),
  ).toEqual([{ method: 'DELETE', path: `/networks/${START_NETWORK}` }]);
});

it('a missing indexed container cannot authorize cleanup of a bridge occupied by its same-name replacement', async () => {
  const replacementId = 'd'.repeat(64);
  const original = daemon.containers.get(START_CONTAINER);
  if (original === undefined) throw new Error('Missing fixture');
  daemon.removeContainer(START_CONTAINER);
  const name = `dsh-team-net-${START_USER}`;
  const replacement = {
    ...original,
    Id: replacementId,
    NetworkSettings: {
      Ports: original.NetworkSettings.Ports,
      Networks: {
        [name]: {
          NetworkID: START_NETWORK,
          EndpointID: replacementId,
          IPAddress: '172.30.0.3',
          Aliases: [`u-${START_USER}`],
        },
      },
    },
  };
  daemon.containers.set(replacementId, replacement);
  const network = daemon.networks.get(START_NETWORK);
  if (network === undefined) throw new Error('Missing owned bridge fixture');
  network.Containers[replacementId] = {
    Name: `dsh-team-u-${START_USER}`,
    IPv4Address: '172.30.0.3/28',
    EndpointID: replacementId,
  };
  const before = {
    containers: structuredClone([...daemon.containers]),
    networks: structuredClone([...daemon.networks]),
  };

  await expectReconciliationRejected(database, daemon, owner);

  expect([...daemon.containers]).toEqual(before.containers);
  expect([...daemon.networks]).toEqual(before.networks);
  expect(daemon.containers.get(replacementId)).toEqual(replacement);
});

it('list omission does not retire a healthy exact inspected identity and repeats without writes', async () => {
  daemon.overrides.set(`GET ${RECONCILE_LIST}`, { status: 200, document: [] });
  const before = reconciliationState(database);

  await owner.reconcile();
  await owner.reconcile();

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(
    daemon.requests.filter(({ path }) => path === `/containers/${START_CONTAINER}/json`),
  ).toHaveLength(2);
});

it.each([RECONCILE_LIST, `/containers/${START_CONTAINER}/json`])(
  'fails closed for non404 Docker errors at %s',
  async (path) => {
    daemon.overrides.set(`GET ${path}`, { status: 403, document: { message: 'private response' } });

    await expectReconciliationRejected(database, daemon, owner);
  },
);

it.each(['POST', 'DELETE', 'audit'])(
  'preserves retryable indexed truth when %s retirement fails',
  async (stage) => {
    database.exec('UPDATE instances SET dsh_cookie = NULL');
    const before = reconciliationState(database);
    if (stage === 'audit')
      database.exec(
        "CREATE TRIGGER reject_reconciliation BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private audit failure'); END",
      );
    else
      daemon.overrides.set(
        `${stage} /containers/${START_CONTAINER}${stage === 'POST' ? '/stop?t=1' : ''}`,
        { status: 500 },
      );

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(reconciliationState(database)).toEqual(before);
    if (stage === 'audit') database.exec('DROP TRIGGER reject_reconciliation');
    else daemon.overrides.clear();
    await owner.reconcile();
    expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
    expect(reconciliationState(database).audits).toEqual([
      expect.objectContaining({ details: '{"reason":"error"}' }),
    ]);
  },
);

it.each(['inspect', 'stop', 'delete'])(
  'does not overwrite a replacement account/row observed during %s',
  async (stage) => {
    database.exec('UPDATE instances SET dsh_cookie = NULL');
    const boundary =
      stage === 'inspect'
        ? `/containers/${START_CONTAINER}/json`
        : stage === 'stop'
          ? `/containers/${START_CONTAINER}/stop?t=1`
          : `/containers/${START_CONTAINER}`;
    let changed = false;
    daemon.beforeRequest(({ path }) => {
      if (path !== boundary || changed) return;
      changed = true;
      database.exec(
        "UPDATE users SET password_hash = 'replacement'; UPDATE instances SET last_error = 'newer state'",
      );
    });

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(
      database.prepare('SELECT status, container_id, last_error FROM instances').get(),
    ).toEqual({ status: 'running', container_id: START_CONTAINER, last_error: 'newer state' });
    expect(reconciliationState(database).audits).toEqual([]);
    if (stage !== 'delete')
      expect(daemon.requests.filter(({ method }) => method === 'DELETE')).toEqual([]);
  },
);

it('queued reconciliation selects the state left by retirement rather than its earlier discovery', async () => {
  const gate = startupBarrier();
  let blocked = false;
  hold = (method, path) => {
    if (method === 'POST' && path.endsWith('/stop?t=1') && !blocked) {
      blocked = true;
      return gate.hold();
    }
    return undefined;
  };
  const retiring = owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await gate.reached;
  const reconciling = owner.reconcile();
  gate.release();

  await Promise.all([retiring, reconciling]);

  expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ details: '{"reason":"admin"}' }),
  ]);
});

it.each(['discovery', 'inspection'])(
  'cancels active %s without stale corrections or leaked requests',
  async (stage) => {
    const gate = startupBarrier();
    const target = stage === 'discovery' ? RECONCILE_LIST : `/containers/${START_CONTAINER}/json`;
    hold = (_method, path) => (path === target ? gate.hold() : undefined);
    const before = reconciliationState(database);
    const controller = new AbortController();
    const pending = owner.reconcile({ signal: controller.signal });
    const observed = expect(pending).rejects.toThrow('Instance reconciliation failed');
    await gate.reached;
    controller.abort();
    await observed;
    gate.release();

    expect(reconciliationState(database)).toEqual(before);
    expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  },
);

it.each(['discovery', 'inspection'])(
  'enforces a finite %s deadline on a silent Unix peer',
  async (stage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gate = startupBarrier();
    const target = stage === 'discovery' ? RECONCILE_LIST : `/containers/${START_CONTAINER}/json`;
    hold = (_method, path) => (path === target ? gate.hold() : undefined);
    const before = reconciliationState(database);
    const pending = owner.reconcile();
    const observed = expect(pending).rejects.toThrow('Instance reconciliation failed');
    await gate.reached;
    await vi.advanceTimersByTimeAsync(10_001);
    gate.release();
    await observed;

    expect(reconciliationState(database)).toEqual(before);
  },
);

it('rejects oversized discovery at the consumption boundary before any per-user work', async () => {
  daemon.overrides.set(`GET ${RECONCILE_LIST}`, {
    status: 200,
    document: [
      {
        Id: START_CONTAINER,
        ImageID: START_IMAGE,
        Names: [`/dsh-team-u-${START_USER}`],
        Labels: {
          'dsh-team.user': START_USER,
          'dsh-team.test-padding': 'x'.repeat(4 * 1024 * 1024),
        },
        State: 'running',
      },
    ],
  });
  const before = reconciliationState(database);

  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests).toEqual([{ method: 'GET', path: RECONCILE_LIST, body: {} }]);
});

it('preserves two healthy survivors after reconstruction and a database reopen', async () => {
  const other = 'mnopqrstuvwx';
  seedReconciliation(database, daemon, other, 'd'.repeat(64));
  const before = reconciliationState(database);
  database.close();
  database = openDatabase(join(root, 'platform.db'));
  const reconstructed = createOrchestrator({
    client: createDockerClient(join(root, 'engine.sock')),
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });

  await reconstructed.reconcile();
  await reconstructed.reconcile();

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('a fresh owner restores both surviving instance memberships after the configured platform is recreated without lifecycle churn', async () => {
  const other = 'mnopqrstuvwx';
  const second = 'd'.repeat(64);
  const secondNetwork = '2'.padStart(64, '0');
  const platformName = 'dsh-team-test-platform-recovery';
  const originalPlatform = 'f'.repeat(64);
  const replacementPlatform = '9'.repeat(64);
  const config = { upstreamMode: 'network' as const, platformContainerName: platformName };
  seedReconciliation(database, daemon, other, second);
  const survivors = [
    { user: START_USER, id: START_CONTAINER, network: START_NETWORK, host: '172.30.0.2' },
    { user: other, id: second, network: secondNetwork, host: '172.30.0.18' },
  ];
  for (const survivor of survivors) {
    const container = daemon.containers.get(survivor.id);
    const network = daemon.networks.get(survivor.network);
    if (container === undefined || network === undefined)
      throw new Error('Missing survivor fixture');
    container.NetworkSettings.Ports = { '3080/tcp': null };
    if (survivor.user === other) {
      network.IPAM = { Driver: 'default', Config: [{ Subnet: '172.30.0.16/28' }] };
      network.Containers[second] = {
        Name: 'dsh-team-u-mnopqrstuvwx',
        IPv4Address: '172.30.0.18/28',
        EndpointID: second,
      };
      container.NetworkSettings.Networks = {
        'dsh-team-net-mnopqrstuvwx': {
          NetworkID: secondNetwork,
          EndpointID: second,
          IPAddress: '172.30.0.18',
          Aliases: ['u-mnopqrstuvwx'],
        },
      };
    }
    database
      .prepare('UPDATE instances SET upstream_host = ?, upstream_port = 3080 WHERE user_id = ?')
      .run(survivor.host, survivor.user);
  }
  seedPlatform(daemon, platformName, originalPlatform);
  for (const survivor of survivors)
    expect(
      daemon.reply({
        method: 'POST',
        path: `/networks/${survivor.network}/connect`,
        body: { Container: originalPlatform },
      }).status,
    ).toBe(200);
  const liveOwner = createOrchestrator({
    client: createDockerClient(join(root, 'engine.sock')),
    database,
    config,
  });
  const before = reconciliationState(database);
  const containersBefore = survivors.map(({ id }) => structuredClone(daemon.containers.get(id)));
  const healthyBoundary = daemon.requests.length;
  await liveOwner.reconcile();
  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.slice(healthyBoundary).filter(({ method }) => method !== 'GET')).toEqual(
    [],
  );

  daemon.removeContainer(originalPlatform);
  const primaryBefore = structuredClone(seedPlatform(daemon, platformName, replacementPlatform));
  for (const survivor of survivors)
    expect(Object.keys(daemon.networks.get(survivor.network)?.Containers ?? {})).toEqual([
      survivor.id,
    ]);
  database.close();
  database = openDatabase(join(root, 'platform.db'));
  const reconstructed = createOrchestrator({
    client: createDockerClient(join(root, 'engine.sock')),
    database,
    config,
  });
  const recoveryBoundary = daemon.requests.length;

  const outcome = await Promise.allSettled([reconstructed.reconcile()]);

  for (const survivor of survivors) {
    expect
      .soft(Object.keys(daemon.networks.get(survivor.network)?.Containers ?? {}).sort())
      .toEqual([survivor.id, replacementPlatform].sort());
    expect
      .soft(daemon.containers.get(replacementPlatform)?.NetworkSettings.Networks)
      .toMatchObject({
        [`dsh-team-net-${survivor.user}`]: { NetworkID: survivor.network },
      });
  }
  expect.soft(reconciliationState(database)).toEqual(before);
  expect.soft(survivors.map(({ id }) => daemon.containers.get(id))).toEqual(containersBefore);
  expect.soft(daemon.networks.get('0'.repeat(64))).toEqual(primaryBefore);
  expect.soft(daemon.containers.has(originalPlatform)).toBe(false);
  expect
    .soft(
      daemon.requests
        .slice(recoveryBoundary)
        .filter(({ method, path }) => method !== 'GET' && !path.endsWith('/connect')),
    )
    .toEqual([]);
  expect(outcome).toEqual([{ status: 'fulfilled', value: undefined }]);
  const settledBoundary = daemon.requests.length;
  await reconstructed.reconcile();
  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.slice(settledBoundary).filter(({ method }) => method !== 'GET')).toEqual(
    [],
  );
});

it('discovers and removes a physically stopped owned container without volume deletion', async () => {
  const container = daemon.containers.get(START_CONTAINER);
  if (container === undefined) throw new Error('Missing fixture');
  container.State.Running = false;

  await owner.reconcile();

  expect(daemon.requests[0]).toEqual({ method: 'GET', path: RECONCILE_LIST, body: {} });
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'DELETE', path: `/containers/${START_CONTAINER}`, body: {} },
    { method: 'DELETE', path: `/networks/${START_NETWORK}`, body: {} },
  ]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
  expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ event_type: 'instance.stopped', details: '{"reason":"error"}' }),
  ]);
});

it.each(['malformed-list', 'malformed-inspect', 'cookie', 'endpoint'])(
  'fails closed across Unix transport for %s',
  async (kind) => {
    if (kind === 'malformed-list')
      daemon.overrides.set(`GET ${RECONCILE_LIST}`, { status: 200, document: [null] });
    if (kind === 'malformed-inspect')
      daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, {
        status: 200,
        document: {},
      });
    if (kind === 'cookie') database.exec("UPDATE instances SET dsh_cookie = 'invalid-cookie'");
    if (kind === 'endpoint') database.exec('UPDATE instances SET upstream_port = 40001');

    await expectReconciliationRejected(database, daemon, owner);
  },
);

it.each(['missing', 'stopped', 'disabled', 'running'])(
  'real Unix and SQLite reconciliation safely retires expired-cookie %s instances',
  async (state) => {
    expireReconciliation(database, daemon, state);

    await owner.reconcile();
    await owner.reconcile();

    expectReconciliationRetired(database, daemon);
  },
);

it('submitted orphan deletion settles before same-user retirement while an unrelated user progresses despite caller cancellation', async () => {
  const other = 'mnopqrstuvwx';
  const otherContainer = 'd'.repeat(64);
  const otherNetwork = '2'.padStart(64, '0');
  seedReconciliation(database, daemon, other, otherContainer);
  daemon.removeContainer(otherContainer);
  database
    .prepare(
      `UPDATE instances SET status = 'stopped', container_id = NULL,
    image_id = NULL, image_tag = NULL, upstream_host = NULL, upstream_port = NULL,
    dsh_cookie = NULL WHERE user_id = ?`,
    )
    .run(other);
  const gate = startupBarrier();
  hold = (method, path) =>
    method === 'DELETE' && path === `/networks/${otherNetwork}` ? gate.hold() : undefined;
  const cancellation = new AbortController();
  const pending = owner.reconcile({ signal: cancellation.signal });
  const observed = Promise.allSettled([pending]);
  await gate.reached;
  let successorSettled = false;
  const successor = owner.stopUserContainer({ userId: other, reason: 'admin' }).then(() => {
    successorSettled = true;
  });
  try {
    cancellation.abort();

    await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

    expect(successorSettled).toBe(false);
    expect(daemon.networks.has(otherNetwork)).toBe(true);
    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    gate.release();
    expect(await observed).toEqual([expect.objectContaining({ status: 'rejected' })]);
    await successor;
    expect(daemon.networks.has(otherNetwork)).toBe(false);
    expect(
      database.prepare('SELECT status, container_id FROM instances WHERE user_id = ?').get(other),
    ).toEqual({ status: 'stopped', container_id: null });
    expect(reconciliationState(database).audits).toEqual([
      expect.objectContaining({ target: START_USER, details: '{"reason":"admin"}' }),
    ]);
  } finally {
    gate.release();
    await observed;
    await successor;
  }
});

function seedNetworkRecovery() {
  const platformId = 'f'.repeat(64);
  const platformName = 'dsh-team-test-recovery-outcomes';
  seedPlatform(daemon, platformName, platformId);
  const container = daemon.containers.get(START_CONTAINER);
  const platform = daemon.containers.get(platformId);
  if (container === undefined || platform === undefined)
    throw new Error('Missing recovery fixture');
  container.NetworkSettings.Ports = { '3080/tcp': null };
  database.exec("UPDATE instances SET upstream_host = '172.30.0.2', upstream_port = 3080");
  owner = createOrchestrator({
    client: createDockerClient(join(root, 'engine.sock')),
    database,
    config: { upstreamMode: 'network', platformContainerName: platformName },
  });
  return { platformId, platformName, platform };
}

it.each([
  'preflight transient',
  'committed attachment inspect failure',
  'attached stopped platform',
  'unconfirmed connection transport',
])(
  'network recovery preserves authenticated survivors after %s instead of granting retirement authority',
  async (stage) => {
    const { platformId, platformName, platform } = seedNetworkRecovery();
    if (stage === 'attached stopped platform') {
      expect(
        daemon.reply({
          method: 'POST',
          path: `/networks/${START_NETWORK}/connect`,
          body: { Container: platformId },
        }).status,
      ).toBe(200);
      platform.State.Running = false;
    }
    // The Engine denies this connect, but the caller must not gain its rejection status when the wire closes.
    if (stage === 'unconfirmed connection transport')
      daemon.overrides.set(`POST /networks/${START_NETWORK}/connect`, { status: 403 });
    const before = reconciliationState(database);
    const snapshot = () => ({
      containers: structuredClone([...daemon.containers]),
      networks: structuredClone([...daemon.networks]),
    });
    let preserved = snapshot();
    let platformLookups = 0;
    let submitted = false;
    let settlementLookups = 0;
    let lost = false;
    daemon.beforeRequest(({ method, path }) => {
      if (stage === 'preflight transient' && path === `/containers/${platformName}/json`) {
        platformLookups += 1;
        if (platformLookups === 2) daemon.overrides.set(`GET ${path}`, { status: 500 });
        else daemon.overrides.delete(`GET ${path}`);
      }
      if (
        stage === 'committed attachment inspect failure' &&
        method === 'POST' &&
        path.endsWith('/connect')
      )
        submitted = true;
      if (submitted && method === 'GET' && path === `/networks/${START_NETWORK}`) {
        settlementLookups += 1;
        if (settlementLookups === 1) {
          preserved = snapshot();
          daemon.overrides.set(`GET ${path}`, { status: 500 });
        } else daemon.overrides.delete(`GET ${path}`);
      }
      if (lost && method === 'GET' && path === `/networks/${START_NETWORK}`) {
        preserved = snapshot();
        lost = false;
      }
    });
    const interrupt = (request: IncomingMessage, response: ServerResponse) => {
      if (
        stage !== 'unconfirmed connection transport' ||
        request.method !== 'POST' ||
        request.url !== `/networks/${START_NETWORK}/connect`
      )
        return;
      lost = true;
      request.once('error', () => {
        // This fixture deliberately severs the accepted HTTP connection; its peer reset is expected.
      });
      response.destroy();
    };
    server.on('request', interrupt);

    let outcome: PromiseSettledResult<void>[];
    try {
      outcome = await Promise.allSettled([owner.reconcile()]);
    } finally {
      server.off('request', interrupt);
    }

    expect.soft(reconciliationState(database)).toEqual(before);
    expect.soft([...daemon.containers]).toEqual(preserved.containers);
    expect.soft([...daemon.networks]).toEqual(preserved.networks);
    const expectedFailure: unknown = expect.objectContaining({
      message: 'Instance reconciliation failed',
    });
    expect(outcome).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expectedFailure,
      }),
    ]);
  },
);

it('a definitive rejected platform connection with independently absent membership retires into atomic error/null state', async () => {
  seedNetworkRecovery();
  daemon.overrides.set(`POST /networks/${START_NETWORK}/connect`, { status: 403 });

  await owner.reconcile();

  expect(reconciliationState(database).rows).toEqual([
    {
      ...stoppedRow(),
      status: 'error',
      last_error: 'Platform network recovery failed',
    },
  ]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({
      event_type: 'instance.stopped',
      target: START_USER,
      details: '{"reason":"error"}',
    }),
  ]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
});

it('network recovery preserves an authenticated survivor whose platform membership returns after confirmed connection rejection', async () => {
  const platformId = 'f'.repeat(64);
  const context = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-recovery-restored-membership-',
    users: {},
    userImage: 'image:test',
    subnetPool: '172.30.0.0/26',
    transport: {
      upstreamMode: 'network',
      platformContainerName: 'dsh-team-test-restored-membership',
    },
  });
  const { database, daemon, owner } = context;
  try {
    seedReconciliation(database, daemon);
    seedPlatform(daemon, 'dsh-team-test-restored-membership', platformId);
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing survivor fixture');
    container.NetworkSettings.Ports = { '3080/tcp': null };
    database.exec("UPDATE instances SET upstream_host = '172.30.0.2', upstream_port = 3080");
    const before = reconciliationState(database);
    daemon.overrides.set(`POST /networks/${START_NETWORK}/connect`, { status: 403 });
    let rejected = false;
    let platformInspections = 0;
    const observation: {
      preserved?: { containers: typeof daemon.containers; networks: typeof daemon.networks };
    } = {};
    context.replyWith((request, reply) => {
      if (request.method === 'POST' && request.path === `/networks/${START_NETWORK}/connect`)
        rejected = true;
      if (
        !rejected ||
        request.method !== 'GET' ||
        request.path !== `/containers/${platformId}/json`
      )
        return reply;
      platformInspections += 1;
      if (platformInspections !== 2) return reply;
      // Deliver the already captured absent view, then restore membership externally before the next guard.
      const captured = structuredClone(reply);
      daemon.overrides.delete(`POST /networks/${START_NETWORK}/connect`);
      expect(
        daemon.reply({
          method: 'POST',
          path: `/networks/${START_NETWORK}/connect`,
          body: { Container: platformId },
        }).status,
      ).toBe(200);
      observation.preserved = {
        containers: structuredClone(daemon.containers),
        networks: structuredClone(daemon.networks),
      };
      return captured;
    });

    const outcome = await Promise.allSettled([owner.reconcile()]);

    const preserved = observation.preserved;
    if (preserved === undefined) throw new Error('External reconnection boundary not reached');
    expect.soft(reconciliationState(database)).toEqual(before);
    expect.soft(daemon.containers).toEqual(preserved.containers);
    expect.soft(daemon.networks).toEqual(preserved.networks);
    expect
      .soft(Object.keys(daemon.networks.get(START_NETWORK)?.Containers ?? {}).sort())
      .toEqual([START_CONTAINER, platformId]);
    expect
      .soft(
        daemon.requests.filter(
          ({ method, path }) => method === 'DELETE' || path.endsWith('/stop?t=1'),
        ),
      )
      .toEqual([]);
    const expectedFailure: unknown = expect.objectContaining({
      message: 'Instance reconciliation failed',
    });
    expect(outcome).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expectedFailure }),
    ]);
  } finally {
    await context.close();
  }
});

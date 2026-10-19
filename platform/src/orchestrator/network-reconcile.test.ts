import { rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, createInstanceService, createOrchestrator } from './index.ts';
import type { DockerTransport } from './index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupDaemon,
  startupBarrier,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import type { StartupRequest } from '../../test/container-start-fixture.ts';
import { instanceConfig } from '../../test/instance-fixture.ts';
import { reconciliationState, seedReconciliation } from '../../test/container-reconcile-fixture.ts';

const databases: DatabaseHandle[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const NETWORK_LIST = `/networks?filters=${encodeURIComponent(JSON.stringify({ label: ['dsh-team.user'] }))}`;
function fixture(networkMode = false) {
  const database = openDatabase(':memory:');
  databases.push(database);
  applyMigrations(database);
  const daemon = startupDaemon();
  seedReconciliation(database, daemon);
  const container = structuredClone(daemon.containers.get(START_CONTAINER));
  daemon.removeContainer(START_CONTAINER);
  database.exec('DELETE FROM instances; DELETE FROM users');
  const platform = 'f'.repeat(64);
  const name = 'dsh-team-test-orphan';
  if (networkMode) {
    seedPlatform(daemon, name, platform);
    expect(
      daemon.reply({
        method: 'POST',
        path: `/networks/${START_NETWORK}/connect`,
        body: { Container: platform },
      }).status,
    ).toBe(200);
  }
  const owner = createOrchestrator({
    database,
    client: createDockerClient('/unused.sock', daemon.transport),
    config: {
      upstreamMode: networkMode ? 'network' : 'published-loopback',
      platformContainerName: name,
    },
  });
  const network = daemon.networks.get(START_NETWORK);
  if (network === undefined || container === undefined) throw new Error('Missing fixture');
  return { database, daemon, owner, network, container, platform };
}

it.each([false, true])(
  'deletes an exact-owned orphan without an account or index and preserves primary connectivity in network mode=%s',
  async (networkMode) => {
    const { database, daemon, owner, platform } = fixture(networkMode);
    const before = reconciliationState(database);
    const primary = structuredClone(daemon.networks.get('0'.repeat(64)));

    await owner.reconcile();
    await owner.reconcile();

    expect(daemon.networks.has(START_NETWORK)).toBe(false);
    expect(reconciliationState(database)).toEqual(before);
    expect(daemon.networks.get('0'.repeat(64))).toEqual(primary);
    if (networkMode)
      expect(daemon.containers.get(platform)?.NetworkSettings.Networks).not.toHaveProperty(
        `dsh-team-net-${START_USER}`,
      );
    expect(daemon.requests.filter(({ path }) => path.includes('/volumes'))).toEqual([]);
  },
);

it.each(['canonical', 'indexed'])(
  'preserves a bridge when its %s container exists even without list evidence',
  async (kind) => {
    const { database, daemon, owner, network, container } = fixture();
    if (kind === 'indexed') {
      database
        .prepare(
          "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
        )
        .run(START_USER);
      database
        .prepare("INSERT INTO instances (user_id, status, container_id) VALUES (?, 'error', ?)")
        .run(START_USER, START_CONTAINER);
      container.Name = '/foreign-name';
    }
    daemon.containers.set(START_CONTAINER, container);
    const before = structuredClone(network);

    const result = await Promise.allSettled([owner.reconcile()]);

    expect(result[0].status).toBe(kind === 'indexed' ? 'rejected' : 'fulfilled');
    expect(daemon.networks.get(START_NETWORK)).toEqual(before);
    expect(daemon.containers.get(START_CONTAINER)).toEqual(container);
  },
);

it.each(['foreign', 'name', 'driver', 'internal', 'subnet', 'ipv6', 'user'])(
  'rejects an owned orphan with invalid %s',
  async (kind) => {
    const { database, daemon, owner, network } = fixture();
    if (kind === 'foreign')
      network.Containers['d'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.3/28' };
    if (kind === 'name') network.Name = 'foreign';
    if (kind === 'driver') network.Driver = 'overlay';
    if (kind === 'internal') network.Internal = true;
    if (kind === 'subnet') network.IPAM = { Config: [{ Subnet: '172.30.0.1/28' }] };
    if (kind === 'ipv6') network.EnableIPv6 = true;
    if (kind === 'user') network.Labels = { 'dsh-team.user': 'invalid' };

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(daemon.networks.get(START_NETWORK)).toEqual(network);
    expect(reconciliationState(database).audits).toEqual([]);
  },
);

it.each(['duplicate', 'inventory', 'permission', 'row', 'account', 'replacement', 'subnet-change'])(
  'fails closed for an orphan with %s uncertainty',
  async (kind) => {
    const { database, daemon, owner, network } = fixture();
    if (kind === 'duplicate')
      daemon.overrides.set(`GET ${NETWORK_LIST}`, { status: 200, document: [network, network] });
    if (kind === 'inventory')
      daemon.overrides.set(`GET ${NETWORK_LIST}`, { status: 200, document: {} });
    if (kind === 'permission')
      daemon.overrides.set(`GET /containers/dsh-team-u-${START_USER}/json`, { status: 403 });
    if (kind === 'account')
      database
        .prepare(
          "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
        )
        .run(START_USER);
    let changed = false;
    daemon.beforeRequest(({ path }) => {
      if (path !== `/networks/dsh-team-net-${START_USER}` || changed) return;
      changed = true;
      if (kind === 'subnet-change') network.IPAM = { Config: [{ Subnet: '172.30.0.16/28' }] };
      if (kind === 'row') {
        database
          .prepare(
            "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
          )
          .run(START_USER);
        database
          .prepare("INSERT INTO instances (user_id, status) VALUES (?, 'stopped')")
          .run(START_USER);
      }
      if (kind === 'account') database.exec("UPDATE users SET password_hash = 'replacement'");
      if (kind === 'replacement') {
        daemon.networks.delete(START_NETWORK);
        daemon.networks.set('d'.repeat(64), { ...network, Id: 'd'.repeat(64) });
      }
    });

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(daemon.networks.size).toBe(2);
    expect(reconciliationState(database).audits).toEqual([]);
  },
);

it('a discovery omission cannot hide an indexed live identity from orphan absence checks', async () => {
  const { database, daemon, owner, network, container } = fixture();
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
    )
    .run(START_USER);
  database
    .prepare("INSERT INTO instances (user_id, status, container_id) VALUES (?, 'error', ?)")
    .run(START_USER, START_CONTAINER);
  container.Name = '/other';
  daemon.containers.set(START_CONTAINER, container);
  daemon.overrides.set(
    `GET /containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['dsh-team.user'] }))}`,
    { status: 200, document: [] },
  );

  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(daemon.networks.get(START_NETWORK)).toEqual(network);
  expect(daemon.containers.get(START_CONTAINER)).toEqual(container);
});

it.each(['disconnect', 'delete', 'inspect'])(
  'preserves orphan resources and database truth when %s cannot be confirmed',
  async (stage) => {
    const { database, daemon, owner } = fixture(true);
    const boundary =
      stage === 'inspect'
        ? `GET /networks/${START_NETWORK}`
        : stage === 'delete'
          ? `DELETE /networks/${START_NETWORK}`
          : `POST /networks/${START_NETWORK}/disconnect`;
    daemon.overrides.set(boundary, { status: 500 });
    const before = reconciliationState(database);

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(daemon.networks.has(START_NETWORK)).toBe(true);
    expect(reconciliationState(database)).toEqual(before);
  },
);

it.each(['live-index', 'invalid-index', 'starting'])(
  'fresh orphan checks preserve a network when %s appears after indexed corrections',
  async (kind) => {
    const { database, daemon, owner, network, container } = fixture();
    daemon.beforeRequest(({ path }) => {
      if (path !== NETWORK_LIST) return;
      database
        .prepare(
          "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
        )
        .run(START_USER);
      const id =
        kind === 'live-index' ? START_CONTAINER : kind === 'invalid-index' ? 'invalid' : null;
      database
        .prepare('INSERT INTO instances (user_id, status, container_id) VALUES (?, ?, ?)')
        .run(START_USER, kind === 'starting' ? 'starting' : 'error', id);
      if (kind === 'live-index') {
        container.Name = '/distinct-indexed-container';
        daemon.containers.set(START_CONTAINER, container);
      }
    });

    const result = await Promise.allSettled([owner.reconcile()]);

    expect(result[0].status).toBe(kind === 'live-index' ? 'fulfilled' : 'rejected');
    expect(daemon.networks.get(START_NETWORK)).toEqual(network);
    expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(reconciliationState(database).audits).toEqual([]);
  },
);
it('retains a late pending bridge in the current owner and recovers its delayed exact create under fresh ownership', async () => {
  const { database, daemon, input, root } = await startupOwnerFixture();
  databases.push(database);
  roots.push(root);
  seedReconciliation(database, daemon);
  const other = 'mnopqrstuvwx';
  const otherId = 'd'.repeat(64);
  const createPath = `/containers/create?name=dsh-team-u-${other}`;
  const correction = startupBarrier();
  const creation = startupBarrier();
  let held = false;
  const submission: { request?: StartupRequest } = {};
  const transport: DockerTransport = (options, receive) => {
    if (
      options.method === 'GET' &&
      options.path === `/containers/${START_CONTAINER}/json` &&
      !held
    ) {
      held = true;
      return daemon.transport(options, (response) => {
        // Initial user discovery has completed; hold A's indexed correction response.
        void correction.hold().then(() => {
          receive(response);
        });
      });
    }
    if (options.method !== 'POST' || options.path !== createPath)
      return daemon.transport(options, receive);
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        submission.request = {
          method: 'POST',
          path: createPath,
          // The real Docker client serialized this external Engine request.
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        };
        // Accept the request, lose its response, and defer its Engine-side effect.
        void creation.hold().then(() => {
          done(
            Object.assign(new Error('Fixture loses submitted create response'), {
              code: 'ECONNRESET',
            }),
          );
        });
      },
    });
  };
  const client = createDockerClient('/fixture/docker.sock', transport);
  const ownerOptions = {
    database,
    client,
    config: {
      upstreamMode: 'published-loopback' as const,
      platformContainerName: 'dsh-team-platform',
    },
  };
  const owner = createOrchestrator(ownerOptions);
  // This second owner supplies read-only public projections, never lifecycle mutations.
  const service = createInstanceService({
    database,
    client,
    config: instanceConfig(root, input.config),
  });
  const account = database.prepare('SELECT * FROM users WHERE id = ?').get(START_USER);
  const healthy = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
  const healthyContainer = structuredClone(daemon.containers.get(START_CONTAINER));
  const healthyNetwork = structuredClone(daemon.networks.get(START_NETWORK));
  const primary = structuredClone(daemon.networks.get('0'.repeat(64)));
  const attempt = () =>
    database
      .prepare<[string], { network_id: string; attempt_id: string; container_id: string | null }>(
        'SELECT * FROM creation_attempts WHERE user_id = ?',
      )
      .get(other);
  const row = () => database.prepare('SELECT * FROM instances WHERE user_id = ?').get(other);
  const audits = () =>
    database.prepare('SELECT event_type FROM audit_events WHERE target = ? ORDER BY id').all(other);
  let starting: Promise<unknown> | undefined;
  const reconciling = Promise.allSettled([owner.reconcile()]);
  try {
    await correction.reached;
    expect(row()).toBeUndefined();
    expect(attempt()).toBeUndefined();
    daemon.setContainerId(otherId);
    // The same owner's B queue can submit after its reconciliation inventory captured only A.
    starting = Promise.allSettled([owner.startUserContainer({ ...input, userId: other })]);
    await creation.reached;
    const receipt = attempt();
    const submitted = submission.request;
    if (receipt === undefined || submitted === undefined)
      throw new Error('Expected committed creation receipt and captured Engine request');
    const bridge = structuredClone(daemon.networks.get(receipt.network_id));
    expect(bridge).toMatchObject({
      Name: `dsh-team-net-${other}`,
      Labels: { 'dsh-team.user': other },
      Containers: {},
    });
    expect(receipt.container_id).toBeNull();
    expect(submitted.body).toMatchObject({
      Labels: { 'dsh-team.user': other, 'dsh-team.creation-attempt': receipt.attempt_id },
      HostConfig: { NetworkMode: receipt.network_id },
    });
    expect(daemon.containers.has(otherId)).toBe(false);
    creation.release();
    expect(await starting).toMatchObject([{ status: 'rejected' }]);
    expect(attempt()).toEqual(receipt);
    expect(daemon.networks.get(receipt.network_id)).toEqual(bridge);
    expect(row()).toBeUndefined();
    expect(audits()).toEqual([]);

    correction.release();
    const result = await reconciling;
    expect(result).toEqual([{ status: 'fulfilled', value: undefined }]);

    // Baseline RED: its orphan phase deletes this exact bridge despite the new durable receipt.
    expect(daemon.networks.get(receipt.network_id)).toEqual(bridge);
    expect(attempt()).toEqual(receipt);
    expect(row()).toBeUndefined();
    expect(service.status(other)).toEqual({ status: 'error', reason: 'error' });
    expect(service.resolveUpstream(other)).toEqual({ outcome: 'error' });
    expect(audits()).toEqual([]);
    await expect(owner.startUserContainer({ ...input, userId: other })).rejects.toThrow();
    await expect(
      owner.stopUserContainer({ userId: other, reason: 'admin', allowMissingInstance: true }),
    ).rejects.toThrow();
    expect(attempt()).toEqual(receipt);
    expect(daemon.networks.get(receipt.network_id)).toEqual(bridge);
    expect(audits()).toEqual([]);
    expect(
      daemon.requests.filter(
        ({ method, path }) =>
          (method === 'DELETE' || path.endsWith('/disconnect')) &&
          (path.includes(receipt.network_id) || path.includes(`dsh-team-net-${other}`)),
      ),
    ).toEqual([]);

    // Apply the one accepted external request, preserving its actual nonce, mounts and bridge.
    expect(daemon.reply(submitted)).toMatchObject({ status: 201, document: { Id: otherId } });
    expect(daemon.containers.get(otherId)?.State).toEqual({
      Running: false,
      Status: 'created',
      StartedAt: '0001-01-01T00:00:00Z',
    });
    const recovered = createOrchestrator(ownerOptions);
    await recovered.reconcile();
    const recoveryEnd = daemon.requests.length;
    await recovered.reconcile();
    await recovered.drain();
    expect(daemon.requests.slice(recoveryEnd).filter(({ method }) => method !== 'GET')).toEqual([]);

    expect(daemon.containers.has(otherId)).toBe(false);
    expect(daemon.networks.has(receipt.network_id)).toBe(false);
    expect(attempt()).toBeUndefined();
    expect(row()).toMatchObject({
      status: 'error',
      container_id: null,
      upstream_host: null,
      upstream_port: null,
      dsh_cookie: null,
    });
    expect(audits()).toEqual([{ event_type: 'instance.start-failed' }]);
    expect(
      daemon.requests.filter(
        ({ method, path }) => method === 'DELETE' && path.includes('/volumes'),
      ),
    ).toEqual([]);
    expect(
      daemon.requests.filter(
        ({ method, path }) => method === 'DELETE' && path === `/containers/${otherId}`,
      ),
    ).toHaveLength(1);
    expect(database.prepare('SELECT * FROM users WHERE id = ?').get(START_USER)).toEqual(account);
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER)).toEqual(
      healthy,
    );
    expect(daemon.containers.get(START_CONTAINER)).toEqual(healthyContainer);
    expect(daemon.networks.get(START_NETWORK)).toEqual(healthyNetwork);
    expect(daemon.networks.get('0'.repeat(64))).toEqual(primary);
  } finally {
    creation.release();
    correction.release();
    await reconciling;
    await starting;
    await owner.drain();
    await service.close();
  }
});

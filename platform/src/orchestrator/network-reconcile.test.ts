import { afterEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, createOrchestrator } from './index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupDaemon,
} from '../../test/container-start-fixture.ts';
import { reconciliationState, seedReconciliation } from '../../test/container-reconcile-fixture.ts';

const databases: DatabaseHandle[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
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

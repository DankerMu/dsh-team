import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import { writeSettings } from '../db/index.ts';
import { createDockerClient, createOrchestrator } from './index.ts';
import {
  startupOwnerFixture,
  startupBarrier,
  START_CONTAINER,
  START_USER,
} from '../../test/container-start-fixture.ts';
import {
  RECONCILE_COOKIE,
  expireReconciliation,
  expectReconciliationRetired,
  RECONCILE_LIST,
  seedReconciliation,
  reconciliationState,
  stoppedRow,
  expectReconciliationRejected,
} from '../../test/container-reconcile-fixture.ts';

const roots: string[] = [];
const databases: DatabaseHandle[] = [];
const OTHER = 'mnopqrstuvwx';
const OTHER_ID = 'd'.repeat(64);
afterEach(async () => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const context = await startupOwnerFixture();
  roots.push(context.root);
  databases.push(context.database);
  seedReconciliation(context.database, context.daemon);
  return context;
}

it('reconstructed owners preserve two healthy complete rows and audits across repeated reconciliation', async () => {
  const { database, daemon, client } = await fixture();
  seedReconciliation(database, daemon, OTHER, OTHER_ID);
  const before = reconciliationState(database);
  const physical = structuredClone([...daemon.containers.values()]);
  const owner = createOrchestrator({
    database,
    client,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });

  await owner.reconcile();
  await owner.reconcile();

  expect(reconciliationState(database)).toEqual(before);
  expect([...daemon.containers.values()]).toEqual(physical);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it.each(['missing', 'stopped', 'cookie-null', 'cookie-empty', 'starting', 'error', 'disabled'])(
  'retires valid %s state once and preserves history',
  async (kind) => {
    const { database, daemon, owner } = await fixture();
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing fixture');
    if (kind === 'missing') daemon.removeContainer(START_CONTAINER);
    if (kind === 'stopped') container.State.Running = false;
    if (kind === 'cookie-null') database.exec('UPDATE instances SET dsh_cookie = NULL');
    if (kind === 'cookie-empty') database.exec("UPDATE instances SET dsh_cookie = ''");
    if (kind === 'starting' || kind === 'error')
      database.prepare('UPDATE instances SET status = ?').run(kind);
    if (kind === 'disabled') database.exec("UPDATE users SET status = 'disabled'");

    await owner.reconcile();
    const state = reconciliationState(database);
    await owner.reconcile();

    expect(state.rows).toEqual([stoppedRow()]);
    expect(state.audits).toEqual([
      expect.objectContaining({
        event_type: 'instance.stopped',
        target: START_USER,
        details: '{"reason":"error"}',
      }),
    ]);
    expect(reconciliationState(database)).toEqual(state);
    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      daemon.requests.filter(({ method, path }) => method !== 'GET' && path.includes('/volumes')),
    ).toEqual([]);
  },
);

it('retires incomplete starting endpoints without promotion', async () => {
  const { database, owner } = await fixture();
  database.exec(
    "UPDATE instances SET status = 'starting', upstream_host = NULL, upstream_port = NULL, last_started_at = NULL, dsh_cookie = NULL",
  );

  await owner.reconcile();

  expect(reconciliationState(database).rows).toEqual([{ ...stoppedRow(), last_started_at: null }]);
});

it.each([
  ['container_id', null],
  ['container_id', 'invalid'],
  ['image_id', 'invalid'],
  ['image_tag', ''],
  ['upstream_host', '0.0.0.0'],
  ['upstream_port', null],
  ['upstream_port', 49174],
  ['last_started_at', 1.5],
  ['dsh_cookie', 'not-a-dsh-cookie'],
  ['dsh_cookie', `${RECONCILE_COOKIE}; extra=value`],
] as const)('fails closed for invalid indexed %s=%s', async (field, value) => {
  const { database, owner, daemon } = await fixture();
  database.prepare(`UPDATE instances SET ${field} = ?`).run(value);

  await expectReconciliationRejected(database, daemon, owner);
});

it.each(['id', 'image', 'name', 'label', 'state', 'ports'])(
  'rejects foreign or malformed inspected %s without retiring the object',
  async (kind) => {
    const { daemon, database, owner } = await fixture();
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing fixture');
    const document: Record<string, unknown> = { ...structuredClone(container) };
    if (kind === 'id') document.Id = OTHER_ID;
    if (kind === 'image') document.Image = `sha256:${'f'.repeat(64)}`;
    if (kind === 'name') document.Name = '/foreign';
    if (kind === 'label') document.Config = { Labels: { 'dsh-team.user': OTHER } };
    if (kind === 'state') document.State = { Running: 'yes' };
    if (kind === 'ports') document.NetworkSettings = { Ports: {} };
    daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, { status: 200, document });

    await expectReconciliationRejected(database, daemon, owner);
  },
);

it.each([
  null,
  {},
  [null],
  [{ Id: START_CONTAINER }],
  [{ Id: START_CONTAINER, Labels: {}, Names: [] }],
])('rejects malformed discovery %j without changing state', async (document) => {
  const { database, daemon, owner } = await fixture();
  daemon.overrides.set(`GET ${RECONCILE_LIST}`, { status: 200, document });

  await expectReconciliationRejected(database, daemon, owner);

  expect(daemon.requests).toHaveLength(1);
});

it('does not adopt or delete unindexed canonical objects or managed-composition helpers', async () => {
  const { database, daemon, owner } = await fixture();
  const original = daemon.containers.get(START_CONTAINER);
  if (original === undefined) throw new Error('Missing fixture');
  daemon.containers.set(OTHER_ID, {
    ...original,
    Id: OTHER_ID,
    Name: `/dsh-team-u-${OTHER}`,
    Config: { Labels: { 'dsh-team.user': OTHER } },
  });
  daemon.containers.set('e'.repeat(64), {
    ...original,
    Id: 'e'.repeat(64),
    Name: '/dsh-team-compose-owned',
    Config: { Labels: { 'dsh-team.user': START_USER, 'dsh-team.role': 'managed-composition' } },
  });
  const physical = structuredClone([...daemon.containers.values()]);
  const before = reconciliationState(database);

  await owner.reconcile();

  expect(reconciliationState(database)).toEqual(before);
  expect([...daemon.containers.values()]).toEqual(physical);
  expect(daemon.requests.filter(({ path }) => path.endsWith('/json'))).toEqual([
    { method: 'GET', path: `/containers/${START_CONTAINER}/json`, body: {} },
  ]);
});

it('a missing indexed container frees persisted admission capacity without another counter', async () => {
  const { database, daemon, owner, input } = await fixture();
  writeSettings(database, { maxRunningInstances: 1 });
  daemon.removeContainer(START_CONTAINER);
  expect(await owner.startUserContainer({ ...input, userId: OTHER })).toEqual({ outcome: 'full' });

  await owner.reconcile();
  daemon.setContainerId(OTHER_ID);
  const result = await owner.startUserContainer({ ...input, userId: OTHER });

  expect(result).toEqual({
    outcome: 'starting',
    containerId: OTHER_ID,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER)).toEqual(
    stoppedRow(),
  );
});

it.each(['last_activity_at', 'last_error', 'password_hash', 'role', 'created_at'])(
  'fences the complete account/row when %s changes during inspection',
  async (field) => {
    const { database, daemon, owner } = await fixture();
    database.exec('UPDATE instances SET dsh_cookie = NULL');
    let updated = false;
    daemon.beforeRequest(({ path }) => {
      if (path !== `/containers/${START_CONTAINER}/json` || updated) return;
      updated = true;
      if (field === 'last_activity_at')
        database.exec('UPDATE instances SET last_activity_at = 303');
      else if (field === 'last_error')
        database.exec("UPDATE instances SET last_error = 'newer diagnostic'");
      else if (field === 'password_hash')
        database.exec("UPDATE users SET password_hash = 'new-hash'");
      else if (field === 'role') database.exec("UPDATE users SET role = 'admin'");
      else database.exec('UPDATE users SET created_at = 2');
    });

    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(reconciliationState(database).audits).toEqual([]);
    expect(database.prepare('SELECT container_id FROM instances').get()).toEqual({
      container_id: START_CONTAINER,
    });
  },
);

it('active cancellation waits for underlying inspection and retains the queue until settlement', async () => {
  const { owner, beforeRequest, daemon, database } = await fixture();
  const gate = startupBarrier();
  let held = false;
  beforeRequest(async (_method, path) => {
    if (path === `/containers/${START_CONTAINER}/json` && !held) {
      held = true;
      await gate.hold();
    }
    return undefined;
  });
  const controller = new AbortController();
  let settled = false;
  const reconciling = owner.reconcile({ signal: controller.signal });
  const observed = reconciling.catch(() => {
    settled = true;
  });
  await gate.reached;
  controller.abort();
  const retirement = owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  gate.release();
  await observed;
  await retirement;

  expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ details: '{"reason":"admin"}' }),
  ]);
});

it('independent corrections settle even when another user fails rather than reporting partial success', async () => {
  const { owner, daemon, database } = await fixture();
  seedReconciliation(database, daemon, OTHER, OTHER_ID);
  daemon.removeContainer(OTHER_ID);
  daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, { status: 403 });

  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(OTHER)).toEqual(
    stoppedRow(OTHER),
  );
  expect(
    database.prepare('SELECT status FROM instances WHERE user_id = ?').get(START_USER),
  ).toEqual({ status: 'running' });
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ target: OTHER, details: '{"reason":"error"}' }),
  ]);
});

it('a pre-canceled request performs no discovery or state changes', async () => {
  const { owner, daemon, database } = await fixture();
  const before = reconciliationState(database);

  await expect(owner.reconcile({ signal: AbortSignal.abort() })).rejects.toThrow(
    'Instance reconciliation failed',
  );

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests).toEqual([]);
});

it('queued cancellation waits for the predecessor and cannot overwrite its retirement', async () => {
  const { owner, beforeRequest, database, daemon } = await fixture();
  const gate = startupBarrier();
  const listed = startupBarrier();
  let blocked = false;
  beforeRequest(async (method, path) => {
    if (method === 'POST' && path.endsWith('/stop?t=1') && !blocked) {
      blocked = true;
      await gate.hold();
    }
    return undefined;
  });
  daemon.beforeRequest(({ path }) => {
    if (path === RECONCILE_LIST) {
      listed.release();
      void listed.hold();
    }
  });
  const retiring = owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await gate.reached;
  const controller = new AbortController();
  const pending = owner.reconcile({ signal: controller.signal });
  let settled = false;
  const observed = pending.catch(() => {
    settled = true;
  });
  await listed.reached;
  // Drain discovery and its scheduling continuation before cancellation.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.release();
  await Promise.all([observed, retiring]);

  expect(settled).toBe(true);
  expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ details: '{"reason":"admin"}' }),
  ]);
});

it('another user can start while reconciliation holds an unrelated user queue', async () => {
  const { owner, beforeRequest, input, daemon, database } = await fixture();
  const gate = startupBarrier();
  let blocked = false;
  beforeRequest(async (_method, path) => {
    if (path === `/containers/${START_CONTAINER}/json` && !blocked) {
      blocked = true;
      await gate.hold();
    }
    return undefined;
  });
  const pending = owner.reconcile();
  await gate.reached;
  daemon.setContainerId(OTHER_ID);
  try {
    expect(await owner.startUserContainer({ ...input, userId: OTHER })).toEqual({
      outcome: 'starting',
      containerId: OTHER_ID,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
  } finally {
    gate.release();
    await pending;
  }

  expect(
    database.prepare('SELECT status FROM instances WHERE user_id = ?').get(START_USER),
  ).toEqual({ status: 'running' });
  expect(reconciliationState(database).audits).toEqual([
    expect.objectContaining({ event_type: 'instance.created', target: OTHER }),
    expect.objectContaining({ event_type: 'instance.started', target: OTHER }),
  ]);
});

it('a changed captured container ID cannot retire a same-name replacement', async () => {
  const { database, daemon, owner } = await fixture();
  database.exec('UPDATE instances SET dsh_cookie = NULL');
  daemon.beforeRequest(({ path }) => {
    if (path === `/containers/${START_CONTAINER}/json`)
      database.prepare('UPDATE instances SET container_id = ?').run(OTHER_ID);
  });

  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(database.prepare('SELECT container_id FROM instances').get()).toEqual({
    container_id: OTHER_ID,
  });
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  expect(reconciliationState(database).audits).toEqual([]);
});

it('permission-denied transport errors remain sanitized and cannot establish absence', async () => {
  const { database } = await fixture();
  const before = reconciliationState(database);
  const owner = createOrchestrator({
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
    client: createDockerClient('/fixture/denied.sock', () => {
      throw Object.assign(new Error('private transport credential'), { code: 'EACCES' });
    }),
  });

  const error: unknown = await owner.reconcile().catch((failure: unknown) => failure);

  expect(String(error)).toBe('Error: Instance reconciliation failed');
  expect(error).not.toHaveProperty('cause');
  expect(reconciliationState(database)).toEqual(before);
});

it('a per-user deadline waits for a stalled boundary to settle before releasing ownership', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { owner, beforeRequest, database } = await fixture();
  const before = reconciliationState(database);
  const gate = startupBarrier();
  beforeRequest(async (_method, path) => {
    if (path === `/containers/${START_CONTAINER}/json`) await gate.hold();
    return undefined;
  });
  let settled = false;
  const pending = owner.reconcile().catch(() => {
    settled = true;
  });
  await gate.reached;

  await vi.advanceTimersByTimeAsync(10_001);
  expect(settled).toBe(false);
  gate.release();
  await pending;

  expect(settled).toBe(true);
  expect(reconciliationState(database)).toEqual(before);
});

it.each(['missing', 'stopped', 'disabled', 'running'])(
  'retires structurally valid expired persisted credentials on %s instances',
  async (kind) => {
    const { database, daemon, owner } = await fixture();
    expireReconciliation(database, daemon, kind);

    await owner.reconcile();
    await owner.reconcile();

    expectReconciliationRetired(database, daemon);
  },
);

it.each(['factory dependencies', 'caller options'])(
  'reconciliation cannot substitute the captured owner through mutated %s',
  async (kind) => {
    const original = await fixture();
    original.daemon.removeContainer(START_CONTAINER);
    const alternate = await startupOwnerFixture();
    roots.push(alternate.root);
    databases.push(alternate.database);
    const dependencies = {
      client: original.client,
      database: original.database,
      config: {
        // Literal mode remains fixed while this test mutates the external dependency references.
        upstreamMode: 'published-loopback' as const,
        platformContainerName: 'dsh-team-platform',
      },
    };
    const owner = createOrchestrator(dependencies);
    const options = { signal: new AbortController().signal };
    if (kind === 'factory dependencies') {
      dependencies.client = alternate.client;
      dependencies.database = alternate.database;
    }
    const provided =
      kind === 'caller options'
        ? { ...options, client: alternate.client, database: alternate.database }
        : options;
    const alternateBefore = reconciliationState(alternate.database);

    await owner.reconcile(provided);

    expect(reconciliationState(original.database).rows).toEqual([stoppedRow()]);
    expect(reconciliationState(original.database).audits).toEqual([
      expect.objectContaining({ event_type: 'instance.stopped', details: '{"reason":"error"}' }),
    ]);
    expect(reconciliationState(alternate.database)).toEqual(alternateBefore);
    expect(alternate.daemon.requests).toEqual([]);
  },
);

it.each(['original', 'replacement'])(
  'a signal replaced during discovery still uses the original cancellation when %s aborts',
  async (aborting) => {
    const { database, owner, beforeRequest } = await fixture();
    database.exec('UPDATE instances SET dsh_cookie = NULL');
    const before = reconciliationState(database);
    const discovery = startupBarrier();
    const inspection = startupBarrier();
    let inspected = false;
    beforeRequest(async (_method, path) => {
      if (path === RECONCILE_LIST) await discovery.hold();
      if (path === `/containers/${START_CONTAINER}/json` && !inspected) {
        inspected = true;
        await inspection.hold();
      }
      return undefined;
    });
    const original = new AbortController();
    const replacement = new AbortController();
    const options = { signal: original.signal };
    let settled = false;
    const pending = owner.reconcile(options).then(
      () => {
        settled = true;
        return 'fulfilled';
      },
      () => {
        settled = true;
        return 'rejected';
      },
    );
    await discovery.reached;
    options.signal = replacement.signal;
    discovery.release();
    await inspection.reached;

    (aborting === 'original' ? original : replacement).abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    inspection.release();
    const outcome = await pending;

    if (aborting === 'original') {
      expect(outcome).toBe('rejected');
      expect(reconciliationState(database)).toEqual(before);
    } else {
      expect(outcome).toBe('fulfilled');
      expect(reconciliationState(database).rows).toEqual([stoppedRow()]);
      expect(reconciliationState(database).audits).toEqual([
        expect.objectContaining({ event_type: 'instance.stopped', details: '{"reason":"error"}' }),
      ]);
    }
  },
);

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
  START_CONTAINER,
  START_USER,
} from './container-start-fixture.ts';
import {
  RECONCILE_LIST,
  seedReconciliation,
  reconciliationState,
  stoppedRow,
  expectReconciliationRejected,
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
  owner = createOrchestrator({ client: createDockerClient(socket), database });
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
  const replacement = { ...original, Id: replacementId };
  daemon.containers.clear();
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
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
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
    bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 32),
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
  });

  await reconstructed.reconcile();
  await reconstructed.reconcile();

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

it('discovers and removes a physically stopped owned container without volume deletion', async () => {
  const container = daemon.containers.get(START_CONTAINER);
  if (container === undefined) throw new Error('Missing fixture');
  container.State.Running = false;

  await owner.reconcile();

  expect(daemon.requests[0]).toEqual({ method: 'GET', path: RECONCILE_LIST, body: {} });
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'DELETE', path: `/containers/${START_CONTAINER}`, body: {} },
  ]);
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

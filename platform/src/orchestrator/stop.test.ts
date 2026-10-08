import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, stopUserContainer } from './index.ts';
import type { StopUserContainerInput } from './index.ts';
import {
  startupDaemon,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from '../../test/container-start-fixture.ts';

// SQLite is a system boundary here; real state, transactions and audit proof live in integration.
function fixture(account: unknown) {
  const daemon = startupDaemon();
  const database = {
    prepare: () => ({ get: () => account }),
  } as unknown as DatabaseHandle;
  const input: StopUserContainerInput = {
    database,
    client: createDockerClient('/fixture/docker.sock', daemon.transport),
    userId: START_USER,
    reason: 'admin',
  };
  return { daemon, input };
}

const databases: DatabaseHandle[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

/** Match readiness's in-memory SQLite unit seam; file durability stays in Unix integration. */
function indexedFixture() {
  const database = openDatabase(':memory:');
  databases.push(database);
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'employee@example.test', 'unused', 'employee', 'active', 1)",
    )
    .run(START_USER);
  database
    .prepare(
      `INSERT INTO instances (user_id, status, container_id, image_id, image_tag,
    upstream_host, upstream_port, dsh_cookie, last_started_at, last_activity_at, last_error)
    VALUES (?, 'running', ?, ?, 'image:test', '127.0.0.1', 49173, 'private-cookie', 101, 202, 'old error')`,
    )
    .run(START_USER, START_CONTAINER, START_IMAGE);
  const daemon = startupDaemon();
  const container = {
    Id: START_CONTAINER,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: {} },
  };
  daemon.containers.set(START_CONTAINER, container);
  const input: StopUserContainerInput = {
    client: createDockerClient('/fixture/docker.sock', daemon.transport),
    database,
    userId: START_USER,
    reason: 'admin',
  };
  return { input, database, daemon, container };
}

it.each(['', 'Admin', 'toString', '__proto__', 'idle-admin', null, 1, {}, ['idle']])(
  'rejects caller reason %j before any Docker mutation',
  async (reason) => {
    const { daemon, input } = fixture({ container_id: 'b'.repeat(64) });

    // Exercise untyped caller input at the public boundary rather than changing the API's safe type.
    await expect(
      stopUserContainer({ ...input, reason } as unknown as StopUserContainerInput),
    ).rejects.toThrow('User container retirement failed');

    expect(daemon.requests).toEqual([]);
  },
);

it.each([
  undefined,
  null,
  {},
  { container_id: '../other' },
  { container_id: 'b'.repeat(64), image_id: 'mutable-image' },
  { container_id: START_CONTAINER, image_id: START_IMAGE, email: 1 },
])(
  'rejects unavailable or malformed indexed identities without touching Docker',
  async (account) => {
    const { daemon, input } = fixture(account);

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(daemon.requests).toEqual([]);
  },
);

it('rejects a malformed user identity without looking up or stopping a reusable name', async () => {
  const { daemon, input } = fixture({});

  await expect(stopUserContainer({ ...input, userId: '../other' })).rejects.toThrow(
    'User container retirement failed',
  );

  expect(daemon.requests).toEqual([]);
});

function expectIndexPreserved(database: DatabaseHandle, expected: unknown): void {
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(expected);
  expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
}

function expectRetiredOnce(database: DatabaseHandle): void {
  expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
    status: 'stopped',
    container_id: null,
  });
  expect(database.prepare('SELECT details FROM audit_events').all()).toEqual([
    { details: '{"reason":"admin"}' },
  ]);
}

it('retires a disabled instance exactly once with captured caller reason and intact historical diagnostics', async () => {
  const { input, database, daemon } = indexedFixture();
  database.prepare("UPDATE users SET status = 'disabled'").run();
  const operation = { ...input };
  daemon.beforeRequest(() => {
    operation.reason = 'error';
  });

  await stopUserContainer(operation);
  await stopUserContainer(input);

  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT * FROM instances').get()).toEqual({
    user_id: START_USER,
    status: 'stopped',
    container_id: null,
    image_id: null,
    image_tag: null,
    upstream_host: null,
    upstream_port: null,
    dsh_cookie: null,
    last_started_at: 101,
    last_activity_at: 202,
    last_error: 'old error',
  });
  expect(
    database.prepare('SELECT event_type, target, target_email, details FROM audit_events').all(),
  ).toEqual([
    {
      event_type: 'instance.stopped',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{"reason":"admin"}',
    },
  ]);
});

it('reconciles an absent immutable ID without stopping the foreign same-name container', async () => {
  const { input, database, daemon, container } = indexedFixture();
  daemon.containers.delete(START_CONTAINER);
  const otherId = 'd'.repeat(64);
  const foreign = {
    ...container,
    Id: otherId,
    Config: { Labels: { 'dsh-team.user': 'otheruser123' } },
  };
  daemon.containers.set(otherId, foreign);

  await stopUserContainer(input);

  expect(daemon.containers.get(otherId)).toEqual(foreign);
  expect(foreign.State.Running).toBe(true);
  expectRetiredOnce(database);
});

it('removes an indexed already-stopped container rather than mistaking it for a retired no-op', async () => {
  const { input, database, container, daemon } = indexedFixture();
  container.State.Running = false;
  database.prepare("UPDATE instances SET status = 'stopped'").run();

  await stopUserContainer(input);

  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'stopped',
    last_error: 'old error',
  });
  expect(database.prepare('SELECT details FROM audit_events').all()).toEqual([
    { details: '{"reason":"admin"}' },
  ]);
});

it.each([304, 404])(
  'reobserves exact identity after concurrent daemon stop response %s',
  async (status) => {
    const { input, database, daemon, container } = indexedFixture();
    daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status });
    daemon.beforeRequest((request) => {
      if (request.method !== 'POST') return;
      if (status === 404) daemon.containers.delete(START_CONTAINER);
      else container.State.Running = false;
    });

    await stopUserContainer(input);

    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expectRetiredOnce(database);
  },
);

it.each([
  ['stop denied', 'POST', 500],
  ['still running', 'POST', 204],
  ['delete denied', 'DELETE', 500],
  ['delete ineffective', 'DELETE', 204],
] as const)(
  'preserves retryable index and never falsely retires after %s',
  async (_case, method, status) => {
    const { input, database, daemon } = indexedFixture();
    const before = database.prepare('SELECT * FROM instances').get();
    const path =
      method === 'POST'
        ? `/containers/${START_CONTAINER}/stop?t=1`
        : `/containers/${START_CONTAINER}`;
    daemon.overrides.set(`${method} ${path}`, { status });

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expectIndexPreserved(database, before);
    expect(daemon.containers.has(START_CONTAINER)).toBe(true);
  },
);

it('confirms exact absence after a deletion 404 before committing retirement', async () => {
  const { input, database, daemon } = indexedFixture();
  daemon.beforeRequest((request) => {
    if (request.method === 'DELETE') daemon.containers.delete(START_CONTAINER);
  });

  await stopUserContainer(input);

  expectRetiredOnce(database);
});

it('does not interpret a permission-denied inspection as absence', async () => {
  const { input, database, daemon } = indexedFixture();
  const before = database.prepare('SELECT * FROM instances').get();
  daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, { status: 403 });

  await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

  expectIndexPreserved(database, before);
  expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
});

it.each(['before stop', 'before delete', 'before commit'] as const)(
  'keeps a newly indexed replacement untouched when current identity changes %s',
  async (stage) => {
    const { input, database, daemon, container } = indexedFixture();
    const replacementId = 'd'.repeat(64);
    let inspections = 0;
    let replacement: unknown;
    daemon.beforeRequest((request) => {
      if (request.method !== 'GET') return;
      inspections += 1;
      const target = stage === 'before stop' ? 1 : stage === 'before delete' ? 2 : 3;
      if (inspections !== target) return;
      database
        .prepare('UPDATE instances SET container_id = ?, dsh_cookie = ?, last_started_at = 303')
        .run(replacementId, 'replacement-cookie');
      replacement = database.prepare('SELECT * FROM instances').get();
      daemon.containers.set(replacementId, {
        ...container,
        Id: replacementId,
        State: { Running: true },
      });
    });

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expectIndexPreserved(database, replacement);
    expect(daemon.containers.get(replacementId)?.State.Running).toBe(true);
  },
);

it.each(['state rejection', 'audit rejection', 'ignored state update'] as const)(
  'rolls back %s after actual Docker removal and completes the exact absent-ID retry once',
  async (failure) => {
    const { input, database, daemon } = indexedFixture();
    const before = database.prepare('SELECT * FROM instances').get();
    const trigger =
      failure === 'audit rejection'
        ? "BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private database failure'); END"
        : failure === 'ignored state update'
          ? 'BEFORE UPDATE ON instances BEGIN SELECT RAISE(IGNORE); END'
          : "BEFORE UPDATE ON instances BEGIN SELECT RAISE(ABORT, 'private database failure'); END";
    database.exec(`CREATE TRIGGER reject_retirement ${trigger}`);

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expectIndexPreserved(database, before);
    database.exec('DROP TRIGGER reject_retirement');
    await stopUserContainer(input);
    await stopUserContainer(input);
    expectRetiredOnce(database);
  },
);

it('cancels after actual removal without committing stopped, then reconciles truthfully on retry', async () => {
  const { input, database, daemon } = indexedFixture();
  const before = database.prepare('SELECT * FROM instances').get();
  const controller = new AbortController();
  daemon.beforeRequest((request) => {
    if (request.method === 'DELETE') controller.abort();
  });

  await expect(stopUserContainer({ ...input, signal: controller.signal })).rejects.toThrow(
    'User container retirement failed',
  );

  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expectIndexPreserved(database, before);
  daemon.beforeRequest(() => undefined);
  await stopUserContainer(input);
  expectRetiredOnce(database);
});

it('bounds a silent external Docker transport without discarding retryable identity', async () => {
  const { input, database, daemon } = indexedFixture();
  const before = database.prepare('SELECT * FROM instances').get();
  const reached = Promise.withResolvers<undefined>();
  const client = createDockerClient(
    '/fixture/docker.sock',
    () =>
      new Writable({
        final(done) {
          reached.resolve(undefined);
          done();
        },
      }),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const result = stopUserContainer({ ...input, client }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await reached.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  const error = await result;
  vi.useRealTimers();

  expect(error instanceof Error && error.message).toBe('User container retirement failed');
  expectIndexPreserved(database, before);
  expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
});

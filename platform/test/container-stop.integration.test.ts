import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, stopUserContainer } from '../src/orchestrator/index.ts';
import type { StopUserContainerInput } from '../src/orchestrator/index.ts';
import {
  startupDaemon,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from './container-start-fixture.ts';

let root: string;
let database: DatabaseHandle;
let input: StopUserContainerInput;
let daemon = startupDaemon();
let stalledPath: string | undefined;
let onStall: (() => void) | undefined;
const server = createServer((request, response) => {
  if (request.url === stalledPath) {
    onStall?.();
    return;
  }
  try {
    const reply = daemon.reply({ method: request.method ?? '', path: request.url ?? '', body: {} });
    response
      .writeHead(reply.status)
      .end(reply.document === undefined ? '' : JSON.stringify(reply.document));
  } catch {
    response.writeHead(500).end();
  }
});

beforeEach(async () => {
  stalledPath = undefined;
  onStall = undefined;
  root = await mkdtemp(join(tmpdir(), 'dsh-stop-wire-'));
  database = openDatabase(join(root, 'platform.db'));
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
    VALUES (?, 'running', ?, ?, 'dsh-team-user:local', '127.0.0.1', 49173, 'private-cookie', 101, 202, 'historical diagnostic')`,
    )
    .run(START_USER, START_CONTAINER, START_IMAGE);
  daemon = startupDaemon();
  daemon.containers.set(START_CONTAINER, {
    Id: START_CONTAINER,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: {} },
  });
  const socket = join(root, 'engine.sock');
  server.listen(socket);
  await once(server, 'listening');
  input = { client: createDockerClient(socket), database, userId: START_USER, reason: 'admin' };
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

function row() {
  return database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
}
function audits() {
  return database
    .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
    .all();
}
function writes() {
  return daemon.requests.filter((request) => request.method !== 'GET');
}

function expectIndexUnchanged(expected: unknown): void {
  expect(row()).toEqual(expected);
  expect(audits()).toEqual([]);
}

function expectRetirementRecorded(reason: StopUserContainerInput['reason'] = 'admin'): void {
  expect(row()).toMatchObject({ status: 'stopped', container_id: null });
  expect(audits()).toEqual([
    {
      event_type: 'instance.stopped',
      target: START_USER,
      target_email: 'employee@example.test',
      details: JSON.stringify({ reason }),
    },
  ]);
}

it('retires the captured container after stopping it, retaining history and recording the caller reason atomically', async () => {
  const observations: unknown[] = [];
  const before = row();
  daemon.beforeRequest((request) => {
    if (request.method === 'DELETE')
      observations.push({
        running: daemon.containers.get(START_CONTAINER)?.State.Running,
        row: row(),
        audits: audits(),
      });
  });

  await stopUserContainer(input);

  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(writes().map(({ method, path }) => ({ method, path }))).toEqual([
    { method: 'POST', path: `/containers/${START_CONTAINER}/stop?t=1` },
    { method: 'DELETE', path: `/containers/${START_CONTAINER}` },
  ]);
  expect(observations).toEqual([
    {
      running: false,
      row: before,
      audits: [],
    },
  ]);
  expect(row()).toEqual({
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
    last_error: 'historical diagnostic',
  });
  expect(audits()).toEqual([
    {
      event_type: 'instance.stopped',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{"reason":"admin"}',
    },
  ]);
});

it.each(['idle', 'admin', 'disabled', 'error'] as const)(
  'allows disabled-account retirement and records exactly the supplied %s reason once',
  async (reason) => {
    database.prepare("UPDATE users SET status = 'disabled'").run();
    const before = row();

    await stopUserContainer({ ...input, reason });
    const requests = [...daemon.requests];
    await stopUserContainer({ ...input, reason });

    expect(before).toMatchObject({
      last_started_at: 101,
      last_activity_at: 202,
      last_error: 'historical diagnostic',
    });
    expectRetirementRecorded(reason);
    expect(daemon.requests).toEqual(requests);
  },
);

it('finishes an exact already-absent retirement without deleting a same-name replacement', async () => {
  daemon.containers.delete(START_CONTAINER);
  const otherId = 'd'.repeat(64);
  daemon.containers.set(otherId, {
    Id: otherId,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: {} },
  });

  await stopUserContainer(input);

  expect(writes()).toEqual([]);
  expect(daemon.containers.get(otherId)?.State.Running).toBe(true);
  expectRetirementRecorded();
});

it('deletes an already-stopped owned container without another stop request', async () => {
  const container = daemon.containers.get(START_CONTAINER);
  if (container === undefined) throw new Error('Missing owned fixture');
  container.State.Running = false;
  database.prepare("UPDATE instances SET status = 'error'").run();

  await stopUserContainer(input);

  expect(writes().map(({ method, path }) => ({ method, path }))).toEqual([
    { method: 'DELETE', path: `/containers/${START_CONTAINER}` },
  ]);
  expect(row()).toMatchObject({ status: 'stopped', last_error: 'historical diagnostic' });
});

it.each([
  ['wrong ID', { Id: 'd'.repeat(64) }],
  ['wrong name', { Name: '/dsh-team-u-foreignuser1' }],
  ['wrong image', { Image: `sha256:${'e'.repeat(64)}` }],
  ['wrong user label', { Config: { Labels: { 'dsh-team.user': 'foreignuser1' } } }],
  ['missing running state', { State: {} }],
  ['ambiguous running state', { State: { Running: 'false' } }],
] as const)('refuses %s inspection before stop or delete', async (_case, invalid) => {
  const before = row();
  daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, {
    status: 200,
    document: { ...daemon.containers.get(START_CONTAINER), ...invalid },
  });

  await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

  expect(writes()).toEqual([]);
  expectIndexUnchanged(before);
});

it.each([401, 403, 500, 503, 200])(
  'does not confuse Docker inspection response %s with captured-ID absence',
  async (status) => {
    const before = row();
    daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, {
      status,
      document: { message: 'not found' },
    });

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(writes()).toEqual([]);
    expectIndexUnchanged(before);
  },
);

it.each(['stop denied', 'still running', 'delete denied', 'delete not removed'] as const)(
  'keeps indexed identity and history retryable after %s without falsely auditing stopped',
  async (failure) => {
    const before = row();
    const method = failure.startsWith('delete') ? 'DELETE' : 'POST';
    const path = failure.startsWith('delete')
      ? `/containers/${START_CONTAINER}`
      : `/containers/${START_CONTAINER}/stop?t=1`;
    daemon.overrides.set(`${method} ${path}`, { status: failure.endsWith('denied') ? 500 : 204 });

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expectIndexUnchanged(before);
    expect(daemon.containers.has(START_CONTAINER)).toBe(true);
    expect(
      writes().every(
        (request) => !/[?&](force|v)=/.test(request.path) && !request.path.startsWith('/volumes/'),
      ),
    ).toBe(true);
    if (method === 'POST')
      expect(writes().some((request) => request.method === 'DELETE')).toBe(false);
    daemon.overrides.clear();
    await stopUserContainer(input);
    expect(row()).toMatchObject({ status: 'stopped', container_id: null });
    expect(audits()).toHaveLength(1);
  },
);

it.each(['state update', 'audit insert'])(
  'rolls back %s failure after actual removal and reconciles the captured 404 once on retry',
  async (failure) => {
    const before = row();
    database.exec(
      failure === 'state update'
        ? "CREATE TRIGGER reject_retirement BEFORE UPDATE ON instances BEGIN SELECT RAISE(ABORT, 'private failure'); END"
        : "CREATE TRIGGER reject_retirement BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'private failure'); END",
    );

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expectIndexUnchanged(before);
    const deleted = writes().filter((request) => request.method === 'DELETE');
    expect(deleted).toHaveLength(1);
    database.exec('DROP TRIGGER reject_retirement');
    await stopUserContainer(input);
    await stopUserContainer(input);
    expect(writes().filter((request) => request.method === 'DELETE')).toEqual(deleted);
    expectRetirementRecorded();
  },
);

it.each(['initial inspect', 'stopped verify', 'delete', 'removed verify'] as const)(
  'never deletes or overwrites a replacement indexed during %s',
  async (stage) => {
    const replacementId = 'd'.repeat(64);
    let inspections = 0;
    let replaced = false;
    let replacement: unknown;
    daemon.beforeRequest((request) => {
      if (request.path === `/containers/${START_CONTAINER}/json`) inspections += 1;
      const trigger =
        stage === 'delete'
          ? request.method === 'DELETE'
          : inspections === (stage === 'initial inspect' ? 1 : stage === 'stopped verify' ? 2 : 3);
      if (!trigger || replaced) return;
      replaced = true;
      database
        .prepare('UPDATE instances SET container_id = ?, dsh_cookie = ?, last_started_at = ?')
        .run(replacementId, 'replacement-cookie', 303);
      replacement = row();
      daemon.containers.set(replacementId, {
        Id: replacementId,
        Name: `/dsh-team-u-${START_USER}`,
        Image: START_IMAGE,
        Config: { Labels: { 'dsh-team.user': START_USER } },
        State: { Running: true },
        NetworkSettings: { Ports: {} },
      });
    });

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(replaced).toBe(true);
    expectIndexUnchanged(replacement);
    expect(daemon.containers.get(replacementId)?.State.Running).toBe(true);
    expect(writes().every((request) => request.path.includes(START_CONTAINER))).toBe(true);
    if (stage === 'initial inspect') expect(writes()).toEqual([]);
    if (stage === 'stopped verify')
      expect(writes().some((request) => request.method === 'DELETE')).toBe(false);
  },
);

it.each([
  'email',
  'account status',
  'image ID',
  'image tag',
  'instance status',
  'endpoint',
  'cookie',
  'start time',
] as const)('fences a concurrent change to %s before the stop write', async (field) => {
  let replacement: unknown;
  daemon.beforeRequest((request) => {
    if (request.method !== 'GET' || replacement !== undefined) return;
    const changes = {
      email: "UPDATE users SET email = 'changed@example.test'",
      'account status': "UPDATE users SET status = 'disabled'",
      'image ID': `UPDATE instances SET image_id = 'sha256:${'e'.repeat(64)}'`,
      'image tag': "UPDATE instances SET image_tag = 'changed:tag'",
      'instance status': "UPDATE instances SET status = 'starting'",
      endpoint: 'UPDATE instances SET upstream_port = 49174',
      cookie: "UPDATE instances SET dsh_cookie = 'new-private-cookie'",
      'start time': 'UPDATE instances SET last_started_at = 404',
    };
    database.exec(changes[field]);
    replacement = row();
  });

  await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

  expectIndexUnchanged(replacement);
  expect(writes()).toEqual([]);
});

it.each(['before selection', 'stop', 'delete', 'removed verify'] as const)(
  'returns cancellation at %s without claiming retirement and permits a truthful retry',
  async (stage) => {
    const before = row();
    const controller = new AbortController();
    let inspections = 0;
    if (stage === 'before selection') controller.abort();
    daemon.beforeRequest((request) => {
      if (request.method === 'GET') inspections += 1;
      if (
        (stage === 'stop' && request.method === 'POST') ||
        (stage === 'delete' && request.method === 'DELETE') ||
        (stage === 'removed verify' && inspections === 3)
      )
        controller.abort();
    });

    await expect(stopUserContainer({ ...input, signal: controller.signal })).rejects.toThrow(
      'User container retirement failed',
    );

    expectIndexUnchanged(before);
    daemon.beforeRequest(() => undefined);
    await stopUserContainer(input);
    expect(row()).toMatchObject({ status: 'stopped', container_id: null });
    expect(audits()).toHaveLength(1);
  },
);

it.each(['missing instance', 'missing account'])(
  'rejects %s before any Docker write',
  async (missing) => {
    database.exec('DELETE FROM instances');
    if (missing === 'missing account') database.exec('DELETE FROM users');

    await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

    expect(daemon.requests).toEqual([]);
    expect(audits()).toEqual([]);
  },
);

it.each(['stop', 'delete'] as const)(
  'completes exact-ID disappearance during %s without targeting any reusable name',
  async (stage) => {
    daemon.beforeRequest((request) => {
      if (request.method === (stage === 'stop' ? 'POST' : 'DELETE'))
        daemon.containers.delete(START_CONTAINER);
    });

    await stopUserContainer(input);

    expectRetirementRecorded();
    expect(writes().every((request) => request.path.includes(START_CONTAINER))).toBe(true);
  },
);

it('accepts an already-stopped daemon response only after independently observing stopped state', async () => {
  daemon.beforeRequest((request) => {
    if (request.method !== 'POST') return;
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing fixture container');
    container.State.Running = false;
  });
  daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 304 });

  await stopUserContainer(input);

  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(row()).toMatchObject({ status: 'stopped', container_id: null });
  expect(audits()).toHaveLength(1);
});

it('refuses changed ownership discovered after stopping instead of deleting the foreign image', async () => {
  const before = row();
  daemon.beforeRequest((request) => {
    if (request.method !== 'POST') return;
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing fixture container');
    container.Image = `sha256:${'f'.repeat(64)}`;
  });

  await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

  expect(writes().some((request) => request.method === 'DELETE')).toBe(false);
  expectIndexUnchanged(before);
});

it.each(['initial inspect', 'stop', 'stopped verify', 'delete', 'removed verify'] as const)(
  'bounds a hung Unix Docker %s request and retains truthful state for retry',
  async (stage) => {
    const before = row();
    const reached = new Promise<void>((resolve) => {
      onStall = resolve;
    });
    if (stage === 'initial inspect') stalledPath = `/containers/${START_CONTAINER}/json`;
    if (stage === 'stop') stalledPath = `/containers/${START_CONTAINER}/stop?t=1`;
    if (stage === 'delete') stalledPath = `/containers/${START_CONTAINER}`;
    daemon.beforeRequest((request) => {
      if (
        (stage === 'stopped verify' && request.method === 'POST') ||
        (stage === 'removed verify' && request.method === 'DELETE')
      )
        stalledPath = `/containers/${START_CONTAINER}/json`;
    });
    // Only production's deadline clock is controlled; HTTP/Unix socket I/O remains real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const result = stopUserContainer(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    await reached;
    await vi.advanceTimersByTimeAsync(10_000);
    const failure = await result;
    vi.useRealTimers();

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe('User container retirement failed');
    expectIndexUnchanged(before);
    stalledPath = undefined;
    daemon.beforeRequest(() => undefined);
    await stopUserContainer(input);
    expect(row()).toMatchObject({ status: 'stopped', container_id: null });
    expect(audits()).toHaveLength(1);
  },
);

it('rejects an untyped invalid reason before Docker work or any persistent state/audit write', async () => {
  const before = row();

  // The invalid caller value deliberately crosses the public runtime boundary.
  await expect(
    stopUserContainer({
      ...input,
      reason: 'force-and-delete-volumes',
    } as unknown as StopUserContainerInput),
  ).rejects.toThrow('User container retirement failed');

  expect(daemon.requests).toEqual([]);
  expectIndexUnchanged(before);
});

it('rejects an empty successful inspection instead of treating it as container absence', async () => {
  const before = row();
  daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, { status: 204 });

  await expect(stopUserContainer(input)).rejects.toThrow('User container retirement failed');

  expect(writes()).toEqual([]);
  expectIndexUnchanged(before);
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, createOrchestrator } from './index.ts';
import type {
  AcquireDshCookieInput,
  OrchestratorDependencies,
  StartResult,
  StartUserContainerInput,
} from './index.ts';
import {
  expectDockerReads,
  startupEvidence,
  startupDaemon,
  START_CONTAINER,
  START_IMAGE,
  START_MODEL,
  START_PERMISSION,
  START_USER,
} from '../../test/container-start-fixture.ts';

const OTHER_USER = 'mnopqrstuvwx';
const NEXT_CONTAINER = 'd'.repeat(64);
const roots: string[] = [];
const databases: DatabaseHandle[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-'));
  roots.push(root);
  const database = openDatabase(':memory:');
  databases.push(database);
  applyMigrations(database);
  for (const user of [START_USER, OTHER_USER]) {
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(user, `${user}@example.test`);
  }
  const seccompProfilePath = join(root, 'seccomp.json');
  await writeFile(seccompProfilePath, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
  const daemon = startupDaemon();
  const raw = createDockerClient('/fixture/docker.sock', daemon.transport);
  let before:
    ((method: string, path: string, signal?: AbortSignal) => Promise<undefined>) | undefined;
  const client: OrchestratorDependencies['client'] = {
    ...raw,
    async json(method, path, body, signal) {
      await before?.(method, path, signal);
      return raw.json(method, path, body, signal);
    },
  };
  const owner = createOrchestrator({ client, database });
  const input: StartUserContainerInput = {
    userId: START_USER,
    config: {
      userImage: 'dsh-team-user:local',
      seccompProfilePath,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
    },
    modelSettings: START_MODEL,
    modelKey: 'fixture-private-key',
    permission: START_PERMISSION,
  };
  return {
    root,
    database,
    daemon,
    client,
    owner,
    input,
    beforeRequest: (callback: typeof before) => {
      before = callback;
    },
    blockStartup: async () => {
      const gate = barrier();
      before = async (method, path) => {
        if (method === 'POST' && path === createPath()) await gate.hold();
        return undefined;
      };
      const first = owner.startUserContainer(input);
      const head = Promise.allSettled([first]);
      await gate.reached;
      return { gate, first, head };
    },
  };
}

function createPath(user = START_USER): string {
  return `/containers/create?name=dsh-team-u-${user}`;
}

function barrier() {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  return {
    reached: reached.promise,
    release() {
      release.resolve(undefined);
    },
    async hold(): Promise<undefined> {
      reached.resolve(undefined);
      await release.promise;
      return undefined;
    },
  };
}

const STARTED: StartResult = {
  outcome: 'starting',
  containerId: START_CONTAINER,
  upstreamHost: '127.0.0.1',
  upstreamPort: 49173,
};

it('ten same-user starts share one created identity and one creation/start audit pair', async () => {
  const { owner, input, daemon, database, blockStartup } = await fixture();
  const { gate, first, head } = await blockStartup();
  const pending = [first];
  for (let index = 1; index < 10; index += 1) pending.push(owner.startUserContainer(input));
  const completed = Promise.allSettled(pending);
  gate.release();
  await head;

  expect(await completed).toEqual(
    Array.from({ length: 10 }, () => ({ status: 'fulfilled', value: STARTED })),
  );
  expect(
    daemon.requests.filter((request) => request.method === 'POST' && request.path === createPath()),
  ).toHaveLength(1);
  expect(database.prepare('SELECT event_type, target FROM audit_events ORDER BY id').all()).toEqual(
    [
      { event_type: 'instance.created', target: START_USER },
      { event_type: 'instance.started', target: START_USER },
    ],
  );
  expect(
    database
      .prepare('SELECT status, container_id, upstream_host, upstream_port FROM instances')
      .get(),
  ).toEqual({
    status: 'starting',
    container_id: START_CONTAINER,
    upstream_host: '127.0.0.1',
    upstream_port: 49173,
  });
});

it('another user completes while the first user still owns a blocked startup', async () => {
  const { owner, input, blockStartup, database, daemon } = await fixture();
  const { gate, head } = await blockStartup();
  daemon.beforeRequest((request) => {
    if (request.method === 'POST' && request.path === createPath(OTHER_USER))
      daemon.setContainerId(NEXT_CONTAINER);
    if (request.method === 'POST' && request.path === createPath())
      daemon.setContainerId(START_CONTAINER);
  });
  try {
    expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
      ...STARTED,
      containerId: NEXT_CONTAINER,
    });
    expect(database.prepare('SELECT user_id FROM instances').all()).toEqual([
      { user_id: OTHER_USER },
    ]);
  } finally {
    gate.release();
    await head;
  }
  expect(
    database.prepare('SELECT container_id FROM instances WHERE user_id = ?').get(OTHER_USER),
  ).toEqual({
    container_id: NEXT_CONTAINER,
  });
  expect(daemon.containers.get(NEXT_CONTAINER)?.Config.Labels).toEqual({
    'dsh-team.user': OTHER_USER,
  });
});

it('start then retirement then start executes FIFO and leaves a new final identity', async () => {
  const { owner, input, daemon, database, blockStartup } = await fixture();
  const { gate, first } = await blockStartup();
  const retired = owner.stopUserContainer({ userId: START_USER, reason: 'idle' });
  const recreated = owner.startUserContainer(input);
  const completed = Promise.allSettled([first, retired, recreated]);
  daemon.beforeRequest((request) => {
    if (
      request.path === createPath() &&
      daemon.requests.filter((item) => item.path === createPath()).length === 2
    )
      daemon.setContainerId(NEXT_CONTAINER);
  });
  gate.release();

  expect(await completed).toEqual([
    { status: 'fulfilled', value: STARTED },
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: { ...STARTED, containerId: NEXT_CONTAINER } },
  ]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
    status: 'starting',
    container_id: NEXT_CONTAINER,
  });
  expect(
    database.prepare('SELECT event_type, details FROM audit_events ORDER BY id').all(),
  ).toEqual([
    { event_type: 'instance.created', details: '{}' },
    { event_type: 'instance.started', details: '{}' },
    { event_type: 'instance.stopped', details: '{"reason":"idle"}' },
    { event_type: 'instance.created', details: '{}' },
    { event_type: 'instance.started', details: '{}' },
  ]);
});

it('a rejected head does not poison its queued successor', async () => {
  const { owner, input, beforeRequest } = await fixture();
  const gate = barrier();
  let calls = 0;
  beforeRequest(async (_method, path) => {
    if (path === `/containers/dsh-team-u-${START_USER}/json` && calls++ === 0) {
      await gate.hold();
      throw new Error('external credential-bearing failure');
    }
    return undefined;
  });
  const first = owner.startUserContainer(input);
  const head = Promise.allSettled([first]);
  await gate.reached;
  const second = owner.startUserContainer(input);
  gate.release();
  expect(await head).toMatchObject([
    {
      status: 'rejected',
      reason: { message: 'Container startup failed during container conflict check' },
    },
  ]);
  expect(await second).toEqual(STARTED);
});

it('queued cancellation settles without mutations and preserves its successor order', async () => {
  const { owner, input, daemon, database, blockStartup } = await fixture();
  const { gate, head } = await blockStartup();
  const controller = new AbortController();
  const canceled = owner.stopUserContainer({
    userId: START_USER,
    reason: 'admin',
    signal: controller.signal,
  });
  const observed = canceled.catch((error: unknown) => error);
  const successor = owner.startUserContainer(input);
  const before = [...daemon.requests];
  controller.abort('private abort reason');
  expect(await observed).toEqual(new Error('User container retirement failed'));
  expect(daemon.requests).toEqual(before);
  gate.release();
  await head;
  expect(await successor).toEqual(STARTED);
  expect(
    daemon.requests.some(
      (request) => request.method === 'DELETE' && request.path === `/containers/${START_CONTAINER}`,
    ),
  ).toBe(false);
  expect(
    database
      .prepare("SELECT event_type FROM audit_events WHERE event_type = 'instance.stopped'")
      .all(),
  ).toEqual([]);
});

it('active cancellation retains user ownership until external cleanup actually settles', async () => {
  const { owner, input, beforeRequest, daemon } = await fixture();
  const gate = barrier();
  const canceled = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  beforeRequest(async (_method, path, signal) => {
    if (path === `/containers/${'c'.repeat(64)}/wait?condition=not-running`) {
      signal?.addEventListener(
        'abort',
        () => {
          canceled.resolve(undefined);
        },
        { once: true },
      );
      await gate.hold();
    }
    return undefined;
  });
  const first = owner.startUserContainer({ ...input, signal: controller.signal });
  const failed = first.catch((error: unknown) => error);
  await gate.reached;
  controller.abort('private abort reason');
  await canceled.promise;
  const queued = owner.startUserContainer({ ...input, modelKey: '' });
  let finished = false;
  const successor = queued.then((result) => {
    finished = true;
    return result;
  });
  await owner.startUserContainer({ ...input, userId: OTHER_USER, modelKey: '' });
  expect(finished).toBe(false);
  expect(daemon.requests.some((request) => request.path === createPath())).toBe(false);
  gate.release();
  expect(await failed).toEqual(new Error('Container startup failed during managed composition'));
  expect(await successor).toEqual({ outcome: 'unconfigured' });
});

it('captures the scheduling key and signal even if the caller mutates its request', async () => {
  const { owner, input, blockStartup, database } = await fixture();
  const { gate, head } = await blockStartup();
  const controller = new AbortController();
  const request = { ...input, signal: controller.signal };
  const canceled = owner.startUserContainer(request).catch((error: unknown) => error);
  request.userId = OTHER_USER;
  request.signal = new AbortController().signal;
  controller.abort('private reason');
  expect(await canceled).toEqual(
    new Error('Container startup failed during account validation or cancellation'),
  );
  const moved = { ...input };
  const sameUser = owner.startUserContainer(moved);
  moved.userId = OTHER_USER;
  gate.release();
  await head;
  expect(await sameUser).toEqual(STARTED);
  expect(database.prepare('SELECT user_id FROM instances').all()).toEqual([
    { user_id: START_USER },
  ]);
});

it('independent owners never share a hidden same-user queue', async () => {
  const firstContext = await fixture();
  const secondContext = await fixture();
  const { gate, head } = await firstContext.blockStartup();
  try {
    expect(await secondContext.owner.startUserContainer(secondContext.input)).toEqual(STARTED);
    expect(firstContext.database.prepare('SELECT * FROM instances').all()).toEqual([]);
  } finally {
    gate.release();
    await head;
  }
});

it.each(['starting', 'running'] as const)(
  'validated %s reuse preserves the complete row, cookie, overlay inode and audit pair',
  async (status) => {
    const { owner, input, database, daemon } = await fixture();
    await owner.startUserContainer(input);
    database
      .prepare(
        'UPDATE instances SET status = ?, dsh_cookie = ?, last_activity_at = 123, last_error = ?',
      )
      .run(status, 'private-cookie', 'history');
    const before = await startupEvidence(database, input);
    const requests = daemon.requests.length;

    expect(await owner.startUserContainer(input)).toEqual({ ...STARTED, outcome: status });
    expect(await startupEvidence(database, input)).toEqual(before);
    expectDockerReads(daemon.requests, requests, `/containers/${START_CONTAINER}/json`);
  },
);

it('every completed call rechecks account eligibility and the exact supplied model credential', async () => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  const before = database.prepare('SELECT * FROM instances').get();
  const requests = [...daemon.requests];
  expect(await owner.startUserContainer({ ...input, modelKey: '' })).toEqual({
    outcome: 'unconfigured',
  });
  expect(
    await owner.startUserContainer({ ...input, modelSettings: { ...START_MODEL, models: [] } }),
  ).toEqual({ outcome: 'unconfigured' });
  database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(START_USER);
  await expect(owner.startUserContainer(input)).rejects.toThrow('account validation');
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(before);
  expect(daemon.requests).toEqual(requests);
});

it.each(['../foreign', 'abcdefghijkl\n', '', 'ABCDEFGHIJKLMNOP'])(
  'rejects invalid scheduling key %j without side effects and permits a valid successor',
  async (userId) => {
    const { owner, input, daemon } = await fixture();
    await expect(owner.startUserContainer({ ...input, userId })).rejects.toThrow(
      'account validation',
    );
    expect(daemon.requests).toEqual([]);
    expect(await owner.startUserContainer(input)).toEqual(STARTED);
  },
);

it('already canceled requests never begin credential clearing or readiness compensation', async () => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  database.prepare("UPDATE instances SET dsh_cookie = 'previous'").run();
  const before = database.prepare('SELECT * FROM instances').get();
  const requests = [...daemon.requests];
  const controller = new AbortController();
  controller.abort('private cancellation');
  const request: AcquireDshCookieInput = {
    userId: START_USER,
    authority: input.config.authority,
    signal: controller.signal,
  };
  await expect(owner.acquireDshCookie(request)).rejects.toThrow('credential acquisition failed');
  await expect(owner.waitForUserContainerReady(request)).rejects.toThrow('readiness failed');
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(before);
  expect(daemon.requests).toEqual(requests);
});

it.each([
  ['foreign image', { Image: `sha256:${'f'.repeat(64)}` }],
  ['foreign ID', { Id: NEXT_CONTAINER }],
  ['foreign name', { Name: '/dsh-team-u-mnopqrstuvwx' }],
  ['foreign user', { Config: { Labels: { 'dsh-team.user': OTHER_USER } } }],
  ['stopped Docker state', { State: { Running: false } }],
  ['malformed Docker state', { State: { Running: 'true' } }],
  ['missing publication', { NetworkSettings: { Ports: {} } }],
  [
    'wildcard publication',
    { NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49173' }] } } },
  ],
  [
    'mismatched port',
    { NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49174' }] } } },
  ],
  [
    'ambiguous publication',
    {
      NetworkSettings: {
        Ports: {
          '3080/tcp': [
            { HostIp: '127.0.0.1', HostPort: '49173' },
            { HostIp: '127.0.0.1', HostPort: '49174' },
          ],
        },
      },
    },
  ],
] as const)(
  'denies reuse of %s without writes or replacement-state corruption',
  async (_name, changed) => {
    const { owner, input, database, daemon } = await fixture();
    await owner.startUserContainer(input);
    const before = await startupEvidence(database, input);
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Expected created fixture container');
    daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, {
      status: 200,
      document: { ...container, ...changed },
    });
    const count = daemon.requests.length;

    await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');
    expect(await startupEvidence(database, input)).toEqual(before);
    expectDockerReads(daemon.requests, count, `/containers/${START_CONTAINER}/json`);
  },
);

it.each([
  ["status = 'stopped'"],
  ["status = 'error'"],
  ["image_id = 'not-an-image'"],
  ["container_id = 'invalid-container'"],
  ["image_tag = ''"],
  ['image_tag = NULL'],
  ["upstream_host = 'foreign.example'"],
  ['last_started_at = NULL'],
  ["last_started_at = 'not-a-timestamp'"],
  ['last_started_at = 1.5'],
] as const)('denies inconsistent indexed reuse with %s', async (assignment) => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  database.exec(`UPDATE instances SET ${assignment}`);
  const before = await startupEvidence(database, input);
  const count = daemon.requests.length;

  await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');
  expect(await startupEvidence(database, input)).toEqual(before);
  expect(daemon.requests.slice(count).every((request) => request.method === 'GET')).toBe(true);
});

it.each([403, 500, 200, 204])(
  'denies nonabsence Docker inspection status %i without mutation',
  async (status) => {
    const { owner, input, database, daemon } = await fixture();
    await owner.startUserContainer(input);
    const before = await startupEvidence(database, input);
    const count = daemon.requests.length;
    daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, { status });

    await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');
    expect(await startupEvidence(database, input)).toEqual(before);
    expectDockerReads(daemon.requests, count, `/containers/${START_CONTAINER}/json`);
  },
);

it.each(['instance', 'account', 'absent instance', 'absent account'] as const)(
  'denies %s replacement during exact-ID inspection without overwriting the replacement',
  async (replacement) => {
    const { owner, input, database, daemon } = await fixture();
    await owner.startUserContainer(input);
    let expected: unknown;
    const count = daemon.requests.length;
    if (replacement.startsWith('absent')) daemon.containers.delete(START_CONTAINER);
    daemon.beforeRequest((request) => {
      if (request.path !== `/containers/${START_CONTAINER}/json`) return;
      if (replacement.endsWith('instance'))
        database
          .prepare('UPDATE instances SET container_id = ?, dsh_cookie = ?')
          .run(NEXT_CONTAINER, 'replacement-cookie');
      else
        database
          .prepare('UPDATE users SET created_at = 2, password_hash = ?')
          .run('replacement-account');
      expected = database.prepare('SELECT * FROM instances').get();
    });
    const before = await startupEvidence(database, input);

    await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');
    expect(await startupEvidence(database, input)).toEqual({ ...before, row: expected });
    expectDockerReads(daemon.requests, count, `/containers/${START_CONTAINER}/json`);
  },
);

it('an exact old-ID 404 never adopts or deletes a foreign same-name collision', async () => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  const before = await startupEvidence(database, input);
  const old = daemon.containers.get(START_CONTAINER);
  if (old === undefined) throw new Error('Expected original fixture container');
  daemon.containers.delete(START_CONTAINER);
  const foreign = {
    ...old,
    Id: NEXT_CONTAINER,
    Image: `sha256:${'f'.repeat(64)}`,
    Config: { Labels: { 'dsh-team.user': OTHER_USER } },
  };
  daemon.containers.set(NEXT_CONTAINER, foreign);
  const count = daemon.requests.length;

  await expect(owner.startUserContainer(input)).rejects.toThrow('container conflict check');
  expect(await startupEvidence(database, input)).toEqual(before);
  expect(daemon.containers.get(NEXT_CONTAINER)).toEqual(foreign);
  expectDockerReads(
    daemon.requests,
    count,
    `/containers/${START_CONTAINER}/json`,
    `/containers/dsh-team-u-${START_USER}/json`,
  );
});

it('a queued start observes account replacement only when its predecessor has settled', async () => {
  const { owner, input, database, blockStartup, daemon } = await fixture();
  const { gate, head } = await blockStartup();
  const queued = owner.startUserContainer(input);
  const observed = queued.catch((error: unknown) => error);
  database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(START_USER);
  gate.release();
  await head;

  expect(await observed).toEqual(new Error('Container startup failed during account validation'));
  expect(
    daemon.requests.filter((request) => request.method === 'POST' && request.path === createPath()),
  ).toHaveLength(1);
});

it('only exact indexed-ID absence permits recreation through the canonical name-absence path', async () => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  daemon.containers.delete(START_CONTAINER);
  daemon.setContainerId(NEXT_CONTAINER);
  const count = daemon.requests.length;

  expect(await owner.startUserContainer(input)).toEqual({
    ...STARTED,
    containerId: NEXT_CONTAINER,
  });
  expect(
    daemon.requests.slice(count, count + 2).map(({ method, path }) => ({ method, path })),
  ).toEqual([
    { method: 'GET', path: `/containers/${START_CONTAINER}/json` },
    { method: 'GET', path: `/containers/dsh-team-u-${START_USER}/json` },
  ]);
  expect(database.prepare('SELECT container_id, image_id FROM instances').get()).toEqual({
    container_id: NEXT_CONTAINER,
    image_id: START_IMAGE,
  });
  expect(database.prepare('SELECT event_type FROM audit_events ORDER BY id').all()).toEqual([
    { event_type: 'instance.created' },
    { event_type: 'instance.started' },
    { event_type: 'instance.created' },
    { event_type: 'instance.started' },
  ]);
  expect(
    daemon.requests
      .slice(count)
      .filter((request) => request.method === 'POST' && request.path === createPath()),
  ).toHaveLength(1);
});

it('queued starts validate their own credentials rather than coalescing different requests', async () => {
  const { owner, input, database, blockStartup, daemon } = await fixture();
  const { gate, head } = await blockStartup();
  let finished = false;
  const unconfigured = owner.startUserContainer({ ...input, modelKey: '' }).then((result) => {
    finished = true;
    return result;
  });
  await owner.startUserContainer({ ...input, userId: OTHER_USER, modelKey: '' });
  expect(finished).toBe(false);
  gate.release();
  await head;

  expect(await unconfigured).toEqual({ outcome: 'unconfigured' });
  expect(database.prepare('SELECT user_id, container_id FROM instances').all()).toEqual([
    { user_id: START_USER, container_id: START_CONTAINER },
  ]);
  expect(
    daemon.requests.filter((request) => request.method === 'POST' && request.path === createPath()),
  ).toHaveLength(1);
});

it('completion of an older start cannot unlock a newer blocked same-user operation', async () => {
  const { owner, input, beforeRequest } = await fixture();
  const gate = barrier();
  let inspections = 0;
  beforeRequest(async (method, path) => {
    if (method === 'GET' && path === `/containers/${START_CONTAINER}/json` && ++inspections === 3)
      await gate.hold();
    return undefined;
  });
  const first = owner.startUserContainer(input);
  const second = owner.startUserContainer(input);
  const head = Promise.allSettled([first, second]);
  await gate.reached;
  expect(await first).toEqual(STARTED);
  let finished = false;
  const third = owner.startUserContainer({ ...input, modelKey: '' }).then((result) => {
    finished = true;
    return result;
  });
  await owner.startUserContainer({ ...input, userId: OTHER_USER, modelKey: '' });
  expect(finished).toBe(false);
  gate.release();
  await head;

  expect(await second).toEqual(STARTED);
  expect(await third).toEqual({ outcome: 'unconfigured' });
  expect(await owner.startUserContainer(input)).toEqual(STARTED);
});

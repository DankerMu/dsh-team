import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import type {
  Orchestrator,
  OrchestratorDependencies,
  StartUserContainerInput,
} from '../src/orchestrator/index.ts';
import {
  expectDockerReads,
  CREATED_AND_STARTED,
  startupEvidence,
  startupCapacityEvidence,
  startupDaemon,
  startupUnixServer,
  START_CONTAINER,
  START_HELPER,
  START_MODEL,
  START_PERMISSION,
  START_USER,
} from './container-start-fixture.ts';

let root: string;
let database: DatabaseHandle;
let input: StartUserContainerInput;
let owner: Orchestrator;
let startUserContainer: Orchestrator['startUserContainer'];
let client: OrchestratorDependencies['client'];
let daemon = startupDaemon();
let createBarrier:
  | {
      reached: { promise: Promise<undefined>; resolve: (value: undefined) => void };
      release: { promise: Promise<undefined>; resolve: (value: undefined) => void };
      path?: string;
      method?: string;
    }
  | undefined;
const server = startupUnixServer(
  (request) => daemon.reply(request),
  (method, path) => {
    if (
      createBarrier !== undefined &&
      method === (createBarrier.method ?? 'POST') &&
      path === (createBarrier.path ?? `/containers/create?name=dsh-team-u-${START_USER}`)
    ) {
      createBarrier.reached.resolve(undefined);
      return createBarrier.release.promise;
    }
    return undefined;
  },
);

beforeEach(async () => {
  createBarrier = undefined;
  root = await mkdtemp(join(tmpdir(), 'dsh-start-wire-'));
  database = openDatabase(join(root, 'platform.db'));
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'employee@example.test', 'unused-hash', 'employee', 'active', 1)",
    )
    .run(START_USER);
  daemon = startupDaemon();
  const seccomp = join(root, 'seccomp.json');
  await writeFile(seccomp, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
  const socket = join(root, 'engine.sock');
  server.listen(socket);
  await once(server, 'listening');
  client = createDockerClient(socket);
  owner = createOrchestrator({ client, database });
  ({ startUserContainer } = owner);
  input = {
    userId: START_USER,
    config: {
      userImage: 'dsh-team-user:local',
      seccompProfilePath: seccomp,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
    },
    modelSettings: START_MODEL,
    modelKey: 'fixture-private-key',
    permission: START_PERMISSION,
  };
});

afterEach(async () => {
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

function rows() {
  return database.prepare('SELECT * FROM instances').all();
}
function audits() {
  return database
    .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
    .all();
}

it('persisted limit1 over Unix Docker transport denies a second actual user without changing the admitted instance', async () => {
  const otherUser = 'mnopqrstuvwx';
  const nextContainer = 'd'.repeat(64);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'second@example.test', 'unused-hash', 'employee', 'active', 1)",
    )
    .run(otherUser);
  writeSettings(database, { maxRunningInstances: 1 });
  expect(await owner.startUserContainer(input)).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  const before = await startupCapacityEvidence(database, input, daemon);
  daemon.setContainerId(nextContainer);

  const result = await owner.startUserContainer({ ...input, userId: otherUser });

  expect(result).toEqual({ outcome: 'full' });
  expect(await startupCapacityEvidence(database, input, daemon)).toEqual(before);
  await expect(
    stat(join(input.config.managedConfigDir, `${otherUser}.patch.yml`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  [1, 'create'],
  [2, 'create'],
  [1, 'start'],
  [2, 'start'],
] as const)(
  'limit%s over Unix transport counts A once while its %s response is held',
  async (limit, phase) => {
    const otherUser = 'mnopqrstuvwx';
    const nextContainer = 'd'.repeat(64);
    database
      .prepare(
        "INSERT INTO users VALUES (?, 'second@example.test', 'unused', 'employee', 'active', 1)",
      )
      .run(otherUser);
    writeSettings(database, { maxRunningInstances: limit });
    createBarrier = {
      reached: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
      path:
        phase === 'create'
          ? `/containers/create?name=dsh-team-u-${START_USER}`
          : `/containers/${START_CONTAINER}/start`,
    };
    const first = owner.startUserContainer(input);
    const head = Promise.allSettled([first]);
    await createBarrier.reached.promise;
    const requests = [...daemon.requests];
    daemon.beforeRequest((request) => {
      if (request.path === `/containers/create?name=dsh-team-u-${otherUser}`)
        daemon.setContainerId(nextContainer);
      if (request.path === `/containers/create?name=dsh-team-u-${START_USER}`)
        daemon.setContainerId(START_CONTAINER);
    });
    try {
      expect(rows()).toMatchObject(
        phase === 'create' ? [] : [{ user_id: START_USER, status: 'starting' }],
      );

      expect(await owner.startUserContainer({ ...input, userId: otherUser })).toEqual(
        limit === 1
          ? { outcome: 'full' }
          : {
              outcome: 'starting',
              containerId: nextContainer,
              upstreamHost: '127.0.0.1',
              upstreamPort: 49173,
            },
      );

      if (limit === 1) {
        expect(daemon.requests).toEqual(requests);
        expect(
          database.prepare('SELECT * FROM instances WHERE user_id = ?').get(otherUser),
        ).toBeUndefined();
        await expect(
          stat(join(input.config.managedConfigDir, `${otherUser}.patch.yml`)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      createBarrier.release.resolve(undefined);
      await head;
    }
    expect(await first).toEqual({
      outcome: 'starting',
      containerId: START_CONTAINER,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
  },
);

it('ten same-user public starts over Unix Docker transport create one identity and one audit pair', async () => {
  createBarrier = {
    reached: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  const first = startUserContainer(input);
  const head = Promise.allSettled([first]);
  await createBarrier.reached.promise;
  const pending = [first];
  for (let index = 1; index < 10; index += 1) pending.push(startUserContainer(input));
  const completed = Promise.allSettled(pending);
  createBarrier.release.resolve(undefined);
  await head;

  expect(await completed).toEqual(
    Array.from({ length: 10 }, () => ({
      status: 'fulfilled',
      value: {
        outcome: 'starting',
        containerId: START_CONTAINER,
        upstreamHost: '127.0.0.1',
        upstreamPort: 49173,
      },
    })),
  );
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.path === `/containers/create?name=dsh-team-u-${START_USER}`,
    ),
  ).toHaveLength(1);
  expect(rows()).toMatchObject([
    {
      status: 'starting',
      container_id: START_CONTAINER,
      upstream_host: '127.0.0.1',
      upstream_port: 49173,
      dsh_cookie: null,
    },
  ]);
  expect(audits()).toEqual(CREATED_AND_STARTED);
});

it('commits completed creation and start separately, persists inspected endpoint, and never marks DSH ready', async () => {
  const observations: unknown[] = [];
  daemon.beforeRequest((request) => {
    if (
      request.path === '/containers/create?name=dsh-team-u-abcdefghijkl' ||
      request.path === `/containers/${START_CONTAINER}/start` ||
      (request.path === `/containers/${START_CONTAINER}/json` &&
        daemon.containers.get(START_CONTAINER)?.State.Running === true)
    ) {
      observations.push({ path: request.path, rows: rows(), audits: audits() });
    }
  });

  const result = await startUserContainer(input);

  expect(result).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  expect(observations[0]).toEqual({
    path: '/containers/create?name=dsh-team-u-abcdefghijkl',
    rows: [],
    audits: [],
  });
  for (const observation of observations.slice(1)) {
    expect(observation).toMatchObject({
      rows: [
        {
          container_id: START_CONTAINER,
          image_id: `sha256:${'a'.repeat(64)}`,
          status: 'starting',
          upstream_host: null,
          upstream_port: null,
          last_started_at: null,
        },
      ],
      audits: [{ event_type: 'instance.created' }],
    });
  }
  expect(rows()).toEqual([
    {
      user_id: START_USER,
      status: 'starting',
      container_id: START_CONTAINER,
      upstream_host: '127.0.0.1',
      upstream_port: 49173,
      dsh_cookie: null,
      image_tag: 'dsh-team-user:local',
      image_id: `sha256:${'a'.repeat(64)}`,
      // Vitest's matcher is untyped; it is an expected-value sentinel, not database data.
      last_started_at: expect.any(Number) as unknown,
      last_activity_at: null,
      last_error: null,
    },
  ]);
  expect(audits()).toEqual(CREATED_AND_STARTED);
  expect(
    JSON.stringify(rows()) +
      JSON.stringify(audits()) +
      (await readFile(join(root, 'managed', 'abcdefghijkl.patch.yml'), 'utf8')),
  ).not.toContain('fixture-private-key');
  database.close();
  database = openDatabase(join(root, 'platform.db'));
  expect(rows()).toMatchObject([{ status: 'starting', upstream_port: 49173 }]);
  expect(audits()).toEqual(CREATED_AND_STARTED);
});

it('applies default CPU, memory, no-extra-swap and PID limits to the final user container', async () => {
  await startUserContainer(input);

  expect(daemon.containers.get(START_CONTAINER)?.Config.HostConfig).toMatchObject({
    NanoCpus: 2_000_000_000,
    Memory: 4_294_967_296,
    MemorySwap: 4_294_967_296,
    PidsLimit: 512,
  });
});

it('reads changed persisted resource settings for each new creation on the same client', async () => {
  writeSettings(database, { cpuCores: 0.5, memoryMiB: 512 });
  await startUserContainer(input);
  await client.json('DELETE', `/containers/${START_CONTAINER}?force=true`);
  writeSettings(database, { cpuCores: 1.25, memoryMiB: 256 });

  await startUserContainer(input);

  const creates = daemon.requests.filter(
    (request) => request.path === '/containers/create?name=dsh-team-u-abcdefghijkl',
  );
  expect(creates.map((request) => request.body.HostConfig)).toMatchObject([
    { NanoCpus: 500_000_000, Memory: 536_870_912, MemorySwap: 536_870_912, PidsLimit: 512 },
    { NanoCpus: 1_250_000_000, Memory: 268_435_456, MemorySwap: 268_435_456, PidsLimit: 512 },
  ]);
});

it.each([
  [0.000000001, 1, 1, 1_048_576],
  [9_007_199, 8_589_934_591, 9_007_199_000_000_000, 9_007_199_253_692_416],
])(
  'preserves representable CPU %s and memory %s MiB at the Docker boundary',
  async (cpuCores, memoryMiB, nanoCpus, memory) => {
    writeSettings(database, { cpuCores, memoryMiB });

    await startUserContainer(input);

    expect(daemon.containers.get(START_CONTAINER)?.Config.HostConfig).toMatchObject({
      NanoCpus: nanoCpus,
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: 512,
    });
  },
);

it.each([
  ['cpuCores', '0'],
  ['cpuCores', '-1'],
  ['cpuCores', '1e999'],
  ['cpuCores', '"not-a-number"'],
  ['cpuCores', '0.0000000001'],
  ['cpuCores', '0.0000000011'],
  ['cpuCores', '9007199254740991'],
  ['memoryMiB', '0'],
  ['memoryMiB', '-1'],
  ['memoryMiB', '1.5'],
  ['memoryMiB', '1e999'],
  ['memoryMiB', '8589934592'],
])(
  'rejects nonrepresentable persisted %s=%s before Docker, overlay, index or audit mutations',
  async (field, value) => {
    database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(field, value);
    database
      .prepare(
        "INSERT INTO instances (user_id, status, container_id, last_error) VALUES (?, 'stopped', 'prior-container', 'prior-state')",
      )
      .run(START_USER);
    await mkdir(input.config.managedConfigDir);
    const overlay = join(input.config.managedConfigDir, `${START_USER}.patch.yml`);
    await writeFile(overlay, 'prior managed overlay\n', { mode: 0o444 });
    const originalInode = (await stat(overlay)).ino;
    const originalRows = rows();
    const changes: unknown = database.prepare('SELECT total_changes() AS count').get();

    await expect(startUserContainer(input)).rejects.toThrow(/resource limits/);

    expect(daemon.requests).toEqual([]);
    expect(rows()).toEqual(originalRows);
    expect(audits()).toEqual([]);
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(await readFile(overlay, 'utf8')).toBe('prior managed overlay\n');
    expect((await stat(overlay)).ino).toBe(originalInode);
  },
);

it.each([undefined, ''])(
  'does not start or index an instance when its actual model credential is %j',
  async (modelKey) => {
    database.exec('DROP TABLE settings');
    expect(await startUserContainer({ ...input, modelKey })).toEqual({ outcome: 'unconfigured' });
    expect(rows()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(daemon.requests).toEqual([]);
  },
);

it.each([
  ['missing address', { baseURL: undefined }],
  ['empty address', { baseURL: '' }],
  ['blank address', { baseURL: ' \t ' }],
  ['missing model list', { models: undefined }],
  ['empty model list', { models: [] }],
  ['missing default model', { defaultModel: undefined }],
  ['empty default model', { defaultModel: '' }],
  ['blank default model', { defaultModel: ' \t ' }],
  ['empty credential reference', { apiKeyEnv: '' }],
  ['blank credential reference', { apiKeyEnv: ' \t ' }],
] as const)(
  'returns unconfigured for %s without infrastructure or replacing prior state',
  async (_name, incomplete) => {
    database
      .prepare(
        "INSERT INTO instances (user_id, status, container_id, last_error) VALUES (?, 'stopped', 'prior-container', 'prior-state')",
      )
      .run(START_USER);
    database.exec('DROP TABLE settings');
    await mkdir(input.config.managedConfigDir);
    const overlay = join(input.config.managedConfigDir, `${START_USER}.patch.yml`);
    await writeFile(overlay, 'prior managed overlay\n', { mode: 0o444 });
    const originalInode = (await stat(overlay)).ino;
    const changes: unknown = database.prepare('SELECT total_changes() AS count').get();

    const result = await startUserContainer({
      ...input,
      config: { ...input.config, seccompProfilePath: join(root, 'unavailable-seccomp.json') },
      modelSettings: { ...START_MODEL, ...incomplete },
    });

    expect(result).toEqual({ outcome: 'unconfigured' });
    expect(rows()).toMatchObject([
      {
        user_id: START_USER,
        status: 'stopped',
        container_id: 'prior-container',
        last_error: 'prior-state',
        upstream_host: null,
        upstream_port: null,
      },
    ]);
    expect(audits()).toEqual([]);
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(await readFile(overlay, 'utf8')).toBe('prior managed overlay\n');
    expect((await stat(overlay)).ino).toBe(originalInode);
    expect(daemon.requests).toEqual([]);
  },
);

it.each(['instance.created', 'instance.started'])(
  'rolls back the matching index transition if %s audit persistence fails',
  async (event) => {
    database.exec(`CREATE TRIGGER reject_start_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type = '${event}' BEGIN SELECT RAISE(ABORT, 'fixture-private-key'); END`);

    const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);

    expect(String(error)).toContain(
      event === 'instance.created' ? 'creation persistence' : 'start persistence',
    );
    expect(String(error) + JSON.stringify(error)).not.toContain('fixture-private-key');
    if (event === 'instance.created') {
      expect(rows()).toEqual([]);
      expect(audits()).toEqual([]);
      expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
    } else {
      expect(rows()).toMatchObject([
        {
          container_id: START_CONTAINER,
          status: 'starting',
          upstream_host: null,
          upstream_port: null,
          last_started_at: null,
        },
      ]);
      expect(audits()).toEqual([
        {
          event_type: 'instance.created',
          target: START_USER,
          target_email: 'employee@example.test',
          details: '{}',
        },
      ]);
    }
    expect(daemon.containers.has(START_CONTAINER)).toBe(true);
    expect(
      daemon.requests.some(
        (request) => request.method === 'DELETE' && request.path.startsWith('/volumes'),
      ),
    ).toBe(false);
  },
);

it.each(['start failure', 'foreign owner', 'wrong identity', 'not running', 'wildcard endpoint'])(
  'preserves created identity but no usable endpoint or started audit after %s',
  async (failure) => {
    if (failure === 'start failure')
      daemon.overrides.set(`POST /containers/${START_CONTAINER}/start`, { status: 500 });
    daemon.beforeRequest((request) => {
      if (request.path !== `/containers/${START_CONTAINER}/json`) return;
      const container = daemon.containers.get(START_CONTAINER);
      if (!container) throw new Error('Missing fixture container');
      if (!container.State.Running) return;
      if (failure === 'foreign owner')
        container.Config.Labels = { 'dsh-team.user': 'mnopqrstuvwx' };
      if (failure === 'wrong identity') container.Id = 'd'.repeat(64);
      if (failure === 'not running') container.State.Running = false;
      if (failure === 'wildcard endpoint')
        container.NetworkSettings.Ports = {
          '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49173' }],
        };
    });

    await expect(startUserContainer(input)).rejects.toThrow(
      /container start|started container inspection/,
    );

    expect(rows()).toMatchObject([
      {
        container_id: START_CONTAINER,
        status: 'starting',
        upstream_host: null,
        upstream_port: null,
        last_started_at: null,
        dsh_cookie: null,
      },
    ]);
    expect(audits()).toEqual([
      {
        event_type: 'instance.created',
        target: START_USER,
        target_email: 'employee@example.test',
        details: '{}',
      },
    ]);
  },
);

it('cancels a pending composition wait and still removes only its helper with a fresh cleanup deadline', async () => {
  const controller = new AbortController();
  daemon.beforeRequest((request) => {
    if (request.path === `/containers/${START_HELPER}/wait?condition=not-running`)
      controller.abort();
  });

  await expect(startUserContainer({ ...input, signal: controller.signal })).rejects.toThrow(
    /managed composition/,
  );

  expect(daemon.containers.size).toBe(0);
  expect(
    daemon.requests.filter((request) => request.method === 'DELETE').map((request) => request.path),
  ).toEqual([`/containers/${START_HELPER}?force=true`]);
  expect(rows()).toEqual([]);
  expect(audits()).toEqual([]);
});

it('validated starting reuse over Unix transport preserves row, overlay inode, cookie and audits', async () => {
  await startUserContainer(input);
  database
    .prepare("UPDATE instances SET dsh_cookie = 'retained-cookie', last_activity_at = 222")
    .run();
  const before = await startupEvidence(database, input);
  const count = daemon.requests.length;

  expect(await startUserContainer(input)).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  expect(await startupEvidence(database, input)).toEqual(before);
  expectDockerReads(daemon.requests, count, `/containers/${START_CONTAINER}/json`);
});

it.each(['instance', 'account'] as const)(
  'a %s replacement during real Unix inspection is not overwritten or falsely reused',
  async (kind) => {
    await startUserContainer(input);
    let replacement: unknown;
    const before = await startupEvidence(database, input);
    const count = daemon.requests.length;
    daemon.beforeRequest((request) => {
      if (request.path !== `/containers/${START_CONTAINER}/json`) return;
      if (kind === 'instance')
        database
          .prepare('UPDATE instances SET container_id = ?, dsh_cookie = ?')
          .run('d'.repeat(64), 'replacement-cookie');
      else database.prepare('UPDATE users SET created_at = 2').run();
      replacement = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
    });

    await expect(startUserContainer(input)).rejects.toThrow('current container validation');
    expect(await startupEvidence(database, input)).toEqual({ ...before, row: replacement });
    expectDockerReads(daemon.requests, count, `/containers/${START_CONTAINER}/json`);
  },
);

it('exact-ID absence with a foreign canonical name never adopts or destroys the collision over Unix', async () => {
  await startUserContainer(input);
  const before = await startupEvidence(database, input);
  const old = daemon.containers.get(START_CONTAINER);
  if (old === undefined) throw new Error('Expected original container');
  const foreign = {
    ...old,
    Id: 'd'.repeat(64),
    Image: `sha256:${'f'.repeat(64)}`,
    Config: { Labels: { 'dsh-team.user': 'mnopqrstuvwx' } },
  };
  daemon.containers.delete(START_CONTAINER);
  daemon.containers.set(foreign.Id, foreign);
  const count = daemon.requests.length;

  await expect(startUserContainer(input)).rejects.toThrow('container conflict check');
  expect(await startupEvidence(database, input)).toEqual(before);
  expect(daemon.containers.get(foreign.Id)).toEqual(foreign);
  expectDockerReads(
    daemon.requests,
    count,
    `/containers/${START_CONTAINER}/json`,
    `/containers/dsh-team-u-${START_USER}/json`,
  );
});

it('queued cancellation over Unix transport makes no mutation while later starts remain usable', async () => {
  createBarrier = {
    reached: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  const first = owner.startUserContainer(input);
  const head = Promise.allSettled([first]);
  await createBarrier.reached.promise;
  const controller = new AbortController();
  const canceled = owner
    .stopUserContainer({
      userId: START_USER,
      reason: 'admin',
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  const successor = owner.startUserContainer(input);
  const requests = [...daemon.requests];
  const beforeRows = rows();
  const beforeAudit = audits();
  controller.abort('private abort reason');
  expect(await canceled).toEqual(new Error('User container retirement failed'));
  expect(daemon.requests).toEqual(requests);
  expect(rows()).toEqual(beforeRows);
  expect(audits()).toEqual(beforeAudit);
  createBarrier.release.resolve(undefined);
  await head;

  expect(await successor).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  expect(
    daemon.requests.filter(
      (request) =>
        request.method === 'POST' &&
        request.path === `/containers/create?name=dsh-team-u-${START_USER}`,
    ),
  ).toHaveLength(1);
  expect(
    audits().map((row) => {
      if (typeof row !== 'object' || row === null || !('event_type' in row))
        throw new Error('Missing audit type');
      return row.event_type;
    }),
  ).toEqual(['instance.created', 'instance.started']);
});

it('public start retirement start executes FIFO over Unix transport and retains owned volume names', async () => {
  createBarrier = {
    reached: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  const first = owner.startUserContainer(input);
  const head = Promise.allSettled([first]);
  await createBarrier.reached.promise;
  const retired = owner.stopUserContainer({ userId: START_USER, reason: 'idle' });
  const restarted = owner.startUserContainer(input);
  const completed = Promise.allSettled([first, retired, restarted]);
  daemon.beforeRequest((request) => {
    if (request.method === 'DELETE' && request.path === `/containers/${START_CONTAINER}`)
      daemon.setContainerId('d'.repeat(64));
  });
  createBarrier.release.resolve(undefined);
  await head;

  expect(await completed).toMatchObject([
    { status: 'fulfilled', value: { containerId: START_CONTAINER } },
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: { containerId: 'd'.repeat(64) } },
  ]);
  expect(rows()).toMatchObject([{ status: 'starting', container_id: 'd'.repeat(64) }]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(
    daemon.requests
      .filter((request) => request.path === '/volumes/create')
      .map(({ body }) => body.Name),
  ).toEqual([
    `dsh-team-home-${START_USER}`,
    `dsh-team-work-${START_USER}`,
    `dsh-team-home-${START_USER}`,
    `dsh-team-work-${START_USER}`,
  ]);
  expect(audits()).toEqual([
    ...CREATED_AND_STARTED,
    {
      event_type: 'instance.stopped',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{"reason":"idle"}',
    },
    ...CREATED_AND_STARTED,
  ]);
});

it.each([false, true])(
  'Unix failure/cancellation (%s) keeps the last slot until cleanup settles',
  async (cancel) => {
    const otherUser = 'mnopqrstuvwx';
    database
      .prepare(
        "INSERT INTO users VALUES (?, 'second@example.test', 'unused', 'employee', 'active', 1)",
      )
      .run(otherUser);
    writeSettings(database, { maxRunningInstances: 1 });
    createBarrier = {
      reached: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
      method: 'DELETE',
      path: `/containers/${START_HELPER}?force=true`,
    };
    const controller = new AbortController();
    if (!cancel) daemon.setComposition('not-json');
    daemon.beforeRequest((request) => {
      if (cancel && request.path === `/containers/${START_HELPER}/wait?condition=not-running`)
        controller.abort();
    });
    const first = owner.startUserContainer({ ...input, signal: controller.signal });
    const head = Promise.allSettled([first]);
    await createBarrier.reached.promise;
    try {
      expect(await owner.startUserContainer({ ...input, userId: otherUser })).toEqual({
        outcome: 'full',
      });
      expect(daemon.containers.has(START_HELPER)).toBe(true);
      expect(rows()).toEqual([]);
      expect(audits()).toEqual([]);
    } finally {
      createBarrier.release.resolve(undefined);
      await head;
    }
    expect(await head).toMatchObject([
      {
        status: 'rejected',
        reason: { message: 'Container startup failed during managed composition' },
      },
    ]);
    expect(daemon.containers.has(START_HELPER)).toBe(false);
    daemon.setComposition();
    expect(await owner.startUserContainer({ ...input, userId: otherUser })).toMatchObject({
      outcome: 'starting',
      containerId: START_CONTAINER,
    });
  },
);

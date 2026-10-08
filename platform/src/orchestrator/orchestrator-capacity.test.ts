import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createOrchestrator } from './index.ts';
import {
  startupBarrier,
  startupCapacityEvidence,
  startupEvidence,
  startupOwnerFixture,
  START_CONTAINER,
  START_HELPER,
  START_USER,
} from '../../test/container-start-fixture.ts';

const OTHER_USER = 'mnopqrstuvwx';
const NEXT_CONTAINER = 'd'.repeat(64);
const contexts: { database: DatabaseHandle; root: string }[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    context.database.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

async function fixture(limit = 1) {
  const context = await startupOwnerFixture();
  contexts.push(context);
  writeSettings(context.database, { maxRunningInstances: limit });
  return context;
}

it('only the first user claims the last slot before durable creation', async () => {
  const { owner, input, database, daemon, blockStartup } = await fixture();
  const { gate, head } = await blockStartup();
  const requests = [...daemon.requests];
  try {
    expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
      outcome: 'full',
    });
    expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
    expect(daemon.requests).toEqual(requests);
    await expect(
      stat(join(input.config.managedConfigDir, `${OTHER_USER}.patch.yml`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    gate.release();
    await head;
  }
  expect(database.prepare('SELECT user_id, status FROM instances').all()).toEqual([
    { user_id: START_USER, status: 'starting' },
  ]);
});

it('pending and durable starting occupancy count one user during handoff', async () => {
  const { owner, input, database, daemon, beforeRequest } = await fixture(2);
  const gate = startupBarrier();
  beforeRequest(async (method, path) => {
    if (method === 'POST' && path === `/containers/${START_CONTAINER}/start`) await gate.hold();
    return undefined;
  });
  const first = owner.startUserContainer(input);
  const head = Promise.allSettled([first]);
  await gate.reached;
  daemon.setContainerId(NEXT_CONTAINER);
  try {
    expect(database.prepare('SELECT user_id, status FROM instances').all()).toEqual([
      { user_id: START_USER, status: 'starting' },
    ]);
    expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
      outcome: 'starting',
      containerId: NEXT_CONTAINER,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
  } finally {
    gate.release();
    await head;
  }
  expect(await first).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
});

it.each([false, true])(
  'failure or cancellation (%s) holds admission until helper cleanup settles',
  async (cancel) => {
    const { owner, input, database, daemon, beforeRequest } = await fixture();
    const gate = startupBarrier();
    const controller = new AbortController();
    if (!cancel) daemon.setComposition('not-json');
    beforeRequest(async (method, path) => {
      if (cancel && path === `/containers/${START_HELPER}/wait?condition=not-running`)
        controller.abort();
      if (method === 'DELETE' && path === `/containers/${START_HELPER}?force=true`)
        await gate.hold();
      return undefined;
    });
    const first = owner.startUserContainer({ ...input, signal: controller.signal });
    const head = Promise.allSettled([first]);
    await gate.reached;
    try {
      expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
        outcome: 'full',
      });
      expect(daemon.containers.has(START_HELPER)).toBe(true);
      expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
    } finally {
      gate.release();
      await head;
    }
    expect(await head).toMatchObject([
      {
        status: 'rejected',
        reason: { message: 'Container startup failed during managed composition' },
      },
    ]);
    expect(daemon.containers.has(START_HELPER)).toBe(false);
    beforeRequest(undefined);
    daemon.setComposition();
    daemon.setContainerId(NEXT_CONTAINER);
    expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
      outcome: 'starting',
      containerId: NEXT_CONTAINER,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
  },
);

it('precreation failure releases admission without poisoning another user', async () => {
  const { owner, input, daemon } = await fixture();
  daemon.overrides.set('GET /images/dsh-team-user%3Alocal/json', { status: 500 });

  await expect(owner.startUserContainer(input)).rejects.toThrow('image resolution');
  daemon.overrides.clear();
  daemon.setContainerId(NEXT_CONTAINER);

  expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
    outcome: 'starting',
    containerId: NEXT_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
});

it('failed indexed start remains counted after owner reconstruction', async () => {
  const { owner, input, database, client, daemon } = await fixture();
  database.exec(
    "CREATE TRIGGER reject_started BEFORE INSERT ON audit_events WHEN NEW.event_type = 'instance.started' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  await expect(owner.startUserContainer(input)).rejects.toThrow('start persistence');
  const before = database.prepare('SELECT * FROM instances').all();
  const requests = [...daemon.requests];
  const reconstructed = createOrchestrator({ client, database });

  expect(await reconstructed.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
    outcome: 'full',
  });

  expect(database.prepare('SELECT * FROM instances').all()).toEqual(before);
  expect(before).toMatchObject([{ user_id: START_USER, status: 'starting', upstream_host: null }]);
  expect(daemon.requests).toEqual(requests);
});

it.each(['starting', 'running', 'stopped', 'error'] as const)(
  'capacity counts persisted %s according to active state',
  async (status) => {
    const { owner, input, database } = await fixture();
    database
      .prepare('INSERT INTO instances (user_id, status) VALUES (?, ?)')
      .run(OTHER_USER, status);

    const result = await owner.startUserContainer(input);

    expect(result).toEqual(
      status === 'starting' || status === 'running'
        ? { outcome: 'full' }
        : {
            outcome: 'starting',
            containerId: START_CONTAINER,
            upstreamHost: '127.0.0.1',
            upstreamPort: 49173,
          },
    );
  },
);

it('fresh raised limits admit another user and lowered limits preserve validated reuse', async () => {
  const { owner, input, database, daemon } = await fixture();
  await owner.startUserContainer(input);
  expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
    outcome: 'full',
  });
  writeSettings(database, { maxRunningInstances: 2 });
  daemon.setContainerId(NEXT_CONTAINER);
  expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toMatchObject({
    outcome: 'starting',
    containerId: NEXT_CONTAINER,
  });
  writeSettings(database, { maxRunningInstances: 1 });
  const thirdUser = 'zzzzzzzzzzzz';
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'third@example.test', 'unused', 'employee', 'active', 1)",
    )
    .run(thirdUser);
  const before = await startupEvidence(database, input);

  expect(await owner.startUserContainer(input)).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });

  expect(await startupEvidence(database, input)).toEqual(before);
  const lowered = await startupCapacityEvidence(database, input, daemon);
  expect(await owner.startUserContainer({ ...input, userId: thirdUser })).toEqual({
    outcome: 'full',
  });
  expect(await startupCapacityEvidence(database, input, daemon)).toEqual(lowered);
});

it('exact-ID404 replacement does not count its own stale active row twice', async () => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  daemon.removeContainer(START_CONTAINER);
  daemon.setContainerId(NEXT_CONTAINER);

  expect(await owner.startUserContainer(input)).toEqual({
    outcome: 'starting',
    containerId: NEXT_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });

  expect(database.prepare('SELECT user_id, container_id FROM instances').all()).toEqual([
    { user_id: START_USER, container_id: NEXT_CONTAINER },
  ]);
});

it.each([0, 1, 2])(
  'replacement observes fresh limit%s after awaiting exact-ID inspection',
  async (limit) => {
    const { owner, input, daemon, database, beforeRequest } = await fixture(2);
    await owner.startUserContainer(input);
    daemon.removeContainer(START_CONTAINER);
    database
      .prepare("INSERT INTO instances (user_id, status) VALUES (?, 'running')")
      .run(OTHER_USER);
    const gate = startupBarrier();
    beforeRequest(async (_method, path) => {
      if (path === `/containers/${START_CONTAINER}/json`) await gate.hold();
      return undefined;
    });
    const next = owner.startUserContainer(input);
    const head = Promise.allSettled([next]);
    await gate.reached;
    database
      .prepare("UPDATE settings SET value = ? WHERE key = 'maxRunningInstances'")
      .run(String(limit));
    beforeRequest(undefined);
    gate.release();
    await head;

    if (limit === 0) await expect(next).rejects.toThrow('capacity admission');
    else
      expect(await next).toEqual(
        limit === 1
          ? { outcome: 'full' }
          : {
              outcome: 'starting',
              containerId: START_CONTAINER,
              upstreamHost: '127.0.0.1',
              upstreamPort: 49173,
            },
      );
  },
);

it.each(['key', 'settings'] as const)(
  'missing model %s takes precedence over full without mutations',
  async (missing) => {
    const { owner, input, database, daemon } = await fixture();
    await owner.startUserContainer(input);
    const before = await startupCapacityEvidence(database, input, daemon);

    expect(
      await owner.startUserContainer({
        ...input,
        userId: OTHER_USER,
        ...(missing === 'key'
          ? { modelKey: '' }
          : { modelSettings: { ...input.modelSettings, models: [] } }),
      }),
    ).toEqual({ outcome: 'unconfigured' });

    expect(await startupCapacityEvidence(database, input, daemon)).toEqual(before);
  },
);

it('invalid persisted capacity settings fail loudly rather than returning full', async () => {
  const { owner, input, database, daemon } = await fixture();
  database.prepare("UPDATE settings SET value = '0' WHERE key = 'maxRunningInstances'").run();

  await expect(owner.startUserContainer(input)).rejects.toThrow('resource limits');

  expect(daemon.requests).toEqual([]);
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
  expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
});

it('only successful retirement frees durable occupancy for another user', async () => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 500 });
  await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
    'retirement',
  );
  expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toEqual({
    outcome: 'full',
  });
  daemon.overrides.clear();

  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  daemon.setContainerId(NEXT_CONTAINER);
  expect(await owner.startUserContainer({ ...input, userId: OTHER_USER })).toMatchObject({
    outcome: 'starting',
    containerId: NEXT_CONTAINER,
  });

  expect(
    database.prepare('SELECT status FROM instances WHERE user_id = ?').get(START_USER),
  ).toEqual({ status: 'stopped' });
});

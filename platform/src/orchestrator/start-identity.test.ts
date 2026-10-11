import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { StartResult } from './index.ts';
import { createOrchestrator } from './index.ts';
import {
  expectDockerReads,
  seedPlatform,
  startupEvidence,
  startupCapacityEvidence,
  startupBarrier as barrier,
  startupOwnerFixture,
  START_CONTAINER,
  START_MODEL,
  START_NETWORK,
  START_USER,
} from '../../test/container-start-fixture.ts';
import type { StartupBarrier, StartupOwnerFixture } from '../../test/container-start-fixture.ts';

const OTHER_USER = 'mnopqrstuvwx';
const NEXT_CONTAINER = 'd'.repeat(64);
const contexts: { database: DatabaseHandle; root: string }[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    context.database.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const context = await startupOwnerFixture();
  contexts.push(context);
  return context;
}

const STARTED: StartResult = {
  outcome: 'starting',
  containerId: START_CONTAINER,
  upstreamHost: '127.0.0.1',
  upstreamPort: 49173,
};

async function retainedErrorFixture(running = false) {
  const context = await fixture();
  await context.owner.startUserContainer(context.input);
  const retained = context.daemon.containers.get(START_CONTAINER);
  if (retained === undefined) throw new Error('Expected retained fixture container');
  retained.State.Running = running;
  context.database
    .prepare("UPDATE instances SET status = 'error', dsh_cookie = NULL, last_error = ?")
    .run('Managed overlay startup failed');
  context.daemon.setContainerId(NEXT_CONTAINER);
  return { ...context, retained };
}

async function expectCanceledRetryFifo(
  { owner, input }: Pick<StartupOwnerFixture, 'owner' | 'input'>,
  cancellation: AbortController,
  gate: StartupBarrier,
  settled: Promise<PromiseSettledResult<StartResult>[]>,
): Promise<void> {
  cancellation.abort();
  let drained = false;
  const drain = owner.drain().then(() => {
    drained = true;
  });
  let followed = false;
  const successor = owner.startUserContainer({ ...input, modelKey: undefined }).then((result) => {
    followed = true;
    return result;
  });
  await owner.startUserContainer({ ...input, userId: OTHER_USER, modelKey: undefined });
  expect(drained).toBe(false);
  expect(followed).toBe(false);
  gate.release();

  expect(await settled).toMatchObject([
    {
      status: 'rejected',
      reason: { message: 'Container startup failed during error container retirement' },
    },
  ]);
  expect(await successor).toEqual({ outcome: 'unconfigured' });
  await drain;
}

it.each(['stopped', 'running', 'detached'] as const)(
  'explicit retry replaces a retained %s error container using current home composition',
  async (state) => {
    const { owner, input, daemon, database, retained } = await retainedErrorFixture(
      state === 'running',
    );
    if (state === 'detached') {
      retained.NetworkSettings.Networks = {};
      daemon.networks.delete(START_NETWORK);
    }
    daemon.setComposition(
      JSON.stringify({
        skippedBundles: [],
        entries: [
          {
            id: 'assistant',
            name: '@deepseek-ai/dsh-agent-preset',
            config: { id: 'assistant', plugins: [], theme: 'retry-theme' },
          },
        ],
        localePatch: [{ id: 'locale', name: '@dsh-team/zh-locale' }],
      }),
    );

    expect(await owner.startUserContainer(input)).toEqual({
      ...STARTED,
      containerId: NEXT_CONTAINER,
    });

    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      database.prepare('SELECT status, container_id, last_error FROM instances').get(),
    ).toEqual({
      status: 'starting',
      container_id: NEXT_CONTAINER,
      last_error: null,
    });
    expect(
      JSON.parse(
        await readFile(join(input.config.managedConfigDir, `${START_USER}.patch.yml`), 'utf8'),
      ),
    ).toContainEqual({
      id: 'assistant',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'assistant', plugins: [], theme: 'retry-theme' },
    });
    expect(daemon.containers.get(NEXT_CONTAINER)?.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: `dsh-team-home-${START_USER}`, Target: '/data/home' },
      { Type: 'volume', Source: `dsh-team-work-${START_USER}`, Target: '/data/work' },
      {
        Type: 'bind',
        Source: join(input.config.managedConfigDir, `${START_USER}.patch.yml`),
        Target: '/managed/patch.yml',
        ReadOnly: true,
      },
    ]);
    expect(
      daemon.requests.some(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes'),
      ),
    ).toBe(false);
    expect(
      database.prepare('SELECT event_type, details FROM audit_events ORDER BY id').all(),
    ).toEqual([
      { event_type: 'instance.created', details: '{}' },
      { event_type: 'instance.started', details: '{}' },
      { event_type: 'instance.stopped', details: '{"reason":"error"}' },
      { event_type: 'instance.created', details: '{}' },
      { event_type: 'instance.started', details: '{}' },
    ]);
  },
);

it.each(['key unavailable', 'model incomplete', 'full'] as const)(
  '%s refuses retry without retiring the retained error or replacing its overlay',
  async (refusal) => {
    const { owner, input, daemon, database } = await retainedErrorFixture();
    if (refusal === 'full') {
      writeSettings(database, { maxRunningInstances: 1 });
      database
        .prepare("INSERT INTO instances(user_id, status) VALUES (?, 'running')")
        .run(OTHER_USER);
    }
    const before = await startupCapacityEvidence(database, input, daemon);
    const request =
      refusal === 'key unavailable'
        ? { ...input, modelKey: undefined }
        : refusal === 'model incomplete'
          ? { ...input, modelSettings: { ...START_MODEL, models: [] } }
          : input;

    expect(await owner.startUserContainer(request)).toEqual({
      outcome: refusal === 'full' ? 'full' : 'unconfigured',
    });

    const after = await startupCapacityEvidence(database, input, daemon);
    expect({ ...after, requests: before.requests }).toEqual(before);
    if (refusal === 'full')
      expectDockerReads(
        daemon.requests,
        before.requests.length,
        `/containers/${START_CONTAINER}/json`,
      );
    else expect(after.requests).toEqual(before.requests);
  },
);

it.each(['instance', 'account'] as const)(
  'a changed %s during error retirement prevents deletion and replacement',
  async (changed) => {
    const { owner, input, database, daemon, beforeRequest } = await retainedErrorFixture();
    const gate = barrier();
    let inspections = 0;
    beforeRequest(async (method, path) => {
      if (method === 'GET' && path === `/containers/${START_CONTAINER}/json` && ++inspections === 2)
        await gate.hold();
      return undefined;
    });
    const retry = owner.startUserContainer(input);
    const settled = Promise.allSettled([retry]);
    await gate.reached;
    try {
      if (changed === 'instance')
        database.prepare('UPDATE instances SET last_error = ?').run('New failure identity');
      else
        database
          .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run('new-account', START_USER);
      const before = await startupCapacityEvidence(database, input, daemon);
      gate.release();

      expect(await settled).toMatchObject([
        {
          status: 'rejected',
          reason: { message: 'Container startup failed during error container retirement' },
        },
      ]);
      const after = await startupCapacityEvidence(database, input, daemon);
      expect({ ...after, requests: before.requests }).toEqual(before);
      expect(
        daemon.requests.slice(before.requests.length).every(({ method }) => method === 'GET'),
      ).toBe(true);
    } finally {
      gate.release();
      await settled;
    }
  },
);

it.each(['name', 'owner', 'image', 'id'] as const)(
  'error retry refuses a mismatched container %s without deleting or creating',
  async (changed) => {
    const { owner, input, database, daemon, retained } = await retainedErrorFixture();
    if (changed === 'name') retained.Name = '/foreign-name';
    if (changed === 'owner') retained.Config.Labels = { 'dsh-team.user': OTHER_USER };
    if (changed === 'image') retained.Image = `sha256:${'f'.repeat(64)}`;
    if (changed === 'id')
      daemon.overrides.set(`GET /containers/${START_CONTAINER}/json`, {
        status: 200,
        document: { ...retained, Id: NEXT_CONTAINER },
      });
    const before = await startupCapacityEvidence(database, input, daemon);

    await expect(owner.startUserContainer(input)).rejects.toThrow('error container retirement');

    const after = await startupCapacityEvidence(database, input, daemon);
    expect({ ...after, requests: before.requests }).toEqual(before);
    expect(
      daemon.requests.slice(before.requests.length).every(({ method }) => method === 'GET'),
    ).toBe(true);
  },
);

it.each(['container removal', 'network removal', 'audit commit'] as const)(
  'failed %s during error retry never creates a replacement',
  async (failure) => {
    const { owner, input, database, daemon } = await retainedErrorFixture();
    if (failure === 'audit commit')
      database.exec(`CREATE TRIGGER reject_retry_stop BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'instance.stopped' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    else {
      const path =
        failure === 'container removal'
          ? `/containers/${START_CONTAINER}`
          : `/networks/${START_NETWORK}`;
      daemon.overrides.set(`DELETE ${path}`, { status: 500 });
    }
    const before = await startupEvidence(database, input);
    const count = daemon.requests.length;

    await expect(owner.startUserContainer(input)).rejects.toThrow('error container retirement');

    expect(await startupEvidence(database, input)).toEqual(before);
    expect(
      daemon.requests.slice(count).some(({ path }) => path.startsWith('/containers/create?')),
    ).toBe(false);
    expect(daemon.containers.has(NEXT_CONTAINER)).toBe(false);
  },
);

it('an account changed by retirement commit cannot authorize a new error retry container', async () => {
  const { owner, input, database, daemon } = await retainedErrorFixture();
  database.exec(`CREATE TRIGGER disable_retry_account AFTER UPDATE OF status ON instances
    WHEN NEW.status = 'stopped' BEGIN
      UPDATE users SET status = 'disabled' WHERE id = NEW.user_id;
    END`);
  const count = daemon.requests.length;

  await expect(owner.startUserContainer(input)).rejects.toThrow('error container retirement');

  expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
    status: 'stopped',
    container_id: null,
  });
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.containers.has(NEXT_CONTAINER)).toBe(false);
  expect(
    daemon.requests.slice(count).some(({ path }) => path.startsWith('/containers/create?')),
  ).toBe(false);
});

it('canceled error retry keeps its FIFO through retirement settlement and never creates', async () => {
  const { owner, input, database, daemon, beforeRequest } = await retainedErrorFixture();
  const gate = barrier();
  beforeRequest(async (method, path) => {
    if (method === 'DELETE' && path === `/containers/${START_CONTAINER}`) await gate.hold();
    return undefined;
  });
  const cancellation = new AbortController();
  const retry = owner.startUserContainer({ ...input, signal: cancellation.signal });
  const settled = Promise.allSettled([retry]);
  await gate.reached;
  try {
    const before = await startupCapacityEvidence(database, input, daemon);
    await expectCanceledRetryFifo({ owner, input }, cancellation, gate, settled);
    expect(await startupCapacityEvidence(database, input, daemon)).toEqual(before);
  } finally {
    gate.release();
    await settled;
  }
});

it('cancellation after error container removal still settles owned network detach before releasing retry FIFO', async () => {
  const { input, database, daemon, client, beforeRequest } = await fixture();
  const platform = 'f'.repeat(64);
  seedPlatform(daemon, 'dsh-team-platform', platform);
  const owner = createOrchestrator({
    client,
    database,
    config: { upstreamMode: 'network', platformContainerName: 'dsh-team-platform' },
  });
  await owner.startUserContainer(input);
  const retained = daemon.containers.get(START_CONTAINER);
  if (retained === undefined) throw new Error('Expected retained fixture container');
  retained.State.Running = false;
  database.prepare("UPDATE instances SET status = 'error', dsh_cookie = NULL").run();
  daemon.setContainerId(NEXT_CONTAINER);
  const gate = barrier();
  beforeRequest(async (method, path) => {
    if (method === 'POST' && path === `/networks/${START_NETWORK}/disconnect`) await gate.hold();
    return undefined;
  });
  const cancellation = new AbortController();
  const count = daemon.requests.length;
  const retry = owner.startUserContainer({ ...input, signal: cancellation.signal });
  const settled = Promise.allSettled([retry]);
  await gate.reached;
  try {
    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    await expectCanceledRetryFifo({ owner, input }, cancellation, gate, settled);
    expect(daemon.networks.has(START_NETWORK)).toBe(false);
    expect(daemon.networks.get('0'.repeat(64))?.Containers).toHaveProperty(platform);
    expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
      status: 'error',
      container_id: START_CONTAINER,
    });
    expect(
      daemon.requests.slice(count).some(({ path }) => path.startsWith('/containers/create?')),
    ).toBe(false);
    expect(daemon.containers.has(NEXT_CONTAINER)).toBe(false);
  } finally {
    gate.release();
    await settled;
  }
});

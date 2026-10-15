import { rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createDockerClient, createOrchestrator } from './index.ts';
import type { DockerTransport } from './index.ts';
import { afterEach, expect, it } from 'vitest';
import {
  START_HELPER,
  START_USER,
  startupBarrier,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import type { StartupOwnerFixture } from '../../test/container-start-fixture.ts';

const contexts: StartupOwnerFixture[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.owner.drain();
    context.database.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const context = await startupOwnerFixture();
  contexts.push(context);
  await context.owner.startUserContainer(context.input);
  await context.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  context.daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
    status: 200,
    document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': START_USER } },
  });
  return context;
}

it('restores through an owned helper without changing index, audit or allocating volumes', async () => {
  const { owner, input, database, daemon } = await fixture();
  const rows = database.prepare('SELECT * FROM instances').all();
  const audits = database.prepare('SELECT * FROM audit_events').all();
  const count = daemon.requests.length;

  await owner.restoreUserProfiles(input);

  expect(database.prepare('SELECT * FROM instances').all()).toEqual(rows);
  expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
  expect(daemon.containers.size).toBe(0);
  expect(daemon.requests.slice(count).some(({ path }) => path === '/volumes/create')).toBe(false);
});

it.each(['running', 'starting'])(
  'rejects %s before a profile helper can mutate data',
  async (status) => {
    const { owner, input, database, daemon } = await fixture();
    database.prepare('UPDATE instances SET status=?').run(status);
    const count = daemon.requests.length;

    await expect(owner.restoreUserProfiles(input)).rejects.toThrow('Profile restoration failed');

    expect(daemon.requests.slice(count)).toEqual([]);
  },
);

it.each([404, 500, 200])(
  'rejects missing, unreadable or foreign volume response %s',
  async (status) => {
    const { owner, input, daemon } = await fixture();
    daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
      status,
      document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': 'other' } },
    });
    const count = daemon.requests.length;

    await expect(owner.restoreUserProfiles(input)).rejects.toThrow('Profile restoration failed');

    expect(daemon.requests.slice(count).every(({ method }) => method === 'GET')).toBe(true);
  },
);

it('rechecks changed account before starting the created helper and retires that helper', async () => {
  const { owner, input, database, daemon } = await fixture();
  daemon.beforeRequest(({ method, path }) => {
    if (method === 'POST' && path.startsWith('/containers/create?'))
      database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
  });
  const count = daemon.requests.length;

  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('Profile restoration failed');

  expect(daemon.containers.size).toBe(0);
  expect(daemon.requests.slice(count).some(({ path }) => path.endsWith('/start'))).toBe(false);
});

it('fails on helper exit and still removes its exact invocation', async () => {
  const { owner, input, daemon } = await fixture();
  daemon.overrides.set(`POST /containers/${START_HELPER}/wait?condition=not-running`, {
    status: 200,
    document: { StatusCode: 1 },
  });

  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('Profile restoration failed');

  expect(daemon.containers.size).toBe(0);
});

it('keeps same-user start and drain behind canceled restoration until helper cleanup settles', async () => {
  const { owner, input, beforeRequest, daemon } = await fixture();
  const gate = startupBarrier();
  const controller = new AbortController();
  beforeRequest(async (method, path) => {
    if (method === 'DELETE' && path === `/containers/${START_HELPER}?force=true`)
      return gate.hold();
    return undefined;
  });
  const restoration = owner.restoreUserProfiles({ ...input, signal: controller.signal });
  const observed = restoration.catch((error: unknown) => error);
  await gate.reached;
  controller.abort();
  const count = daemon.requests.length;
  let drained = false;
  const drain = owner.drain().then(() => {
    drained = true;
  });
  const started = owner.startUserContainer(input);
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(daemon.requests.slice(count)).toEqual([]);
  gate.release();
  expect(await observed).toBeInstanceOf(Error);
  expect((await started).outcome).toBe('starting');
  await drain;
});

it.each(['missing-account', 'missing-index', 'retained-container', 'canonical-conflict'])(
  'refuses %s without mutation',
  async (condition) => {
    const { owner, input, database, daemon } = await fixture();
    if (condition === 'missing-index') database.prepare('DELETE FROM instances').run();
    if (condition === 'retained-container')
      database.prepare('UPDATE instances SET container_id=?').run(START_HELPER);
    if (condition === 'canonical-conflict')
      daemon.overrides.set(`GET /containers/dsh-team-u-${START_USER}/json`, {
        status: 200,
        document: {},
      });
    const count = daemon.requests.length;
    await expect(
      owner.restoreUserProfiles(
        condition === 'missing-account' ? { ...input, userId: 'zzzzzzzzzzzz' } : input,
      ),
    ).rejects.toThrow('Profile restoration failed');
    expect(daemon.requests.slice(count).every(({ method }) => method === 'GET')).toBe(true);
  },
);

it.each(['mount', 'user', 'network', 'privileged', 'capability', 'running'])(
  'does not start a helper with changed %s authority',
  async (condition) => {
    const { owner, input, daemon } = await fixture();
    daemon.beforeRequest(({ method, path }) => {
      if (method !== 'GET' || path !== `/containers/${START_HELPER}/json`) return;
      const helper = daemon.containers.get(START_HELPER);
      if (helper?.HostConfig === undefined) throw new Error('Missing test helper');
      if (condition === 'mount')
        helper.Mounts = [{ Type: 'volume', Name: 'foreign', Destination: '/data/home', RW: true }];
      if (condition === 'user') helper.Config.User = '0';
      if (condition === 'network') helper.HostConfig.NetworkMode = 'host';
      if (condition === 'privileged') helper.HostConfig.Privileged = true;
      if (condition === 'capability') helper.HostConfig.CapAdd = ['SYS_ADMIN'];
      if (condition === 'running') helper.State.Running = true;
    });
    const count = daemon.requests.length;
    await expect(owner.restoreUserProfiles(input)).rejects.toThrow('Profile restoration failed');
    expect(daemon.requests.slice(count).some(({ path }) => path.endsWith('/start'))).toBe(false);
  },
);

it('retains an unconfirmed helper and fences later reset/start after cleanup failure', async () => {
  const { owner, input, daemon } = await fixture();
  daemon.overrides.set(`DELETE /containers/${START_HELPER}?force=true`, { status: 500 });
  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('cleanup unconfirmed');
  const count = daemon.requests.length;
  await expect(owner.startUserContainer(input)).rejects.toThrow('cleanup unconfirmed');
  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('cleanup unconfirmed');
  expect(daemon.requests.length).toBe(count);
  expect(daemon.containers.has(START_HELPER)).toBe(true);
});

it('fences later starts when submitted helper creation has no trustworthy result or absence proof', async () => {
  const { owner, input, beforeRequest, daemon } = await fixture();
  beforeRequest((method, path) =>
    method === 'POST' && path.startsWith('/containers/create?')
      ? Promise.reject(new Error('Uncertain transport'))
      : Promise.resolve(undefined),
  );
  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('cleanup unconfirmed');
  const count = daemon.requests.length;
  await expect(owner.startUserContainer(input)).rejects.toThrow('cleanup unconfirmed');
  expect(daemon.requests.length).toBe(count);
});

it('fences restoration and startup after a composition helper keeps unresolved writable home access', async () => {
  const { owner, input, daemon } = await fixture();
  daemon.overrides.set(`POST /containers/${START_HELPER}/wait?condition=not-running`, {
    status: 500,
  });
  daemon.overrides.set(`DELETE /containers/${START_HELPER}?force=true`, { status: 500 });
  await expect(owner.startUserContainer(input)).rejects.toThrow(
    'managed composition cleanup failed',
  );
  expect(daemon.containers.get(START_HELPER)?.State.Running).toBe(true);
  const count = daemon.requests.length;

  await expect(owner.restoreUserProfiles(input)).rejects.toThrow('cleanup unconfirmed');
  await expect(owner.startUserContainer(input)).rejects.toThrow('cleanup unconfirmed');

  expect(daemon.requests.length).toBe(count);
});

it('settles a daemon-accepted create response before cancellation cleanup and queued start', async () => {
  const { input, daemon, database } = await fixture();
  const accepted = Promise.withResolvers<() => void>();
  const transport: DockerTransport = (options, receive) =>
    daemon.transport(options, (response) => {
      if (
        options.method === 'POST' &&
        options.path?.startsWith('/containers/create?name=dsh-team-restore-') === true
      )
        accepted.resolve(() => {
          receive(response);
        });
      else receive(response);
    });
  const owner = createOrchestrator({
    client: createDockerClient('/fixture/docker.sock', transport),
    database,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const controller = new AbortController();
  let settled = false;
  const restoration = owner
    .restoreUserProfiles({ ...input, signal: controller.signal })
    .finally(() => {
      settled = true;
    });
  const release = await accepted.promise;
  const started = owner.startUserContainer(input);
  let drained = false;
  const drain = owner.drain().then(() => {
    drained = true;
  });
  const completed = Promise.allSettled([restoration, started, drain]);
  let outcomes: Awaited<typeof completed>;
  try {
    expect(daemon.containers.has(START_HELPER)).toBe(true);
    const count = daemon.requests.length;
    controller.abort();
    await setImmediate();
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    expect(daemon.requests.length).toBe(count);
  } finally {
    release();
    outcomes = await completed;
  }
  expect(outcomes.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  const [restored, next] = outcomes;
  if (restored.status !== 'rejected' || next.status !== 'fulfilled')
    throw new Error('Unexpected restoration settlement');
  expect(restored.reason).toBeInstanceOf(Error);
  expect(next.value).toMatchObject({ outcome: 'starting' });
  expect(daemon.containers.has(START_HELPER)).toBe(false);
});

import { expect, it } from 'vitest';
import { createSession } from '../src/auth/index.ts';
import { writeSettings } from '../src/db/index.ts';
import {
  accountStatusFixture,
  capturedAdminConnection,
  expectNoRestartAudit,
  heldEmployeeStartup,
  postRestart,
  postRunning,
} from './account-status-fixture.ts';
import { START_CONTAINER, START_USER, startupBarrier } from './container-start-fixture.ts';
import { configureInstanceModel } from './instance-fixture.ts';
import { withIdleInstance } from './instance-idle-fixture.ts';

it('an administrator retry with valid configuration admits startup after the failed image lookup is removed', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    configureInstanceModel(f.database);
    const fault = 'GET /images/dsh-team-user%3Alocal/json';
    f.daemon.overrides.set(fault, { status: 500 });
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await postRestart(base, f.admin.cookie)).status).toBe(500);
    expectNoRestartAudit(f.database);
    f.daemon.overrides.delete(fault);

    expect(await postRestart(base, f.admin.cookie)).toEqual({
      status: 200,
      body: { userId: START_USER, status: 'starting', reason: 'starting' },
    });

    expect(
      f.daemon.requests.filter(
        ({ method, path }) => method === 'POST' && path === `/containers/${START_CONTAINER}/start`,
      ),
    ).toHaveLength(1);
    expect(
      f.database
        .prepare(
          "SELECT event_type,target FROM audit_events WHERE event_type IN ('instance.started','instance.restarted') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { event_type: 'instance.started', target: START_USER },
      { event_type: 'instance.restarted', target: START_USER },
    ]);
  } finally {
    await f.close();
  }
});

it.each(['stopped', 'error'] as const)(
  'single restart rejects employee startup held before persistence of a %s instance without Engine or connection effects',
  async (initial) => {
    const f = await heldEmployeeStartup(initial);
    try {
      expect(f.row).toMatchObject({ status: initial, container_id: null });

      expect((await postRestart(f.base, f.admin.cookie)).status).toBe(409);
      f.expectNoRestartEffects();

      expect(await f.releaseEmployee()).toEqual({
        status: 200,
        body: { status: 'starting', reason: 'starting' },
      });
      await f.service.stop(START_USER, 'admin');
      writeSettings(f.database, { modelApiKey: '' });
      expect(await postRestart(f.base, f.admin.cookie)).toEqual({
        status: 200,
        body: { userId: START_USER, status: 'unconfigured', reason: 'unconfigured' },
      });
      expect(f.resource.closed).toBe(true);
    } finally {
      await f.close();
    }
  },
);

it('single and bulk reject a running-set target with held employee startup work before persistence without disconnecting it', async () => {
  const f = await heldEmployeeStartup('running');
  try {
    expect((await postRestart(f.base, f.admin.cookie)).status).toBe(409);
    expect((await postRunning(f.base, f.admin.cookie)).status).toBe(409);
    f.expectNoRestartEffects();

    expect(await f.releaseEmployee()).toEqual({
      status: 200,
      body: { status: 'running', reason: null },
    });
    writeSettings(f.database, { modelApiKey: '' });
    expect(await postRunning(f.base, f.admin.cookie)).toEqual({
      status: 200,
      body: { items: [{ userId: START_USER, status: 'unconfigured', reason: 'unconfigured' }] },
    });
    expect(f.resource.closed).toBe(true);
  } finally {
    await f.close();
  }
});

it('administrator restart waits behind already-admitted idle retirement, keeps its idle reason and preserves sessions and data-volume identity', async () => {
  await withIdleInstance(async (f) => {
    if (f.app === undefined || f.base === undefined)
      throw new Error('Missing actual idle application');
    const disconnected = Promise.withResolvers<undefined>();
    const connection = capturedAdminConnection(START_USER, () => {
      disconnected.resolve(undefined);
    });
    connection.install(f.app);
    const idleStop = startupBarrier();
    const readiness = startupBarrier();
    let checking: Promise<void> | undefined;
    let restarting: Promise<Response> | undefined;
    try {
      f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(START_USER);
      const cookie = `platform_session=${createSession(f.database, START_USER, Date.now())}`;
      const sessions = f.database
        .prepare('SELECT token_hash,user_id FROM platform_sessions ORDER BY token_hash')
        .all();
      const accounts = f.database.prepare('SELECT * FROM users ORDER BY id').all();
      await f.service.checkIdle(f.getActivity);
      f.setNow(Date.now() + 60000);
      f.holdEngine((method, path) => {
        if (method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`)
          return idleStop.hold();
        if (method === 'GET' && path.includes('follow=true')) return readiness.hold();
        return undefined;
      });
      const replacement = 'f'.repeat(64);
      f.daemon.beforeRequest(({ method, path }) => {
        if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`)
          f.daemon.setContainerId(replacement);
      });
      checking = f.service.checkIdle(f.getActivity);
      await idleStop.reached;
      expect(f.service.status(START_USER)).toEqual({ status: 'starting', reason: 'starting' });
      expect(f.service.hasStartupWork(START_USER)).toBe(false);
      let completed = false;
      restarting = fetch(`${f.base}/_platform/api/admin/instances/${START_USER}/restart`, {
        method: 'POST',
        headers: { cookie, origin: 'http://instance.example', 'content-type': 'application/json' },
        body: '{}',
      }).then((response) => {
        completed = true;
        return response;
      });
      const admission = await Promise.race([
        disconnected.promise.then(() => 'captured connection'),
        restarting.then((response) => response.status),
      ]);
      expect(admission).toBe('captured connection');
      const overlap = await fetch(`${f.base}/_platform/api/admin/instances/${START_USER}/restart`, {
        method: 'POST',
        headers: { cookie, origin: 'http://instance.example', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(overlap.status).toBe(409);
      await overlap.arrayBuffer();
      expect(completed).toBe(false);
      expect(
        f.daemon.requests.filter(
          ({ method, path }) => method === 'POST' && path.startsWith('/containers/create'),
        ),
      ).toEqual([]);
      expectNoRestartAudit(f.database);

      idleStop.release();
      await checking;
      const response = await restarting;
      expect(response.status).toBe(200);
      const receipt: unknown = await response.json();
      expect(receipt).toEqual({
        userId: START_USER,
        status: 'starting',
        reason: 'starting',
      });
      await readiness.reached;

      expect(
        f.database
          .prepare(
            "SELECT event_type,target,details FROM audit_events WHERE event_type IN ('instance.stopped','instance.restarted') ORDER BY id",
          )
          .all(),
      ).toEqual([
        { event_type: 'instance.stopped', target: START_USER, details: '{"reason":"idle"}' },
        { event_type: 'instance.restarted', target: START_USER, details: '{}' },
      ]);
      expect(
        f.daemon.requests
          .filter(({ method, path }) => method === 'POST' && path.endsWith('/stop?t=1'))
          .map(({ path }) => path),
      ).toEqual([`/containers/${START_CONTAINER}/stop?t=1`]);
      const created = f.daemon.requests.find(
        ({ method, path }) =>
          method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`,
      );
      const mounts: unknown = expect.arrayContaining([
        { Type: 'volume', Source: `dsh-team-home-${START_USER}`, Target: '/data/home' },
        { Type: 'volume', Source: `dsh-team-work-${START_USER}`, Target: '/data/work' },
      ]);
      expect(created?.body).toMatchObject({
        HostConfig: {
          Mounts: mounts,
        },
      });
      expect(
        f.daemon.requests.filter(
          ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes/'),
        ),
      ).toEqual([]);
      expect(
        f.database
          .prepare('SELECT token_hash,user_id FROM platform_sessions ORDER BY token_hash')
          .all(),
      ).toEqual(sessions);
      expect(f.database.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(accounts);
      expect(
        f.database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(START_USER),
      ).toEqual({ container_id: replacement });
    } finally {
      idleStop.release();
      readiness.release();
      const pending: Promise<unknown>[] = [];
      if (checking !== undefined) pending.push(checking);
      if (restarting !== undefined) pending.push(restarting);
      await Promise.allSettled(pending);
      await connection.close();
    }
  }, true);
});

import { expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createSession } from '../src/auth/index.ts';
import { withIdleInstance } from './instance-idle-fixture.ts';
import { createGatewayConnections } from '../src/gateway/index.ts';
import { writeSettings } from '../src/db/index.ts';
import {
  accountStatusFixture,
  capturedAdminConnection,
  expectNoRestartAudit,
  postRestart,
  postRunning,
} from './account-status-fixture.ts';
import { delayedConfigBody, loseAdministratorAuthority } from './admin-config-fixture.ts';
import { START_CONTAINER, START_USER, startupBarrier } from './container-start-fixture.ts';
import { configureInstanceModel, heldReadinessLogs } from './instance-fixture.ts';
import { expectNoSecrets, registerAccount } from './auth-tcp-fixture.ts';
import { jsonRequestHeaders } from './auth-fixture.ts';
import { expectUnauthorizedResponse, withListeningApp } from './auth-tcp-fixture.ts';

it('rejects unauthenticated instance restart with the fixed Unauthorized response', async () => {
  await withListeningApp(async (base) => {
    const endpoint = `${base}/_platform/api/admin/instances/abcdefghijkl/restart`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: jsonRequestHeaders(),
      body: '{}',
    });

    await expectUnauthorizedResponse(response);
  });
});

it('protects both restart endpoints with current administrator, exact Origin and JSON authority', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    const employee = f.cookie();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const before = f.database.prepare('SELECT * FROM instances').all();
    const audits = f.database.prepare('SELECT * FROM audit_events').all();
    for (const suffix of [`${START_USER}/restart`, 'restart-running']) {
      for (const [headers, status] of [
        [jsonRequestHeaders(), 401],
        [jsonRequestHeaders({ cookie: employee, 'x-role': 'admin' }), 403],
        [jsonRequestHeaders({ cookie: f.admin.cookie, origin: undefined }), 403],
        [jsonRequestHeaders({ cookie: f.admin.cookie, origin: 'http://foreign.test' }), 403],
        [jsonRequestHeaders({ cookie: f.admin.cookie, 'content-type': 'text/plain' }), 415],
      ] as const) {
        const response = await fetch(`${base}/_platform/api/admin/instances/${suffix}`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(response.status).toBe(status);
        await response.arrayBuffer();
      }
    }
    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual(before);
    expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['single', 'bulk'] as const)(
  'rechecks the %s restart administrator after a held body loses authority',
  async (kind) => {
    for (const change of ['revoke', 'demote', 'disable'] as const) {
      let held:
        | ((
            base: string,
            cookie: string,
            body: string,
            invalidate: () => void,
          ) => Promise<{ status: number; body: string }>)
        | undefined;
      const path = `/_platform/api/admin/instances/${kind === 'single' ? `${START_USER}/restart` : 'restart-running'}`;
      const f = await accountStatusFixture((app) => {
        held = delayedConfigBody(app, path, 'POST');
      });
      try {
        f.seedRunning();
        const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
        const before = f.database.prepare('SELECT * FROM instances').all();
        if (held === undefined) throw new Error('Missing held body fixture');
        const response = await held(base, f.admin.cookie, '{}', () => {
          loseAdministratorAuthority(f.database, f.admin.user.id, change);
        });
        expect(response.status).toBe(change === 'demote' ? 403 : 401);
        expect(f.database.prepare('SELECT * FROM instances').all()).toEqual(before);
        expect(f.daemon.requests).toEqual([]);
      } finally {
        await f.close();
      }
    }
  },
);

it.each(['revoke', 'demote', 'target-disabled'] as const)(
  'rechecks authority after a captured connection closes: %s',
  async (change) => {
    const gate = startupBarrier();
    const connection = capturedAdminConnection(START_USER, () => gate.hold());
    const f = await accountStatusFixture(connection.install);
    try {
      f.seedRunning();
      const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const pending = postRestart(base, f.admin.cookie);
      await gate.reached;
      if (change === 'target-disabled')
        f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
      else loseAdministratorAuthority(f.database, f.admin.user.id, change);
      gate.release();
      const response = await pending;
      expect(response.status).toBe(change === 'revoke' ? 401 : change === 'demote' ? 403 : 409);
      expect(connection.resource.closed).toBe(true);
      expect(f.daemon.requests).toEqual([]);
      expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    } finally {
      gate.release();
      await connection.close();
      await f.close();
    }
  },
);

it('a failed connection destroy aborts restart before retirement and permits an explicit retry', async () => {
  let fail = true;
  const connection = capturedAdminConnection(START_USER, () => {
    if (fail) {
      fail = false;
      throw new Error('private-disconnect-cookie');
    }
  });
  const f = await accountStatusFixture(connection.install);
  try {
    f.seedRunning();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await postRestart(base, f.admin.cookie);
    expect(response).toEqual({
      status: 500,
      body: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    });
    expect(f.daemon.requests).toEqual([]);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    expect((await postRestart(base, f.admin.cookie)).body).toEqual({
      userId: START_USER,
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    expectNoSecrets(f.lines, response.body, ['private-disconnect-cookie']);
  } finally {
    await connection.close();
    await f.close();
  }
});

it.each(['revoke', 'demote', 'target-disabled'] as const)(
  'does not readmit after held physical retirement loses %s authority',
  async (change) => {
    const f = await accountStatusFixture();
    const gate = startupBarrier();
    try {
      f.seedRunning();
      configureInstanceModel(f.database);
      f.holdEngine(
        (method, path) => method === 'DELETE' && path === `/containers/${START_CONTAINER}`,
        gate,
      );
      const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const pending = postRestart(base, f.admin.cookie);
      await gate.reached;
      if (change === 'target-disabled')
        f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
      else loseAdministratorAuthority(f.database, f.admin.user.id, change);
      gate.release();
      const response = await pending;
      // A changed target invalidates the existing owner's retirement snapshot rather than being adopted.
      expect(response.status).toBe(change === 'revoke' ? 401 : change === 'demote' ? 403 : 500);
      expect(
        f.daemon.requests.filter(
          ({ method, path }) => method === 'POST' && path.startsWith('/containers/create'),
        ),
      ).toEqual([]);
      expectNoRestartAudit(f.database);
    } finally {
      gate.release();
      await f.close();
    }
  },
);

it('shared administrator exclusion prevents single, bulk and disable overlaps while an unrelated target progresses', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  try {
    f.seedRunning();
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES ('mnopqrstuvwx','stopped')")
      .run();
    f.holdEngine(
      (method, path) => method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`,
      gate,
    );
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const first = postRestart(base, f.admin.cookie);
    await gate.reached;
    expect((await postRestart(base, f.admin.cookie)).status).toBe(409);
    expect((await postRunning(base, f.admin.cookie)).status).toBe(409);
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(409);
    expect((await postRestart(base, f.admin.cookie, 'mnopqrstuvwx')).body).toEqual({
      userId: 'mnopqrstuvwx',
      status: 'unconfigured',
      reason: 'unconfigured',
    });
    const employee = await fetch(`${base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: jsonRequestHeaders({ cookie: f.cookie() }),
      body: '{}',
    });
    expect(employee.status).toBe(500);
    await employee.arrayBuffer();
    gate.release();
    expect((await first).status).toBe(200);
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(204);
  } finally {
    gate.release();
    await f.close();
  }
});

it('a held disable rejects restart through the exact same administrator claims', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  try {
    f.seedRunning();
    f.holdEngine(
      (method, path) => method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`,
      gate,
    );
    const disabling = f.put(START_USER, 'disabled');
    await gate.reached;
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await postRestart(base, f.admin.cookie)).status).toBe(409);
    gate.release();
    expect((await disabling).statusCode).toBe(204);
    expectNoRestartAudit(f.database);
  } finally {
    gate.release();
    await f.close();
  }
});

it('captures and claims the whole bulk running set once before awaiting; later-running and terminal users are untouched', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  const secondId = 'd'.repeat(64);
  try {
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', secondId);
    const later = await registerAccount(f.app, 'later-running@example.test');
    const error = await registerAccount(f.app, 'retained-error@example.test');
    const absent = await registerAccount(f.app, 'uncreated@example.test');
    f.database.prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')").run(later.id);
    f.database.prepare("INSERT INTO instances(user_id,status) VALUES (?,'error')").run(error.id);
    f.holdEngine(
      (method, path) => method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`,
      gate,
    );
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const first = postRunning(base, f.admin.cookie);
    await gate.reached;
    expect((await postRestart(base, f.admin.cookie, 'mnopqrstuvwx')).status).toBe(409);
    expect((await f.put('mnopqrstuvwx', 'disabled')).statusCode).toBe(409);
    f.database.prepare("UPDATE instances SET status='running' WHERE user_id=?").run(later.id);
    const untouched = f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(later.id);
    gate.release();
    expect(await first).toEqual({
      status: 200,
      body: {
        items: [
          { userId: START_USER, status: 'unconfigured', reason: 'unconfigured' },
          { userId: 'mnopqrstuvwx', status: 'unconfigured', reason: 'unconfigured' },
        ],
      },
    });
    expect(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(later.id)).toEqual(
      untouched,
    );
    expect(
      f.database.prepare('SELECT status FROM instances WHERE user_id=?').get(error.id),
    ).toEqual({ status: 'error' });
    expect(
      f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(absent.id),
    ).toBeUndefined();
    expect(
      f.daemon.requests
        .filter(({ method, path }) => method === 'POST' && path.endsWith('/stop?t=1'))
        .map(({ path }) => path),
    ).toEqual([`/containers/${START_CONTAINER}/stop?t=1`, `/containers/${secondId}/stop?t=1`]);
  } finally {
    gate.release();
    await f.close();
  }
});

it('restart follows held work on the service original FIFO instead of the fixture separate owner', async () => {
  const admitted = Promise.withResolvers<undefined>();
  const connection = capturedAdminConnection(START_USER, () => {
    admitted.resolve(undefined);
  });
  const f = await accountStatusFixture(connection.install);
  const gate = startupBarrier();
  try {
    // Preparation only: the held reconciliation always uses the service's original owner.
    await f.seedOwnedRunning();
    f.holdEngine(
      (method, path) => method === 'GET' && path === `/containers/${START_CONTAINER}/json`,
      gate,
    );
    const predecessor = f.service.reconcile();
    await gate.reached;
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    let completed = false;
    const restarting = postRestart(base, f.admin.cookie).then((value) => {
      completed = true;
      return value;
    });
    await admitted.promise;
    expect((await postRestart(base, f.admin.cookie)).status).toBe(409);
    expect(completed).toBe(false);
    expect(
      f.daemon.requests.some(({ method, path }) => method === 'POST' && path.endsWith('/stop?t=1')),
    ).toBe(false);
    gate.release();
    await predecessor;
    expect((await restarting).status).toBe(200);
  } finally {
    gate.release();
    await connection.close();
    await f.close();
  }
});

it('later employee start shares admitted readiness and disable cancels that existing flight without a new lifecycle owner', async () => {
  const logs = heldReadinessLogs('owned canceled readiness');
  const f = await accountStatusFixture(undefined, logs.adapt);
  try {
    configureInstanceModel(f.database);
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')")
      .run(START_USER);
    const cookie = f.cookie();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await postRestart(base, f.admin.cookie)).body).toEqual({
      userId: START_USER,
      status: 'starting',
      reason: 'starting',
    });
    await logs.entered;
    expect(f.service.hasStartupWork(START_USER)).toBe(true);
    expect((await postRestart(base, f.admin.cookie)).status).toBe(409);
    const employee = await fetch(`${base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: jsonRequestHeaders({ cookie }),
      body: '{}',
    });
    expect(employee.status).toBe(200);
    expect(await employee.json()).toEqual({ status: 'starting', reason: 'starting' });
    expect(
      f.daemon.requests.filter(
        ({ method, path }) =>
          method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`,
      ),
    ).toHaveLength(1);
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(204);
    expect(logs.aborted).toBe(true);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      f.database
        .prepare('SELECT status,container_id FROM instances WHERE user_id=?')
        .get(START_USER),
    ).toEqual({ status: 'stopped', container_id: null });
    expect(f.service.hasStartupWork(START_USER)).toBe(false);
    expect((await f.put(START_USER, 'active')).statusCode).toBe(204);
    writeSettings(f.database, { modelApiKey: '' });
    expect(await postRestart(base, f.admin.cookie)).toEqual({
      status: 200,
      body: { userId: START_USER, status: 'unconfigured', reason: 'unconfigured' },
    });
  } finally {
    logs.release();
    await f.close();
  }
});

it('audit failure retains admitted physical effects and earlier bulk retirement, aborts remaining users and releases claims', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', 'd'.repeat(64));
    configureInstanceModel(f.database);
    f.database.exec(
      "CREATE TRIGGER reject_restart BEFORE INSERT ON audit_events WHEN NEW.event_type='instance.restarted' BEGIN SELECT RAISE(ABORT,'private-audit-token'); END",
    );
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await postRunning(base, f.admin.cookie);
    expect(response).toEqual({
      status: 500,
      body: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    });
    expect(
      f.database
        .prepare(
          "SELECT details FROM audit_events WHERE event_type='instance.stopped' AND target=?",
        )
        .all(START_USER),
    ).toEqual([{ details: '{"reason":"admin"}' }]);
    expect(
      f.database
        .prepare("SELECT * FROM audit_events WHERE event_type='instance.started' AND target=?")
        .all(START_USER),
    ).toHaveLength(1);
    expect(f.daemon.containers.get('d'.repeat(64))?.State.Running).toBe(true);
    expect(
      f.daemon.requests.some(
        ({ method, path }) =>
          method === 'POST' && path === `/containers/${'d'.repeat(64)}/stop?t=1`,
      ),
    ).toBe(false);
    f.database.exec('DROP TRIGGER reject_restart');
    writeSettings(f.database, { modelApiKey: '' });
    expect((await postRestart(base, f.admin.cookie, 'mnopqrstuvwx')).status).toBe(200);
    expectNoSecrets(f.lines, response.body, ['private-audit-token', 'service-key']);
  } finally {
    await f.close();
  }
});

it('bulk unexpected Engine failure preserves earlier completed effects and aborts unattempted targets', async () => {
  const f = await accountStatusFixture();
  const thirdId = 'f'.repeat(64);
  try {
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', 'd'.repeat(64));
    const third = await registerAccount(f.app, 'bulk-third@example.test');
    // Capture stable userId ordering without guessing the generated account identifier.
    f.seedRunning(third.id, thirdId);
    const order = f.database
      .prepare<[], { user_id: string }>('SELECT user_id FROM instances ORDER BY user_id')
      .all();
    const firstUser = order[0]?.user_id;
    const failedUser = order[1]?.user_id;
    const remainingUser = order[2]?.user_id;
    if (firstUser === undefined || failedUser === undefined || remainingUser === undefined)
      throw new Error('Missing bulk targets');
    const failedContainer = f.database
      .prepare<[string], { container_id: string }>(
        'SELECT container_id FROM instances WHERE user_id=?',
      )
      .get(failedUser)?.container_id;
    f.daemon.overrides.set(`POST /containers/${String(failedContainer)}/stop?t=1`, { status: 500 });
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await postRunning(base, f.admin.cookie)).status).toBe(500);
    expect(
      f.database.prepare('SELECT status FROM instances WHERE user_id=?').get(firstUser),
    ).toEqual({ status: 'stopped' });
    expect(
      f.database.prepare('SELECT status FROM instances WHERE user_id=?').get(remainingUser),
    ).toEqual({ status: 'running' });
    expect(
      f.database
        .prepare("SELECT target,details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ target: firstUser, details: '{"reason":"admin"}' }]);
  } finally {
    await f.close();
  }
});

it('a disconnected client cannot abandon accepted restart or release shared claims before physical stop settles', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  try {
    f.seedRunning();
    f.holdEngine(
      (method, path) => method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`,
      gate,
    );
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(`${base}/_platform/api/admin/instances/${START_USER}/restart`, {
      method: 'POST',
      headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
      body: '{}',
      signal: controller.signal,
    }).catch(() => undefined);
    await gate.reached;
    controller.abort();
    await pending;
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(409);
    gate.release();
    const deadline = AbortSignal.timeout(2000);
    await (async () => {
      for (;;) {
        deadline.throwIfAborted();
        const result = await f.put(START_USER, 'active');
        if (result.statusCode === 204) return;
        expect(result.statusCode).toBe(409);
        await delay(10, undefined, { signal: deadline });
      }
    })();
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  } finally {
    gate.release();
    await f.close();
  }
});

it('captures the canonical actor at start admission rather than reassessing an already submitted Engine phase', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  try {
    configureInstanceModel(f.database);
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')")
      .run(START_USER);
    f.holdEngine((method, path) => method === 'GET' && path.startsWith('/images/'), gate);
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const pending = postRestart(base, f.admin.cookie);
    await gate.reached;
    loseAdministratorAuthority(f.database, f.admin.user.id, 'revoke');
    gate.release();
    expect(await pending).toEqual({
      status: 200,
      body: { userId: START_USER, status: 'starting', reason: 'starting' },
    });
    expect(
      f.database
        .prepare(
          "SELECT actor_email,target_email,target,details FROM audit_events WHERE event_type='instance.restarted'",
        )
        .all(),
    ).toEqual([
      {
        actor_email: f.admin.user.email,
        target_email: `${START_USER}@example.test`,
        target: START_USER,
        details: '{}',
      },
    ]);
  } finally {
    gate.release();
    await f.close();
  }
});

it('bulk authority loss preserves the first completed retirement and does not destructively admit later targets', async () => {
  const resource = new PassThrough();
  const destroy = resource.destroy.bind(resource);
  const connections = createGatewayConnections();
  const f = await accountStatusFixture((app) => {
    app.disconnectUserConnections = connections.disconnectUser;
  });
  try {
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', 'd'.repeat(64));
    resource.destroy = () => {
      f.database.prepare("UPDATE users SET role='employee' WHERE id=?").run(f.admin.user.id);
      return destroy();
    };
    connections.track({ userId: 'mnopqrstuvwx', token: 'owned-second-target' }, resource);
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await postRunning(base, f.admin.cookie)).status).toBe(403);
    expect(
      f.database.prepare('SELECT status FROM instances WHERE user_id=?').get(START_USER),
    ).toEqual({ status: 'stopped' });
    expect(f.daemon.containers.get('d'.repeat(64))?.State.Running).toBe(true);
    expect(
      f.database
        .prepare("SELECT target,details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ target: START_USER, details: '{"reason":"admin"}' }]);
    f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.admin.user.id);
    expect((await postRestart(base, f.admin.cookie, 'mnopqrstuvwx')).status).toBe(200);
  } finally {
    destroy();
    await connections.close();
    await f.close();
  }
});

it('restart invalidates a held idle observation and retires through that same original owner FIFO', async () => {
  await withIdleInstance(async (f) => {
    if (f.app === undefined || f.base === undefined)
      throw new Error('Missing actual idle application');
    const admitted = Promise.withResolvers<undefined>();
    const connection = capturedAdminConnection(START_USER, () => {
      admitted.resolve(undefined);
    });
    connection.install(f.app);
    const gate = startupBarrier();
    try {
      f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(START_USER);
      const cookie = `platform_session=${createSession(f.database, START_USER, Date.now())}`;
      await f.service.checkIdle(f.getActivity);
      f.setNow(Date.now() + 60000);
      f.control.probe = gate;
      const checking = f.service.checkIdle(f.getActivity);
      await gate.reached;
      writeSettings(f.database, { modelApiKey: '' });
      const restarting = fetch(`${f.base}/_platform/api/admin/instances/${START_USER}/restart`, {
        method: 'POST',
        headers: { cookie, origin: 'http://instance.example', 'content-type': 'application/json' },
        body: '{}',
      });
      await admitted.promise;
      expect(
        f.daemon.requests.some(
          ({ method, path }) => method === 'POST' && path.endsWith('/stop?t=1'),
        ),
      ).toBe(false);
      gate.release();
      await checking;
      const response = await restarting;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        userId: START_USER,
        status: 'unconfigured',
        reason: 'unconfigured',
      });
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([{ details: '{"reason":"admin"}' }]);
      expect(
        f.database
          .prepare('SELECT status,container_id FROM instances WHERE user_id=?')
          .get(START_USER),
      ).toEqual({ status: 'stopped', container_id: null });
    } finally {
      gate.release();
      await connection.close();
    }
  }, true);
});

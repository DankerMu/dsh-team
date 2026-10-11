import { PassThrough } from 'node:stream';
import { createGatewayConnections } from '../gateway/index.ts';
import { expect, it } from 'vitest';
import { accountStatusFixture } from '../../test/account-status-fixture.ts';
import { SOURCE, jsonRequestHeaders, withApp } from '../../test/auth-fixture.ts';
import { administrator } from '../../test/admin-config-fixture.ts';
import { START_CONTAINER, START_USER, startupBarrier } from '../../test/container-start-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';

it.each([
  ...[
    null,
    [],
    {},
    { status: 'disabled', role: 'admin' },
    { status: true },
    { status: ['disabled'] },
    { status: 'Disabled' },
  ].map((body) => ({
    payload: JSON.stringify(body),
    contentType: 'application/json',
    status: 400,
  })),
  { payload: '{"status":', contentType: 'application/json', status: 400 },
  {
    payload: JSON.stringify({ status: 'disabled', padding: 'x'.repeat(1048576) }),
    contentType: 'application/json',
    status: 413,
  },
  { payload: '<status>disabled</status>', contentType: 'application/xml', status: 415 },
])(
  'rejects invalid $contentType request %# as $status without mutation or disclosure',
  async ({ payload, contentType, status }) => {
    const f = await accountStatusFixture();
    try {
      const before = f.database.prepare('SELECT * FROM audit_events').all();
      const response = await f.app.inject({
        method: 'PUT',
        url: `/_platform/api/admin/users/${START_USER}/status`,
        headers: { ...jsonRequestHeaders({ cookie: f.admin.cookie }), 'content-type': contentType },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        statusCode: status,
        error:
          status === 400
            ? 'Bad Request'
            : status === 413
              ? 'Payload Too Large'
              : 'Unsupported Media Type',
        message:
          status === 400
            ? 'Invalid account status request'
            : status === 413
              ? 'Request body too large'
              : 'JSON request body required',
      });
      expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
        status: 'active',
      });
      expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
      expect(f.daemon.requests).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('protects current authority, canonical paths, self-disable and missing accounts', async () => {
  const f = await accountStatusFixture();
  try {
    expect((await f.put(START_USER, 'disabled', f.cookie())).statusCode).toBe(403);
    expect(
      (await f.put(START_USER, 'disabled', 'platform_session=' + 'a'.repeat(64))).statusCode,
    ).toBe(401);
    expect((await f.put('BAD-user', 'disabled')).statusCode).toBe(400);
    expect((await f.put('zzzzzzzzzzzz', 'disabled')).statusCode).toBe(404);
    const self = await f.put(f.admin.user.id, 'disabled');
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ message: 'Cannot disable your own account' });
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it('offline active idempotence still requires current authority while every mutation fails without effects', async () => {
  await withApp(async (app, database) => {
    const admin = await administrator(app, database);
    const target = await registerAccount(app, 'offline-target@example.test');
    const put = (status: string, cookie = admin.cookie) =>
      app.inject({
        method: 'PUT',
        url: `/_platform/api/admin/users/${target.id}/status`,
        headers: jsonRequestHeaders({ cookie }),
        payload: JSON.stringify({ status }),
      });
    const before = database.prepare('SELECT * FROM audit_events').all();
    const sessions = database
      .prepare('SELECT * FROM platform_sessions WHERE user_id=?')
      .all(target.id);
    expect((await put('active')).statusCode).toBe(204);
    expect((await put('active', 'platform_session=' + 'a'.repeat(64))).statusCode).toBe(401);
    expect((await put('disabled')).statusCode).toBe(503);
    expect(database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
      status: 'active',
    });
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
    expect(
      database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(target.id),
    ).toEqual(sessions);
    database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(target.id);
    expect((await put('active')).statusCode).toBe(503);
    expect((await put('disabled')).statusCode).toBe(503);
    expect(database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
      status: 'disabled',
    });
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
  });
});

it('retires exactly once, revokes every session and enables without resurrecting sessions or starting', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    const cookies = [f.cookie(), f.cookie()];
    const disabled = await f.put(START_USER, 'disabled');
    expect(disabled.statusCode).toBe(204);
    expect(disabled.body).toBe('');
    expect(
      f.database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(START_USER),
    ).toEqual([]);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(204);
    expect((await f.put(START_USER, 'active')).statusCode).toBe(204);
    const requests = [...f.daemon.requests];
    expect((await f.put(START_USER, 'active')).statusCode).toBe(204);
    expect(f.daemon.requests).toEqual(requests);
    expect(
      f.database
        .prepare('SELECT event_type,target,details FROM audit_events WHERE target=? ORDER BY id')
        .all(START_USER),
    ).toEqual([
      { event_type: 'account.disabled', target: START_USER, details: '{}' },
      { event_type: 'instance.stopped', target: START_USER, details: '{"reason":"disabled"}' },
      { event_type: 'account.enabled', target: START_USER, details: '{}' },
    ]);
    expect(
      f.database
        .prepare(
          "SELECT actor_email,target_email,source_address FROM audit_events WHERE event_type IN ('account.disabled','account.enabled') ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        actor_email: f.admin.user.email,
        target_email: 'abcdefghijkl@example.test',
        source_address: SOURCE,
      },
      {
        actor_email: f.admin.user.email,
        target_email: 'abcdefghijkl@example.test',
        source_address: SOURCE,
      },
    ]);
    for (const cookie of cookies)
      expect(
        (await f.app.inject({ url: '/_platform/api/instance', headers: { cookie } })).statusCode,
      ).toBe(401);
    expect(f.database.prepare('SELECT status,container_id FROM instances').get()).toEqual({
      status: 'stopped',
      container_id: null,
    });
  } finally {
    await f.close();
  }
});

it.each(['revoke', 'demote'] as const)(
  'holds exclusion through retirement, permits another target, and rechecks %s authority after enable cleanup',
  async (change) => {
    const f = await accountStatusFixture();
    const gate = startupBarrier();
    try {
      f.seedRunning();
      f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
      f.beforeRequest(async (method, path) => {
        if (method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`)
          await gate.hold();
        return undefined;
      });
      const enabling = f.put(START_USER, 'active');
      await gate.reached;
      expect((await f.put(START_USER, 'active')).statusCode).toBe(409);
      expect((await f.put(START_USER, 'disabled')).statusCode).toBe(409);
      expect((await f.put('mnopqrstuvwx', 'disabled')).statusCode).toBe(204);
      if (change === 'revoke')
        f.database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(f.admin.user.id);
      else f.database.prepare("UPDATE users SET role='employee' WHERE id=?").run(f.admin.user.id);
      gate.release();
      expect((await enabling).statusCode).toBe(change === 'revoke' ? 401 : 403);
      expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
        status: 'disabled',
      });
      expect(
        f.database.prepare("SELECT * FROM audit_events WHERE event_type='account.enabled'").all(),
      ).toEqual([]);
    } finally {
      gate.release();
      await f.close();
    }
  },
);

it('a failed external connection destroy still retires in order, retains disable and permits cleanup retry', async () => {
  const resource = new PassThrough();
  const destroy = resource.destroy.bind(resource);
  let failOnce = true;
  resource.destroy = (error) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('private-transport-cookie');
    }
    return destroy(error);
  };
  const connections = createGatewayConnections();
  connections.track({ userId: START_USER, token: 'owned-transport-session' }, resource);
  const f = await accountStatusFixture((app) => {
    // Real registry with a failed external stream; neither status workflow nor lifecycle is mocked.
    app.disconnectUserConnections = connections.disconnectUser;
  });
  try {
    f.seedRunning();
    f.cookie();
    const failed = await f.put(START_USER, 'disabled');
    expect(failed.statusCode).toBe(500);
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'disabled',
    });
    expect(
      f.database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(START_USER),
    ).toEqual([]);
    expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(resource.closed).toBe(false);
    expect((await f.put(START_USER, 'disabled')).statusCode).toBe(204);
    expect(resource.closed).toBe(true);
    expect(
      f.database
        .prepare('SELECT event_type,details FROM audit_events WHERE target=? ORDER BY id')
        .all(START_USER),
    ).toEqual([
      { event_type: 'account.disabled', details: '{}' },
      { event_type: 'instance.stopped', details: '{"reason":"disabled"}' },
    ]);
    expect(failed.body + f.lines.join('')).not.toContain('private-transport-cookie');
  } finally {
    destroy();
    await connections.close();
    await f.close();
  }
});

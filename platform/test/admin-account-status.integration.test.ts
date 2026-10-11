import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { startupBarrier } from './container-start-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { createSession } from '../src/auth/index.ts';
import { delayedConfigBody } from './admin-config-fixture.ts';
import { accountStatusFixture } from './account-status-fixture.ts';
import { START_CONTAINER, START_USER } from './container-start-fixture.ts';
import { expectNoSecrets, PASSWORD, registerAccount } from './auth-tcp-fixture.ts';
import { jsonRequestHeaders } from './auth-fixture.ts';
import { withListeningApp } from './auth-tcp-fixture.ts';

it('rejects unauthenticated account status changes with the fixed Unauthorized response', async () => {
  await withListeningApp(async (base) => {
    const endpoint = `${base}/_platform/api/admin/users/abcdefghijkl/status`;

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: jsonRequestHeaders(),
      body: JSON.stringify({ status: 'disabled' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Unauthorized',
    });
  });
});

it.each(['revoke', 'demote'] as const)(
  'rechecks current administrator after a held body %s',
  async (change) => {
    let held:
      | ((
          base: string,
          cookie: string,
          body: string,
          invalidate: () => void,
        ) => Promise<{ status: number; body: string }>)
      | undefined;
    const path = `/_platform/api/admin/users/${START_USER}/status`;
    const f = await accountStatusFixture((app) => {
      held = delayedConfigBody(app, path);
    });
    try {
      const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const before = f.database.prepare('SELECT * FROM audit_events').all();
      if (held === undefined) throw new Error('Missing held body fixture');
      const response = await held(base, f.admin.cookie, '{"status":"disabled"}', () => {
        if (change === 'revoke')
          f.database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(f.admin.user.id);
        else f.database.prepare("UPDATE users SET role='employee' WHERE id=?").run(f.admin.user.id);
      });
      expect(response.status).toBe(change === 'revoke' ? 401 : 403);
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

it('rolls account, every session and audit back before teardown when the disable audit fails', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    f.cookie();
    f.cookie();
    f.database.exec(
      "CREATE TRIGGER reject_disable BEFORE INSERT ON audit_events WHEN NEW.event_type='account.disabled' BEGIN SELECT RAISE(ABORT,'private-audit-password-cookie'); END",
    );
    const sessions = f.database
      .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
      .all(START_USER);
    const audits = f.database.prepare('SELECT * FROM audit_events').all();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
      body: '{"status":"disabled"}',
    });
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'active',
    });
    expect(
      f.database
        .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
        .all(START_USER),
    ).toEqual(sessions);
    expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
    expect(f.daemon.requests).toEqual([]);
    expectNoSecrets(f.lines, body, ['private-audit-password-cookie', 'private-dsh-cookie']);
  } finally {
    await f.close();
  }
});

it('keeps disable durable after Engine failure, refuses premature enable and retries without duplicate audits', async () => {
  const f = await accountStatusFixture();
  try {
    const target = await registerAccount(f.app, 'status-target@example.test');
    const oldCookies = [f.cookie(target.id), f.cookie(target.id)];
    f.seedRunning(target.id);
    f.daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, {
      status: 500,
      document: { message: 'private-engine-cookie' },
    });
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const put = (status: string) =>
      fetch(`${base}/_platform/api/admin/users/${target.id}/status`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
        body: JSON.stringify({ status }),
      });
    for (const status of ['disabled', 'active']) {
      const response = await put(status);
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
        status: 'disabled',
      });
    }
    for (const cookie of oldCookies) {
      const denied = await fetch(`${base}/_platform/api/instance`, { headers: { cookie } });
      expect(denied.status).toBe(401);
      await denied.arrayBuffer();
    }
    const login = () =>
      fetch(`${base}/_platform/api/login`, {
        method: 'POST',
        headers: jsonRequestHeaders(),
        body: JSON.stringify({ email: target.email, password: PASSWORD }),
      });
    const denied = await login();
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='instance.stopped'").all(),
    ).toEqual([]);
    f.daemon.overrides.delete(`POST /containers/${START_CONTAINER}/stop?t=1`);
    for (const status of ['disabled', 'disabled', 'active', 'active']) {
      const response = await put(status);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    }
    const admitted = await login();
    expect(admitted.status).toBe(200);
    await admitted.arrayBuffer();
    expect(
      f.database
        .prepare(
          "SELECT event_type,target,details FROM audit_events WHERE event_type IN ('account.disabled','account.enabled','instance.stopped') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { event_type: 'account.disabled', target: target.id, details: '{}' },
      { event_type: 'instance.stopped', target: target.id, details: '{"reason":"disabled"}' },
      { event_type: 'account.enabled', target: target.id, details: '{}' },
    ]);
    expectNoSecrets(f.lines, null, ['private-engine-cookie', 'private-dsh-cookie', PASSWORD]);
  } finally {
    await f.close();
  }
});

it('Origin and JSON rejection precede status effects and forged privilege never grants authority', async () => {
  const f = await accountStatusFixture();
  try {
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    for (const [headers, expected] of [
      [
        {
          origin: 'http://foreign.invalid',
          'content-type': 'application/json',
          cookie: f.admin.cookie,
        },
        403,
      ],
      [
        { origin: 'http://127.0.0.1:8080', 'content-type': 'text/plain', cookie: f.admin.cookie },
        415,
      ],
      [
        jsonRequestHeaders({ cookie: f.cookie(), 'x-role': 'admin', 'x-user-id': f.admin.user.id }),
        403,
      ],
    ] as const) {
      const response = await fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
        method: 'PUT',
        headers,
        body: '{"status":"disabled"}',
      });
      expect(response.status).toBe(expected);
      await response.arrayBuffer();
    }
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'active',
    });
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it('two administrators cannot concurrently disable the final available authority', async () => {
  const f = await accountStatusFixture();
  try {
    f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(START_USER);
    const otherCookie = `platform_session=${createSession(f.database, START_USER, Date.now())}`;
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const responses = await Promise.all([
      fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
        body: '{"status":"disabled"}',
      }),
      fetch(`${base}/_platform/api/admin/users/${f.admin.user.id}/status`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie: otherCookie }),
        body: '{"status":"disabled"}',
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 401]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect(
      f.database
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      f.database
        .prepare("SELECT event_type FROM audit_events WHERE event_type='account.disabled'")
        .all(),
    ).toEqual([{ event_type: 'account.disabled' }]);
  } finally {
    await f.close();
  }
});

it('activation audit failure leaves the account disabled and retired with every old session revoked', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    const oldCookie = f.cookie();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const put = (status: string) =>
      fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
        body: JSON.stringify({ status }),
      });
    const disabled = await put('disabled');
    expect(disabled.status).toBe(204);
    await disabled.arrayBuffer();
    f.database.exec(
      "CREATE TRIGGER reject_enable BEFORE INSERT ON audit_events WHEN NEW.event_type='account.enabled' BEGIN SELECT RAISE(ABORT,'private-enable-error'); END",
    );
    const response = await put('active');
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'disabled',
    });
    expect(f.database.prepare('SELECT status,container_id FROM instances').get()).toEqual({
      status: 'stopped',
      container_id: null,
    });
    const oldSession = await fetch(`${base}/_platform/api/instance`, {
      headers: { cookie: oldCookie },
    });
    expect(oldSession.status).toBe(401);
    await oldSession.arrayBuffer();
    expect(
      f.database.prepare("SELECT * FROM audit_events WHERE event_type='account.enabled'").all(),
    ).toEqual([]);
    expectNoSecrets(f.lines, body, ['private-enable-error', 'private-dsh-cookie']);
  } finally {
    await f.close();
  }
});

it('a disconnected administrator client cannot abandon accepted teardown or release same-target exclusion', async () => {
  const f = await accountStatusFixture();
  const gate = startupBarrier();
  try {
    f.seedRunning();
    f.cookie();
    f.beforeRequest(async (method, path) => {
      if (method === 'POST' && path === `/containers/${START_CONTAINER}/stop?t=1`)
        await gate.hold();
      return undefined;
    });
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const abandoned = fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
      body: '{"status":"disabled"}',
      signal: controller.signal,
    }).catch(() => undefined);
    await gate.reached;
    controller.abort();
    await abandoned;
    const busy = await fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
      body: '{"status":"active"}',
    });
    expect(busy.status).toBe(409);
    await busy.arrayBuffer();
    expect(f.database.prepare('SELECT status FROM users WHERE id=?').get(START_USER)).toEqual({
      status: 'disabled',
    });
    expect(
      f.database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(START_USER),
    ).toEqual([]);
    gate.release();
    await observeHttp(
      (async () => {
        while (f.daemon.containers.has(START_CONTAINER)) await delay(10);
        while (
          f.database
            .prepare("SELECT 1 FROM instances WHERE user_id=? AND status='stopped'")
            .get(START_USER) === undefined
        )
          await delay(10);
      })(),
      5_000,
    );
    const enabled = await fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie: f.admin.cookie }),
      body: '{"status":"active"}',
    });
    expect(enabled.status).toBe(204);
    await enabled.arrayBuffer();
    expect(
      f.database
        .prepare("SELECT event_type,details FROM audit_events WHERE event_type='instance.stopped'")
        .all(),
    ).toEqual([{ event_type: 'instance.stopped', details: '{"reason":"disabled"}' }]);
  } finally {
    gate.release();
    await f.close();
  }
});

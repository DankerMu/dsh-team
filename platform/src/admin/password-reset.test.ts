import { expect, it } from 'vitest';
import { administrator, putConfig } from '../../test/admin-config-fixture.ts';
import { registerAccount, expectNoSecrets } from '../../test/auth-tcp-fixture.ts';
import { jsonRequestHeaders, withApp } from '../../test/auth-fixture.ts';
import { snapshotPasswordState } from '../../test/password-change-fixture.ts';
import { createSession, verifyPassword } from '../auth/index.ts';

it.each([
  null,
  [],
  '123456',
  {},
  { password: '123456' },
  { newPassword: 123456 },
  { newPassword: '123456', role: 'admin' },
  { newPassword: '12345' },
  { newPassword: '𠮷'.repeat(5) },
  { newPassword: 'x'.repeat(257) },
])('rejects invalid reset envelope %# without changing any credential or audit', async (body) => {
  await withApp(async (app, database, lines) => {
    const admin = await administrator(app, database);
    const before = snapshotPasswordState(database);
    const response = await putConfig(
      app,
      `/_platform/api/admin/users/${admin.user.id}/password`,
      admin.cookie,
      JSON.stringify(body),
    );
    expect(response.statusCode).toBe(400);
    expect(snapshotPasswordState(database)).toEqual(before);
    expectNoSecrets(lines, response.json(), [admin.cookie]);
  });
});

it.each(['disabled', 'self'] as const)(
  'resets %s without promoting, enabling or issuing a session',
  async (kind) => {
    await withApp(async (app, database) => {
      const admin = await administrator(app, database);
      const target =
        kind === 'self' ? admin.user : await registerAccount(app, 'disabled@example.test');
      if (kind === 'disabled')
        database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(target.id);
      createSession(database, target.id, Date.now());
      const password = '𠮷'.repeat(6);
      const response = await putConfig(
        app,
        `/_platform/api/admin/users/${target.id}/password`,
        admin.cookie,
        JSON.stringify({ newPassword: password }),
      );
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['set-cookie']).toBeUndefined();
      const row = database
        .prepare<[string], { role: string; status: string; password_hash: string }>(
          'SELECT role,status,password_hash FROM users WHERE id=?',
        )
        .get(target.id);
      expect(row).toMatchObject({
        role: kind === 'self' ? 'admin' : 'employee',
        status: kind === 'self' ? 'active' : 'disabled',
      });
      expect(await verifyPassword(password, row?.password_hash ?? '')).toBe(true);
      expect(
        database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(target.id),
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT event_type,target,details FROM audit_events WHERE event_type='password.reset'",
          )
          .all(),
      ).toEqual([{ event_type: 'password.reset', target: target.id, details: '{}' }]);
    });
  },
);

it('classifies missing targets and malformed transport without storage effects', async () => {
  await withApp(async (app, database) => {
    const admin = await administrator(app, database);
    const before = snapshotPasswordState(database);
    for (const [id, payload, status] of [
      ['BAD-id', '{"newPassword":"123456"}', 400],
      ['missing12345', '{"newPassword":"123456"}', 404],
      [admin.user.id, '{"newPassword":', 400],
      [admin.user.id, JSON.stringify({ newPassword: 'x'.repeat(1048576) }), 413],
    ] as const) {
      expect(
        (await putConfig(app, `/_platform/api/admin/users/${id}/password`, admin.cookie, payload))
          .statusCode,
      ).toBe(status);
    }
    expect(snapshotPasswordState(database)).toEqual(before);
  });
});

it('rolls back password and revocation when its required audit cannot commit', async () => {
  await withApp(async (app, database, lines) => {
    const admin = await administrator(app, database);
    database.exec(
      "CREATE TRIGGER reject_reset BEFORE INSERT ON audit_events WHEN NEW.event_type='password.reset' BEGIN SELECT RAISE(ABORT,'private-storage-diagnostic'); END",
    );
    const before = snapshotPasswordState(database);
    const response = await putConfig(
      app,
      `/_platform/api/admin/users/${admin.user.id}/password`,
      admin.cookie,
      JSON.stringify({ newPassword: 'replacement-password' }),
    );
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(snapshotPasswordState(database)).toEqual(before);
    expectNoSecrets(lines, response.json(), ['replacement-password', 'private-storage-diagnostic']);
  });
});

it.each(['revoke', 'demote'] as const)(
  'rechecks %s administrator after entry admission',
  async (change) => {
    await withApp(async (app, database) => {
      let actorId = '';
      app.addHook('preHandler', (request, _reply, done) => {
        if (request.url.endsWith('/password')) {
          if (change === 'revoke')
            database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(actorId);
          else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(actorId);
        }
        done();
      });
      const admin = await administrator(app, database);
      actorId = admin.user.id;
      const target = await registerAccount(app, 'target@example.test');
      const before = database.prepare('SELECT * FROM users WHERE id=?').get(target.id);
      const response = await putConfig(
        app,
        `/_platform/api/admin/users/${target.id}/password`,
        admin.cookie,
        '{"newPassword":"replacement"}',
      );
      expect(response.statusCode).toBe(change === 'revoke' ? 401 : 403);
      expect(database.prepare('SELECT * FROM users WHERE id=?').get(target.id)).toEqual(before);
      expect(
        database.prepare("SELECT * FROM audit_events WHERE event_type='password.reset'").all(),
      ).toEqual([]);
    });
  },
);

it('rejects unsupported media and retains committed revocation if connection cleanup fails', async () => {
  await withApp(async (app, database) => {
    const admin = await administrator(app, database);
    const path = `/_platform/api/admin/users/${admin.user.id}/password`;
    const unsupported = await app.inject({
      method: 'PUT',
      url: path,
      headers: {
        ...jsonRequestHeaders({ cookie: admin.cookie }),
        'content-type': 'application/xml',
      },
      payload: '<password>secret</password>',
    });
    expect(unsupported.statusCode).toBe(415);
    app.disconnectUserConnections = () => Promise.reject(new Error('private-connection-error'));
    const response = await putConfig(app, path, admin.cookie, '{"newPassword":"replacement"}');
    expect(response.statusCode).toBe(500);
    expect(
      database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(admin.user.id),
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT event_type,target FROM audit_events WHERE event_type='password.reset'")
        .all(),
    ).toEqual([{ event_type: 'password.reset', target: admin.user.id }]);
  });
});

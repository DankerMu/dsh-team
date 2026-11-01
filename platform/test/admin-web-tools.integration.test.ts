import { expect, it } from 'vitest';
import { createSession } from '../src/auth/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { jsonRequestHeaders, withApp } from './auth-fixture.ts';
import { registerAccount, successfulLogin, withListeningApp } from './auth-tcp-fixture.ts';
import {
  administrator,
  delayedConfigBody,
  loseAdministratorAuthority,
  SEEDED_SETTINGS,
  settingsRows,
} from './admin-config-fixture.ts';

const PATH = '/_platform/api/admin/web-tools';
const ENABLED = JSON.stringify({ webToolsEnabled: true });
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});

it('rejects anonymous and employee callers on both methods with fixed bodies', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'web-tools-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = snapshot(database);

    for (const [headers, error] of [
      [jsonRequestHeaders(), UNAUTHORIZED],
      [jsonRequestHeaders({ cookie }), FORBIDDEN],
    ] as const) {
      const read = await fetch(`${base}${PATH}`, { headers });
      const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body: ENABLED });
      expect([read.status, saved.status]).toEqual([error.statusCode, error.statusCode]);
      expect([await read.json(), await saved.json()]).toEqual([error, error]);
    }
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(SEEDED_SETTINGS);
  });
});

it('roundtrips a logged-in administrator switch over TCP and rolls back a rejected value', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'web-tools-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });

    const initial = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body: ENABLED });
    const savedBody: unknown = await saved.json();
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });

    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ webToolsEnabled: false });
    expect(saved.status).toBe(200);
    expect(savedBody).toEqual({ webToolsEnabled: true, runningInstances: 0 });
    expect(await read.json()).toEqual({ webToolsEnabled: true });
    expect(
      database
        .prepare('SELECT actor_email, target_email, details FROM audit_events WHERE event_type = ?')
        .all('web-tools.updated'),
    ).toEqual([{ actor_email: user.email, target_email: null, details: '{}' }]);

    const before = snapshot(database);
    const rejected = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ webToolsEnabled: 'on' }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid web tools setting; provide exactly { webToolsEnabled: boolean }',
    });
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toContainEqual({ key: 'webToolsEnabled', value: 'true' });
  });
});

it.each([
  ['revoke', UNAUTHORIZED],
  ['demote', FORBIDDEN],
] as const)(
  'refuses a delayed switch after the admitted administrator loses authority (%s)',
  async (change, error) => {
    await withApp(async (app, database) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const before = snapshot(database);

      const response = await send(base, cookie, ENABLED, () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(error.statusCode);
      expect(JSON.parse(response.body)).toEqual(error);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
    });
  },
);

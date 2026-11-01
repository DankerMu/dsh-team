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

const PATH = '/_platform/api/admin/plugin-catalog';
const SENTINEL = 'PLUGIN_CATALOG_TCP_SENTINEL';
const REQUIRED = ['permission-tiers', 'platform-nav', 'zh-locale'];
const submission = (office: string, required = 'forced-on') => ({
  entries: [
    { id: 'office-agents', state: office },
    ...REQUIRED.map((id) => ({ id, state: required })),
  ],
});
const states = (body: unknown) =>
  (body as { entries: { id: string; state: string }[] }).entries.map(({ id, state }) => [
    id,
    state,
  ]);
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});

it('rejects anonymous and employee callers on both methods before touching settings', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'catalog-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = snapshot(database);
    const body = JSON.stringify(submission('forced-off'));

    for (const [headers, status] of [
      [jsonRequestHeaders(), 401],
      [jsonRequestHeaders({ cookie }), 403],
    ] as const) {
      const read = await fetch(`${base}${PATH}`, { headers });
      const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      expect([read.status, saved.status]).toEqual([status, status]);
      await Promise.all([read.text(), saved.text()]);
    }
    expect(snapshot(database)).toEqual(before);
  });
});

it('roundtrips a logged-in administrator save over TCP on the version-5 ledger and rolls back a rejected save', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'catalog-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([1, 2, 3, 4, 5].map((version) => ({ version })));

    const initial = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(submission('forced-on')),
    });
    const savedBody: unknown = await saved.json();
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });

    expect(initial.status).toBe(200);
    expect(states(await initial.json())).toEqual([
      ['office-agents', 'employee'],
      ...REQUIRED.map((id) => [id, 'forced-on']),
    ]);
    expect(saved.status).toBe(200);
    expect(savedBody).toMatchObject({ runningInstances: 0 });
    expect(await read.json()).toEqual({
      entries: (savedBody as { entries: unknown[] }).entries,
    });
    expect(states(savedBody)[0]).toEqual(['office-agents', 'forced-on']);
    expect(
      database
        .prepare('SELECT actor_email, details FROM audit_events WHERE event_type = ?')
        .all('plugin-catalog.updated'),
    ).toEqual([{ actor_email: user.email, details: '{}' }]);

    const before = snapshot(database);
    const rejected = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(submission(SENTINEL, 'forced-off')),
    });
    const error = await rejected.text();

    expect(rejected.status).toBe(400);
    expect(JSON.parse(error)).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect((error + lines.join('')).includes(SENTINEL)).toBe(false);
    expect(snapshot(database)).toEqual(before);
  });
});

it.each([
  ['revoke', 401],
  ['demote', 403],
] as const)(
  'refuses a delayed save after the admitted administrator loses authority (%s)',
  async (change, status) => {
    await withApp(async (app, database) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const before = snapshot(database);

      const response = await send(base, cookie, JSON.stringify(submission('forced-off')), () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(status);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
    });
  },
);

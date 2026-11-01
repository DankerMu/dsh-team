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

const PATH = '/_platform/api/admin/plugin-sources';
const SENTINEL = 'PLUGIN_SOURCES_TCP_SENTINEL';
const MIRROR = 'https://mirror.internal/npm/';
const SAVED = { pluginRegistries: [MIRROR], registryProbeEnabled: false };
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});

it('rejects anonymous and employee callers on both methods before touching settings', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'sources-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = snapshot(database);
    const body = JSON.stringify(SAVED);

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

it('roundtrips a logged-in administrator save over TCP and rolls back single-rule rejections', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'sources-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });

    const initial = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(SAVED),
    });
    const savedBody: unknown = await saved.json();
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });

    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
      registryProbeEnabled: true,
    });
    expect(saved.status).toBe(200);
    expect(savedBody).toEqual({ ...SAVED, runningInstances: 0 });
    expect(await read.json()).toEqual(SAVED);
    expect(
      database
        .prepare('SELECT actor_email, details FROM audit_events WHERE event_type = ?')
        .all('plugin-sources.updated'),
    ).toEqual([{ actor_email: user.email, details: '{}' }]);

    const before = snapshot(database);
    for (const [body, message] of [
      [
        { pluginRegistries: [MIRROR, `ftp://${SENTINEL}/`], registryProbeEnabled: true },
        'pluginRegistries[1] must be an http(s) URL without whitespace',
      ],
      [
        { pluginRegistries: [`https://${SENTINEL}.internal/`], registryProbeEnabled: 'off' },
        'Invalid plugin sources; provide exactly { pluginRegistries: [http(s) URL, …], registryProbeEnabled: boolean } with at least one registry',
      ],
    ] as const) {
      const rejected = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
      const error = await rejected.text();

      expect(rejected.status).toBe(400);
      expect(JSON.parse(error)).toEqual({ statusCode: 400, error: 'Bad Request', message });
      expect((error + lines.join('')).includes(SENTINEL)).toBe(false);
      expect(snapshot(database)).toEqual(before);
    }
    expect(before.settings).toContainEqual({ key: 'pluginRegistries', value: `["${MIRROR}"]` });
    expect(before.settings).toContainEqual({ key: 'registryProbeEnabled', value: 'false' });
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

      const response = await send(base, cookie, JSON.stringify(SAVED), () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(status);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
    });
  },
);

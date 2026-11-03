import { randomBytes } from 'node:crypto';
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
  seededWith,
  settingsRows,
} from './admin-config-fixture.ts';

const PATH = '/_platform/api/admin/ragflow-config';
const BASE_URL = 'https://kb.internal/ragflow';
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});
const configuration = (apiKey: string) => JSON.stringify({ baseURL: BASE_URL, apiKey });

it('rejects anonymous and employee callers on both methods with fixed bodies', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'ragflow-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const apiKey = randomBytes(32).toString('hex');
    const before = snapshot(database);

    for (const [headers, error] of [
      [jsonRequestHeaders(), UNAUTHORIZED],
      [jsonRequestHeaders({ cookie }), FORBIDDEN],
    ] as const) {
      const read = await fetch(`${base}${PATH}`, { headers });
      const body = configuration(apiKey);
      const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      expect([read.status, saved.status]).toEqual([error.statusCode, error.statusCode]);
      expect([await read.json(), await saved.json()]).toEqual([error, error]);
    }
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(SEEDED_SETTINGS);
    expect(lines.join('').includes(apiKey)).toBe(false);
  });
});

it('roundtrips a logged-in administrator save over TCP on the version-6 ledger and rolls back a rejected save', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'ragflow-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });
    const apiKey = randomBytes(32).toString('hex');
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([1, 2, 3, 4, 5, 6].map((version) => ({ version })));

    const initial = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: configuration(apiKey),
    });
    const savedBody = await saved.text();
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const readBody = await read.text();

    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ baseURL: '', apiKeyConfigured: false });
    expect(saved.status).toBe(200);
    expect(JSON.parse(savedBody)).toEqual({
      baseURL: BASE_URL,
      apiKeyConfigured: true,
      runningInstances: 0,
    });
    expect(JSON.parse(readBody)).toEqual({ baseURL: BASE_URL, apiKeyConfigured: true });
    expect(settingsRows(database)).toEqual(
      seededWith({
        ragflowBaseUrl: JSON.stringify(BASE_URL),
        ragflowApiKey: JSON.stringify(apiKey),
      }),
    );
    const audits = database
      .prepare('SELECT actor_email, target_email, details FROM audit_events WHERE event_type = ?')
      .all('ragflow-config.updated');
    expect(audits).toEqual([{ actor_email: user.email, target_email: null, details: '{}' }]);

    const before = snapshot(database);
    const rejected = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ baseURL: 'https://kb.internal/?q', apiKey: 'replacement' }),
    });
    const rejectedBody = await rejected.text();

    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejectedBody)).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(snapshot(database)).toEqual(before);
    const observed = [savedBody, readBody, rejectedBody, JSON.stringify(audits), ...lines];
    expect(observed.join('').includes(apiKey)).toBe(false);
  });
});

it.each([
  ['revoke', UNAUTHORIZED],
  ['demote', FORBIDDEN],
] as const)(
  'refuses a delayed save after the admitted administrator loses authority (%s)',
  async (change, error) => {
    await withApp(async (app, database, lines) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const apiKey = randomBytes(32).toString('hex');
      const before = snapshot(database);

      const response = await send(base, cookie, configuration(apiKey), () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(error.statusCode);
      expect(JSON.parse(response.body)).toEqual(error);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
      expect((response.body + lines.join('')).includes(apiKey)).toBe(false);
    });
  },
);

it('rolls back the previous connection when the RAGFlow audit cannot be inserted over TCP', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'ragflow-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const headers = jsonRequestHeaders({ cookie });
    const apiKey = randomBytes(32).toString('hex');
    const replacement = randomBytes(32).toString('hex');
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: configuration(apiKey),
    });
    expect(saved.status).toBe(200);
    await saved.text();
    const before = snapshot(database);
    database.exec(`CREATE TRIGGER reject_ragflow_audit BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'ragflow-config.updated' BEGIN SELECT RAISE(ABORT, '${apiKey}'); END;`);

    const response = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ baseURL: 'http://replacement.invalid', apiKey: replacement }),
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(snapshot(database)).toEqual(before);
    for (const secret of [apiKey, replacement])
      expect((body + lines.join('')).includes(secret)).toBe(false);
  });
});

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSession, deleteUserSessions } from '../src/auth/index.ts';
import { readSettings } from '../src/db/index.ts';
import { jsonRequestHeaders, withApp } from './auth-fixture.ts';
import { registerAccount, successfulLogin, withListeningApp } from './auth-tcp-fixture.ts';
import {
  administrator,
  delayedConfigBody,
  SEEDED_SETTINGS,
  settingsRows,
} from './admin-config-fixture.ts';

const PATH = '/_platform/api/admin/model-config';
const CONFIG = {
  baseURL: 'http://models.invalid/v1',
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};

it('reads fresh model configuration without exposing a credential', async () => {
  await withListeningApp(async (base, app, database) => {
    const administrator = await registerAccount(app, 'model-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(administrator.id);
    const login = await successfulLogin(base, administrator.email);

    const response = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      baseURL: '',
      apiKeyConfigured: false,
      models: [],
      defaultModel: '',
    });
  });
});

it('projects legacy extra model fields on read without rewriting stored settings or audits', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const extra = randomBytes(32).toString('hex');
    database
      .prepare("INSERT INTO settings (key, value) VALUES ('models', ?)")
      .run(JSON.stringify([{ name: 'alpha', contextWindow: 500000, contextwindow: 1, extra }]));
    const settings = database.prepare('SELECT * FROM settings ORDER BY key').all();
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();

    const response = await fetch(`${base}${PATH}`, { headers: { cookie } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      baseURL: '',
      apiKeyConfigured: false,
      models: [{ name: 'alpha', contextWindow: 500000 }],
      defaultModel: '',
    });
    expect(readSettings(database).models).toEqual([{ name: 'alpha', contextWindow: 500000 }]);
    expect(
      JSON.stringify(database.prepare('SELECT * FROM settings ORDER BY key').all()) ===
        JSON.stringify(settings),
    ).toBe(true);
    expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    expect((body + lines.join('')).includes(extra)).toBe(false);
  });
});

it('saves and replaces credentials without returning fragments and preserves an omitted key', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'model-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const first = randomBytes(32).toString('hex');
    const second = randomBytes(32).toString('hex');
    const responses: string[] = [];

    for (const apiKey of [first, undefined, second]) {
      const response = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie: login.header }),
        body: JSON.stringify({ ...CONFIG, ...(apiKey === undefined ? {} : { apiKey }) }),
      });
      const body = await response.text();
      responses.push(body);
      expect(response.status).toBe(200);
      expect(JSON.parse(body)).toEqual({ ...CONFIG, apiKeyConfigured: true, runningInstances: 0 });
      expect(readSettings(database).modelApiKey === (apiKey ?? first)).toBe(true);
    }
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    responses.push(await read.text());

    expect(JSON.parse(responses.at(-1) ?? '')).toEqual({ ...CONFIG, apiKeyConfigured: true });
    const audits = database
      .prepare("SELECT * FROM audit_events WHERE event_type = 'model-config.updated'")
      .all();
    expect(audits).toHaveLength(3);
    const output = responses.join('') + lines.join('') + JSON.stringify(audits);
    for (const key of [first, second])
      for (const fragment of [key, key.slice(0, 12), key.slice(-12)])
        expect(output.includes(fragment)).toBe(false);
  });
});

it('reports a fresh running-only save snapshot without changing instance rows or the GET contract', async () => {
  await withListeningApp(async (base, app, database) => {
    const { cookie } = await administrator(app, database);
    for (const [index, status] of [
      'running',
      'running',
      'starting',
      'stopped',
      'error',
    ].entries()) {
      const user = await registerAccount(app, `snapshot-${String(index)}@example.test`);
      database
        .prepare('INSERT INTO instances (user_id, status) VALUES (?, ?)')
        .run(user.id, status);
    }
    const save = () =>
      fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie }),
        body: JSON.stringify(CONFIG),
      });
    const before = database.prepare('SELECT * FROM instances ORDER BY user_id').all();

    const first = await save();

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ...CONFIG, apiKeyConfigured: false, runningInstances: 2 });
    expect(database.prepare('SELECT * FROM instances ORDER BY user_id').all()).toEqual(before);
    database.prepare("UPDATE instances SET status='stopped' WHERE status='running'").run();
    const repeated = await save();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      ...CONFIG,
      apiKeyConfigured: false,
      runningInstances: 0,
    });
    const read = await fetch(`${base}${PATH}`, { headers: { cookie } });
    expect(await read.json()).toEqual({ ...CONFIG, apiKeyConfigured: false });
  });
});

it('rejects invalid default and malformed or wrong-typed secret-bearing payloads without changes or echoes', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'model-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const secret = randomBytes(32).toString('hex');
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie }),
      body: JSON.stringify({ ...CONFIG, apiKey: secret }),
    });
    expect(saved.status).toBe(200);
    await saved.text();
    const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    const errors: string[] = [];

    for (const body of [
      JSON.stringify({ ...CONFIG, apiKey: secret, defaultModel: 'missing' }),
      JSON.stringify({ ...CONFIG, apiKey: secret, baseURL: 9 }),
      JSON.stringify({
        ...CONFIG,
        apiKey: secret,
        defaultModel: 'alpha',
        models: [{ name: 'alpha', contextwindow: 500000 }],
      }),
      `{"apiKey":"${secret}",broken`,
    ]) {
      const response = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie }),
        body,
      });
      expect(response.status).toBe(400);
      errors.push(await response.text());
      expect(
        JSON.stringify(database.prepare('SELECT * FROM settings ORDER BY key').all()) ===
          JSON.stringify(before),
      ).toBe(true);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    }

    expect(errors[0]).toContain('default model must be in the model list');
    expect((errors.join('') + lines.join('')).includes(secret)).toBe(false);
  });
});

it('requires an administrator and preserves Origin and JSON admission', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;

    expect((await fetch(`${base}${PATH}`)).status).toBe(401);
    expect((await fetch(`${base}${PATH}`, { headers: { cookie } })).status).toBe(403);
    const employee = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie }),
      body: '{broken',
    });
    expect(employee.status).toBe(403);
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    for (const [headers, status] of [
      [jsonRequestHeaders({ cookie, origin: undefined }), 403],
      [jsonRequestHeaders({ cookie, origin: 'http://foreign.invalid' }), 403],
      [jsonRequestHeaders({ cookie, 'content-type': 'text/plain' }), 415],
    ] as const) {
      const response = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body: '{}' });
      expect(response.status).toBe(status);
      await response.text();
    }

    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(
      database
        .prepare("SELECT * FROM audit_events WHERE event_type = 'model-config.updated'")
        .all(),
    ).toEqual([]);
  });
});

it.each(['revoked', 'demoted'] as const)(
  'rechecks the current administrator after a delayed body is admitted and %s',
  async (state) => {
    await withApp(async (app, database, lines) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const secret = randomBytes(32).toString('hex');
      const body = JSON.stringify({ ...CONFIG, apiKey: secret });
      const before = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await send(base, cookie, body, () => {
        if (state === 'revoked') deleteUserSessions(database, user.id);
        else database.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(user.id);
      });

      expect(response.status).toBe(state === 'revoked' ? 401 : 403);
      expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(before);
      expect((response.body + lines.join('')).includes(secret)).toBe(false);
    });
  },
);

it('rolls back the previous configuration when the model audit cannot be inserted over TCP', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'model-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const secret = randomBytes(32).toString('hex');
    const headers = jsonRequestHeaders({ cookie });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...CONFIG, apiKey: secret }),
    });
    expect(saved.status).toBe(200);
    await saved.text();
    const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    database.exec(`CREATE TRIGGER reject_model_audit BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'model-config.updated' BEGIN SELECT RAISE(ABORT, '${secret}'); END;`);

    const response = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...CONFIG, baseURL: 'http://replacement.invalid' }),
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
    expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    expect((body + lines.join('')).includes(secret)).toBe(false);
  });
});

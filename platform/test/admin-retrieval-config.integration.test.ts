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

const PATH = '/_platform/api/admin/retrieval-config';
const DEFAULTS = {
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
};
const CONFIG = {
  retrievalTopK: 3,
  retrievalSimilarityThreshold: 0.5,
  retrievalKeywordsWeight: 0.3,
  retrievalRerankId: 'bge-reranker-v2-m3',
};
const STORED = seededWith({
  retrievalTopK: '3',
  retrievalSimilarityThreshold: '0.5',
  retrievalKeywordsWeight: '0.3',
  retrievalRerankId: '"bge-reranker-v2-m3"',
});
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});

it('rejects anonymous and employee callers on both methods with fixed bodies', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'retrieval-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = snapshot(database);

    for (const [headers, error] of [
      [jsonRequestHeaders(), UNAUTHORIZED],
      [jsonRequestHeaders({ cookie }), FORBIDDEN],
    ] as const) {
      const read = await fetch(`${base}${PATH}`, { headers });
      const body = JSON.stringify(CONFIG);
      const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      expect([read.status, saved.status]).toEqual([error.statusCode, error.statusCode]);
      expect([await read.json(), await saved.json()]).toEqual([error, error]);
    }
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(SEEDED_SETTINGS);
  });
});

it('roundtrips a logged-in administrator save over TCP and leaves the snapshot after a domain rejection', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'retrieval-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });

    const initial = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(CONFIG),
    });
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });

    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(DEFAULTS);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ...CONFIG, runningInstances: 0 });
    expect(await read.json()).toEqual(CONFIG);
    expect(settingsRows(database)).toEqual(STORED);
    expect(
      database
        .prepare('SELECT actor_email, target_email, details FROM audit_events WHERE event_type = ?')
        .all('retrieval-config.updated'),
    ).toEqual([{ actor_email: user.email, target_email: null, details: '{}' }]);

    const before = snapshot(database);
    const message: unknown = expect.stringContaining('Invalid settings field "retrievalTopK"');
    const rejected = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...CONFIG, retrievalTopK: 101 }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ statusCode: 400, error: 'Bad Request', message });
    expect(snapshot(database)).toEqual(before);
  });
});

it.each([
  ['revoke', UNAUTHORIZED],
  ['demote', FORBIDDEN],
] as const)(
  'refuses a delayed save after the admitted administrator loses authority (%s)',
  async (change, error) => {
    await withApp(async (app, database) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const before = snapshot(database);

      const response = await send(base, cookie, JSON.stringify(CONFIG), () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(error.statusCode);
      expect(JSON.parse(response.body)).toEqual(error);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
    });
  },
);

it('rolls back the previous parameters when the retrieval audit cannot be inserted over TCP', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'retrieval-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const headers = jsonRequestHeaders({ cookie });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(CONFIG),
    });
    expect(saved.status).toBe(200);
    await saved.text();
    const before = snapshot(database);
    database.exec(`CREATE TRIGGER reject_retrieval_audit BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'retrieval-config.updated' BEGIN SELECT RAISE(ABORT, 'reject_retrieval_audit'); END;`);

    const response = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...DEFAULTS, retrievalTopK: 50 }),
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(STORED);
    for (const value of ['reject_retrieval_audit', 'SQLITE'])
      expect((body + lines.join('')).includes(value)).toBe(false);
  });
});

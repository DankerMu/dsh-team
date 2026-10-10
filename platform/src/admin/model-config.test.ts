import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSession } from '../auth/index.ts';
import { readSettings } from '../db/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';

const PATH = '/_platform/api/admin/model-config';
const CONFIG = {
  baseURL: 'http://models.invalid/v1',
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};

it('saves a safe projection and an actor/source audit without reading audits', async () => {
  await withApp(async (app, database) => {
    const user = await registerAccount(app, 'admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const apiKey = randomBytes(32).toString('hex');

    const saved = await app.inject({
      method: 'PUT',
      url: PATH,
      remoteAddress: SOURCE,
      headers: jsonRequestHeaders({ cookie }),
      payload: { ...CONFIG, apiKey },
    });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...CONFIG, apiKeyConfigured: true });
    expect(read.json()).toEqual(saved.json());
    expect(readSettings(database).modelApiKey === apiKey).toBe(true);
    expect(
      database
        .prepare(
          "SELECT actor_email, source_address, details FROM audit_events WHERE event_type = 'model-config.updated'",
        )
        .all(),
    ).toEqual([{ actor_email: user.email, source_address: SOURCE, details: '{}' }]);
  });
});

it.each([
  ['missing fields', {}],
  ['array', []],
  ['null', null],
  ['numeric address', { ...CONFIG, baseURL: 9 }],
  ['blank address', { ...CONFIG, baseURL: ' \t' }],
  ['numeric default', { ...CONFIG, defaultModel: 9 }],
  ['blank default', { ...CONFIG, defaultModel: '' }],
  ['absent default', { ...CONFIG, defaultModel: 'missing' }],
  ['case mismatch', { ...CONFIG, defaultModel: 'Beta' }],
  ['empty key', { ...CONFIG, apiKey: '' }],
  ['blank key', { ...CONFIG, apiKey: ' \t' }],
  ['numeric key', { ...CONFIG, apiKey: 9 }],
  ['null key', { ...CONFIG, apiKey: null }],
  ['unknown field', { ...CONFIG, modelApiKey: 'not-accepted' }],
  ['invalid models', { ...CONFIG, models: {} }],
  ['blank name', { ...CONFIG, models: [{ name: ' ' }] }],
  ['numeric name', { ...CONFIG, models: [{ name: 9 }] }],
  ['string context', { ...CONFIG, models: [{ name: 'beta', contextWindow: '500000' }] }],
  ['zero context', { ...CONFIG, models: [{ name: 'beta', contextWindow: 0 }] }],
  ['unsafe context', { ...CONFIG, models: [{ name: 'beta', contextWindow: 2 ** 53 }] }],
])('rejects %s before changing settings or auditing', async (_label, payload) => {
  await withApp(async (app, database) => {
    const user = await registerAccount(app, 'admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = database.prepare('SELECT * FROM audit_events').all();

    const response = await app.inject({
      method: 'PUT',
      url: PATH,
      headers: jsonRequestHeaders({ cookie }),
      payload: JSON.stringify(payload),
    });

    expect(response.statusCode).toBe(400);
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
  });
});

it.each(['audit', 'write', 'read', 'corrupt-json', 'corrupt-type', 'corrupt-default'] as const)(
  'returns safe storage failure and rolls back for %s failure',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const user = await registerAccount(app, 'admin@example.com');
      database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
      const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit' || boundary === 'write') {
        database.exec(
          `CREATE TRIGGER reject_model_save BEFORE INSERT ON ${boundary === 'audit' ? 'audit_events' : 'settings'} BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else if (boundary === 'read') database.exec('DROP TABLE settings');
      else
        database
          .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
          .run(
            boundary === 'corrupt-default' ? 'defaultModel' : 'modelApiKey',
            boundary === 'corrupt-json'
              ? `{${secret}`
              : boundary === 'corrupt-default'
                ? '"missing"'
                : 'false',
          );
      const before = database.prepare('SELECT * FROM audit_events').all();

      const response = await app.inject({
        method: 'PUT',
        url: PATH,
        headers: jsonRequestHeaders({ cookie }),
        payload: { ...CONFIG, apiKey: secret },
      });
      const read = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary !== 'audit' && boundary !== 'write') {
        expect(read.statusCode).toBe(500);
        expect(read.json()).toEqual(INTERNAL_ERROR);
      } else expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
      for (const value of [secret, 'SQLITE', 'no such table', 'reject_model_save'])
        expect((response.body + read.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

it('preserves body-size and JSON media classifications without echoing secret values', async () => {
  await withApp(async (app, database, lines) => {
    const user = await registerAccount(app, 'admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const secret = randomBytes(32).toString('hex');
    const before = database.prepare('SELECT * FROM audit_events').all();

    const oversized = await app.inject({
      method: 'PUT',
      url: PATH,
      headers: jsonRequestHeaders({ cookie }),
      payload: JSON.stringify({ ...CONFIG, apiKey: secret, padding: 'x'.repeat(1048576) }),
    });
    const unsupported = await app.inject({
      method: 'PUT',
      url: PATH,
      headers: jsonRequestHeaders({ cookie, 'content-type': 'text/plain' }),
      payload: JSON.stringify({ ...CONFIG, apiKey: secret }),
    });

    expect(oversized.statusCode).toBe(413);
    expect(unsupported.statusCode).toBe(415);
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
    expect((oversized.body + unsupported.body + lines.join('')).includes(secret)).toBe(false);
  });
});

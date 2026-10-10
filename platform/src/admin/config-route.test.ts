import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { deleteUserSessions } from '../auth/index.ts';
import { jsonRequestHeaders, withApp } from '../../test/auth-fixture.ts';
import { administrator, MODEL_CONFIG as CONFIG } from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/model-config';
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};

it.each(['audit', 'write', 'read', 'corrupt-json', 'corrupt-type', 'corrupt-default'] as const)(
  'returns safe storage failure and rolls back for %s failure',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
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
    const { cookie } = await administrator(app, database);
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

it.each(['audit', 'write', 'corrupt-json', 'corrupt-type', 'corrupt-model-key'] as const)(
  'runtime configuration returns a safe storage failure and preserves rows for %s',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit' || boundary === 'write') {
        database.exec(
          `CREATE TRIGGER reject_runtime_save BEFORE INSERT ON ${boundary === 'audit' ? 'audit_events' : 'settings'} BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare('INSERT INTO settings VALUES (?, ?)')
          .run(
            boundary === 'corrupt-model-key' ? 'modelApiKey' : 'maxRunningInstances',
            boundary === 'corrupt-json' ? `{${secret}` : 'false',
          );
      }
      const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const path = '/_platform/api/admin/runtime-config';
      const response = await app.inject({
        method: 'PUT',
        url: path,
        headers: jsonRequestHeaders({ cookie }),
        payload: {
          idleMinutes: 15,
          cpuCores: 0.25,
          memoryMiB: 2048,
          maxRunningInstances: 2,
          defaultPermissionTier: 'auto',
        },
      });
      const read = await app.inject({ url: path, headers: { cookie } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary !== 'audit' && boundary !== 'write') {
        expect(read.statusCode).toBe(500);
        expect(read.json()).toEqual(INTERNAL_ERROR);
      }
      expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
      for (const value of [secret, 'SQLITE', 'reject_runtime_save'])
        expect((response.body + read.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

it.each(['model', 'runtime'] as const)(
  'sanitizes malformed JSON on the %s configuration route',
  async (name) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await app.inject({
        method: 'PUT',
        url: `/_platform/api/admin/${name}-config`,
        headers: jsonRequestHeaders({ cookie }),
        payload: `{"modelApiKey":"${secret}",broken`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Bad Request' });
      expect((response.body + lines.join('')).includes(secret)).toBe(false);
      expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    });
  },
);

it.each([
  ['model', 'revoked', 401],
  ['model', 'demoted', 403],
  ['runtime', 'revoked', 401],
  ['runtime', 'demoted', 403],
] as const)(
  'fences %s configuration commits after the admitted administrator is %s',
  async (name, state, status) => {
    await withApp(async (app, database) => {
      const path = `/_platform/api/admin/${name}-config`;
      app.addHook('preValidation', (request, _reply, done) => {
        if (request.url === path && request.method === 'PUT') {
          if (state === 'revoked') deleteUserSessions(database, user.id);
          else database.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(user.id);
        }
        done();
      });
      const { user, cookie } = await administrator(app, database);
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await app.inject({
        method: 'PUT',
        url: path,
        headers: jsonRequestHeaders({ cookie }),
        payload:
          name === 'model'
            ? CONFIG
            : {
                idleMinutes: 15,
                cpuCores: 0.25,
                memoryMiB: 2048,
                maxRunningInstances: 2,
                defaultPermissionTier: 'auto',
              },
      });
      expect(response.statusCode).toBe(status);
      expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    });
  },
);

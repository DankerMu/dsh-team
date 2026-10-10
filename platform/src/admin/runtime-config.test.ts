import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { readSettings, writeSettings } from '../db/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import { administrator, putConfig } from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/runtime-config';
const CONFIG = {
  idleMinutes: 15,
  cpuCores: 0.25,
  memoryMiB: 2048,
  maxRunningInstances: 2,
  defaultPermissionTier: 'approval',
};

it('saves only runtime fields and an actor/source audit while preserving model credentials and unowned rows', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const secret = randomBytes(32).toString('hex');
    const models = {
      modelBaseUrl: 'http://models.invalid/v1',
      modelApiKey: secret,
      models: [{ name: 'alpha' }],
      defaultModel: 'alpha',
    };
    writeSettings(database, models);
    database.prepare('INSERT INTO settings VALUES (?, ?)').run('unowned', 'unchanged');

    const saved = await app.inject({
      method: 'PUT',
      url: PATH,
      remoteAddress: SOURCE,
      headers: jsonRequestHeaders({ cookie }),
      payload: CONFIG,
    });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(CONFIG);
    expect(read.json()).toEqual(CONFIG);
    expect(readSettings(database)).toMatchObject(models);
    expect(database.prepare("SELECT value FROM settings WHERE key = 'unowned'").get()).toEqual({
      value: 'unchanged',
    });
    expect(
      database
        .prepare(
          "SELECT actor_email, source_address, details FROM audit_events WHERE event_type = 'runtime-config.updated'",
        )
        .all(),
    ).toEqual([{ actor_email: user.email, source_address: SOURCE, details: '{}' }]);
    expect((saved.body + read.body).includes(secret)).toBe(false);
  });
});

it.each([
  {
    idleMinutes: 1,
    cpuCores: Number.MIN_VALUE,
    memoryMiB: 1,
    maxRunningInstances: 1,
    defaultPermissionTier: 'approval',
  },
  {
    idleMinutes: Number.MAX_SAFE_INTEGER,
    cpuCores: Number.MAX_VALUE,
    memoryMiB: Number.MAX_SAFE_INTEGER,
    maxRunningInstances: Number.MAX_SAFE_INTEGER,
    defaultPermissionTier: 'auto',
  },
  { ...CONFIG, defaultPermissionTier: 'yolo' },
])('roundtrips canonical legal boundaries and permission tiers: %j', async (payload) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const saved = await app.inject({
      method: 'PUT',
      url: PATH,
      headers: jsonRequestHeaders({ cookie }),
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(payload);
    expect((await app.inject({ url: PATH, headers: { cookie } })).json()).toEqual(payload);
  });
});

const INVALID: [string, unknown][] = [
  ['missing fields', {}],
  ['array', []],
  ['null', null],
  ...Object.keys(CONFIG).map<[string, unknown]>((field) => [
    'missing ' + field,
    Object.fromEntries(Object.entries(CONFIG).filter(([key]) => key !== field)),
  ]),
  ...['idleMinutes', 'cpuCores', 'memoryMiB', 'maxRunningInstances'].flatMap((field) =>
    [0, -1, '2', null, false, [], {}].map<[string, unknown]>((value) => [
      field + ' ' + JSON.stringify(value),
      { ...CONFIG, [field]: value },
    ]),
  ),
  ...['idleMinutes', 'memoryMiB', 'maxRunningInstances'].flatMap((field) =>
    [0.5, 2 ** 53].map<[string, unknown]>((value) => [
      field + ' ' + String(value),
      { ...CONFIG, [field]: value },
    ]),
  ),
  ...['YOLO', 'toString', 'invalid-private-tier', 1, null].map<[string, unknown]>((value) => [
    'tier ' + String(value),
    { ...CONFIG, defaultPermissionTier: value },
  ]),
  ...['unknown', 'apiKey', 'modelApiKey', 'models', 'modelBaseUrl', 'defaultModel'].map<
    [string, unknown]
  >((field) => ['unknown ' + field, { ...CONFIG, [field]: 'private-input-sentinel' }]),
];

it.each(INVALID)(
  'rejects %s with canonical ranges and no settings or audit changes',
  async (_label, payload) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      writeSettings(database, CONFIG);
      const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await putConfig(app, PATH, cookie, JSON.stringify(payload));

      expect(response.statusCode).toBe(400);
      const { message } = response.json<{ message: string }>();
      expect(message).toContain('1..9007199254740991');
      expect(message).toContain('finite positive');
      expect(message).toContain('approval');
      expect(message).toContain('auto');
      expect(message).toContain('yolo');
      expect((response.body + lines.join('')).includes('private-input-sentinel')).toBe(false);
      expect((response.body + lines.join('')).includes('invalid-private-tier')).toBe(false);
      expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    });
  },
);

it.each(['1e400', '-1e400'])('rejects nonfinite CPU parsed from JSON %s', async (cpu) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const before = database.prepare('SELECT * FROM audit_events').all();
    const response = await putConfig(
      app,
      PATH,
      cookie,
      JSON.stringify(CONFIG).replace('0.25', cpu),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('cpuCores');
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
  });
});

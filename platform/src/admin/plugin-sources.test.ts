import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import {
  administrator,
  putConfig,
  SEEDED_SETTINGS,
  settingsRows,
} from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/plugin-sources';
const DEFAULTS = {
  pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  registryProbeEnabled: true,
};
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    'Invalid plugin sources; provide exactly { pluginRegistries: [http(s) URL, …], registryProbeEnabled: boolean } with at least one registry',
};
const SENTINEL = 'PLUGIN_SOURCES_INPUT_SENTINEL';
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const MIRROR = 'https://mirror.internal/npm/';
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, source_address, details FROM audit_events WHERE event_type = 'plugin-sources.updated'",
    )
    .all();
const allAudits = (database: DatabaseHandle) =>
  database.prepare('SELECT * FROM audit_events ORDER BY id').all();
const sourceRows = (registries: string[], probe: boolean) => [
  SEEDED_SETTINGS[0],
  { key: 'pluginRegistries', value: JSON.stringify(registries) },
  { key: 'registryProbeEnabled', value: String(probe) },
  SEEDED_SETTINGS[3],
];
const save = (app: FastifyInstance, cookie: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: PATH,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders({ cookie }),
    payload: JSON.stringify(payload),
  });

it('reports the seeded DSH default registries with the registry probe enabled', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await app.inject({ url: PATH, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULTS);
  });
});

it('saves both keys as whole values with one actor/source audit and a running-instance snapshot', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);

    const saved = await save(app, cookie, {
      pluginRegistries: [MIRROR],
      registryProbeEnabled: false,
    });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      pluginRegistries: [MIRROR],
      registryProbeEnabled: false,
      runningInstances: 0,
    });
    expect(read.json()).toEqual({ pluginRegistries: [MIRROR], registryProbeEnabled: false });
    expect(settingsRows(database)).toEqual(sourceRows([MIRROR], false));
    expect(audits(database)).toEqual([
      { actor_email: user.email, source_address: SOURCE, details: '{}' },
    ]);
  });
});

it('replaces the whole registry list on the next save without merging the previous one', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const registries = ['http://second.internal/', MIRROR];
    await save(app, cookie, { pluginRegistries: [MIRROR], registryProbeEnabled: false });

    const saved = await save(app, cookie, {
      pluginRegistries: registries,
      registryProbeEnabled: true,
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      pluginRegistries: registries,
      registryProbeEnabled: true,
      runningInstances: 0,
    });
    expect(settingsRows(database)).toEqual(sourceRows(registries, true));
    expect(audits(database)).toHaveLength(2);
  });
});

it('accepts a registry carrying userinfo credentials and never logs or audits them', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const registry = 'https://user:secret@mirror.internal/';

    const saved = await save(app, cookie, {
      pluginRegistries: [registry],
      registryProbeEnabled: true,
    });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(read.json()).toEqual({ pluginRegistries: [registry], registryProbeEnabled: true });
    expect(lines.join('').includes('secret')).toBe(false);
    expect(JSON.stringify(allAudits(database)).includes('secret')).toBe(false);
  });
});

it.each([
  ['a non-object body', SENTINEL],
  ['an array body', [SENTINEL]],
  ['null', null],
  ['a missing registryProbeEnabled', { pluginRegistries: [MIRROR] }],
  ['an extra key', { pluginRegistries: [MIRROR], registryProbeEnabled: true, [SENTINEL]: 1 }],
  ['non-array registries', { pluginRegistries: SENTINEL, registryProbeEnabled: true }],
  ['an empty registry list', { pluginRegistries: [], registryProbeEnabled: true }],
  ['a string probe flag', { pluginRegistries: [MIRROR], registryProbeEnabled: 'true' }],
  ['a numeric probe flag', { pluginRegistries: [MIRROR], registryProbeEnabled: 1 }],
  ['a null probe flag', { pluginRegistries: [MIRROR], registryProbeEnabled: null }],
])(
  'rejects %s with the fixed message and leaves settings and audits unchanged',
  async (_label, payload) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const before = allAudits(database);

      const response = await putConfig(app, PATH, cookie, JSON.stringify(payload));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(INVALID);
      expect((response.body + lines.join('')).includes(SENTINEL)).toBe(false);
      expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
      expect(allAudits(database)).toEqual(before);
    });
  },
);

it.each([
  ['an ftp URL', `ftp://${SENTINEL}/`],
  ['a URL containing whitespace', `https://a ${SENTINEL}`],
  ['a bare scheme', 'https://'],
  ['an empty string', ''],
  ['a non-string item', { [SENTINEL]: 1 }],
])('rejects %s as the second registry naming only its index', async (_label, item) => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const before = allAudits(database);

    const response = await save(app, cookie, {
      pluginRegistries: [MIRROR, item, `ftp://${SENTINEL}-later/`],
      registryProbeEnabled: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ...INVALID,
      message: 'pluginRegistries[1] must be an http(s) URL without whitespace',
    });
    expect((response.body + lines.join('')).includes(SENTINEL)).toBe(false);
    expect(response.body.includes('mirror.internal')).toBe(false);
    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(allAudits(database)).toEqual(before);
  });
});

it.each(['audit', 'write', 'corrupt-json', 'corrupt-type'] as const)(
  'returns a safe storage failure and keeps settings and audits for %s',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit' || boundary === 'write') {
        database.exec(
          `CREATE TRIGGER reject_sources_save BEFORE INSERT ON ${boundary === 'audit' ? 'audit_events' : 'settings'} BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare('UPDATE settings SET value = ? WHERE key = ?')
          .run(
            ...(boundary === 'corrupt-json'
              ? [`{${secret}`, 'pluginRegistries']
              : ['"true"', 'registryProbeEnabled']),
          );
      }
      const settings = settingsRows(database);
      const before = allAudits(database);

      const response = await save(app, cookie, {
        pluginRegistries: [`https://user:${secret}@mirror.internal/`],
        registryProbeEnabled: false,
      });
      const read = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary === 'audit' || boundary === 'write') {
        expect(settings).toEqual(SEEDED_SETTINGS);
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual(DEFAULTS);
      } else {
        expect(read.statusCode).toBe(500);
        expect(read.json()).toEqual(INTERNAL_ERROR);
      }
      expect(settingsRows(database)).toEqual(settings);
      expect(allAudits(database)).toEqual(before);
      for (const value of [secret, 'SQLITE', 'reject_sources_save'])
        expect((response.body + read.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

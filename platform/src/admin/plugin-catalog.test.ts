import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import type * as CatalogModule from '../plugin-catalog/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import {
  administrator,
  putConfig,
  SEEDED_SETTINGS,
  settingsRows,
} from '../../test/admin-config-fixture.ts';

const fault = vi.hoisted(() => ({ unreadable: false }));
vi.mock('../plugin-catalog/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return {
    ...actual,
    readPluginCatalog: (path?: string) => {
      if (fault.unreadable) throw new Error('Plugin catalog fault injected');
      return actual.readPluginCatalog(path);
    },
  };
});
afterEach(() => {
  fault.unreadable = false;
});

const PATH = '/_platform/api/admin/plugin-catalog';
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    'Invalid plugin catalog; provide exactly { entries: [{ id, state }] } covering every catalog entry once. ' +
    'Allowed states: employee | forced-on | forced-off; required entries must be forced-on',
};
const SENTINEL = 'PLUGIN_CATALOG_INPUT_SENTINEL';
const ENTRIES = [
  {
    id: 'office-agents',
    package: '@dsh-team/office-agents',
    name: '办公 Agent',
    category: 'manageable',
    imageDefaultEnabled: true,
    state: 'employee',
  },
  {
    id: 'permission-tiers',
    package: '@dsh-team/permission-tiers',
    name: '权限档',
    category: 'required',
    imageDefaultEnabled: false,
    state: 'forced-on',
  },
  {
    id: 'platform-nav',
    package: '@dsh-team/platform-nav',
    name: '平台入口',
    category: 'required',
    imageDefaultEnabled: false,
    state: 'forced-on',
  },
  {
    id: 'zh-locale',
    package: '@dsh-team/zh-locale',
    name: '中文界面',
    category: 'required',
    imageDefaultEnabled: false,
    state: 'forced-on',
  },
];
const officeAs = (state: string) =>
  ENTRIES.map((entry) => (entry.id === 'office-agents' ? { ...entry, state } : entry));
const submission = (office: string, extra: { id: string; state: unknown }[] = []) => [
  { id: 'office-agents', state: office },
  { id: 'permission-tiers', state: 'forced-on' },
  { id: 'platform-nav', state: 'forced-on' },
  { id: 'zh-locale', state: 'forced-on' },
  ...extra,
];
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, source_address, details FROM audit_events WHERE event_type = 'plugin-catalog.updated'",
    )
    .all();
const storedCatalog = (database: DatabaseHandle) =>
  database.prepare("SELECT value FROM settings WHERE key = 'pluginCatalog'").get();
const save = (app: FastifyInstance, cookie: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: PATH,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders({ cookie }),
    payload: JSON.stringify(payload),
  });

it('reports every catalog entry in file order with required entries forced on and office employee-chosen', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await app.inject({ url: PATH, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entries: ENTRIES });
  });
});

it('saves only manageable states with one actor/source audit and a running-instance snapshot', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);

    const saved = await save(app, cookie, { entries: submission('forced-off') });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ entries: officeAs('forced-off'), runningInstances: 0 });
    expect(read.json()).toEqual({ entries: officeAs('forced-off') });
    expect(settingsRows(database)).toEqual([
      { key: 'pluginCatalog', value: '{"office-agents":"forced-off"}' },
      ...SEEDED_SETTINGS.slice(1),
    ]);
    expect(audits(database)).toEqual([
      { actor_email: user.email, source_address: SOURCE, details: '{}' },
    ]);
  });
});

it('ignores a stored id no longer in the catalog and drops it on the next whole-map save', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    database
      .prepare("UPDATE settings SET value = ? WHERE key = 'pluginCatalog'")
      .run('{"retired-plugin":"forced-off","office-agents":"forced-on"}');

    const read = await app.inject({ url: PATH, headers: { cookie } });
    const saved = await save(app, cookie, { entries: submission('employee') });

    expect(read.json()).toEqual({ entries: officeAs('forced-on') });
    expect(saved.statusCode).toBe(200);
    expect(storedCatalog(database)).toEqual({ value: '{"office-agents":"employee"}' });
  });
});

it.each([
  [
    'a required entry set to employee',
    { entries: submission('employee').with(1, { id: 'permission-tiers', state: 'employee' }) },
  ],
  [
    'a required entry set to forced-off',
    { entries: submission('employee').with(3, { id: 'zh-locale', state: 'forced-off' }) },
  ],
  [
    'an unknown id',
    { entries: submission('employee').with(2, { id: SENTINEL, state: 'forced-on' }) },
  ],
  ['a missing entry', { entries: submission('employee').slice(1) }],
  [
    'a duplicate id',
    { entries: submission('employee', [{ id: 'office-agents', state: 'employee' }]) },
  ],
  [
    'an extra unknown entry',
    { entries: submission('employee', [{ id: SENTINEL, state: 'employee' }]) },
  ],
  ['an open state', { entries: submission(SENTINEL) }],
  [
    'a non-string state',
    { entries: submission('employee').with(0, { id: 'office-agents', state: true }) },
  ],
  ['an extra envelope key', { entries: submission('employee'), [SENTINEL]: true }],
  [
    'an extra entry key',
    {
      entries: submission('employee').with(0, {
        id: 'office-agents',
        state: 'employee',
        [SENTINEL]: 1,
      } as never),
    },
  ],
  ['a non-object entry', { entries: submission('employee').with(0, SENTINEL as never) }],
  ['non-array entries', { entries: { id: SENTINEL } }],
  ['an empty object', {}],
  ['null', null],
  ['an array body', [SENTINEL]],
])(
  'rejects %s with the fixed message and leaves settings and audits unchanged',
  async (_label, payload) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const before = database.prepare('SELECT * FROM audit_events ORDER BY id').all();

      const response = await putConfig(app, PATH, cookie, JSON.stringify(payload));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(INVALID);
      expect((response.body + lines.join('')).includes(SENTINEL)).toBe(false);
      expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(before);
    });
  },
);

it('fails application construction when the catalog cannot be read', async () => {
  fault.unreadable = true;

  await expect(withApp(() => Promise.resolve())).rejects.toThrow('Plugin catalog fault injected');
});

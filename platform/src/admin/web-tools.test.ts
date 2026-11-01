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

const PATH = '/_platform/api/admin/web-tools';
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'Invalid web tools setting; provide exactly { webToolsEnabled: boolean }',
};
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const SENTINEL = 'WEB_TOOLS_INPUT_SENTINEL';
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, target_email, source_address, details FROM audit_events WHERE event_type = 'web-tools.updated'",
    )
    .all();
const allAudits = (database: DatabaseHandle) =>
  database.prepare('SELECT * FROM audit_events ORDER BY id').all();
const save = (app: FastifyInstance, cookie: string, webToolsEnabled: boolean) =>
  app.inject({
    method: 'PUT',
    url: PATH,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders({ cookie }),
    payload: JSON.stringify({ webToolsEnabled }),
  });
const withWebTools = (value: string) => [
  ...SEEDED_SETTINGS.slice(0, 3),
  { key: 'webToolsEnabled', value },
];

it('reports the seeded web tools switch as off', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await app.inject({ url: PATH, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ webToolsEnabled: false });
  });
});

it('saves only the switch with one actor/source audit and turns it back off', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const audit = { actor_email: user.email, target_email: null, source_address: SOURCE };

    const enabled = await save(app, cookie, true);
    const readEnabled = await app.inject({ url: PATH, headers: { cookie } });

    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ webToolsEnabled: true, runningInstances: 0 });
    expect(readEnabled.json()).toEqual({ webToolsEnabled: true });
    expect(settingsRows(database)).toEqual(withWebTools('true'));
    expect(audits(database)).toEqual([{ ...audit, details: '{}' }]);

    const disabled = await save(app, cookie, false);
    const readDisabled = await app.inject({ url: PATH, headers: { cookie } });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ webToolsEnabled: false, runningInstances: 0 });
    expect(readDisabled.json()).toEqual({ webToolsEnabled: false });
    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(audits(database)).toEqual([
      { ...audit, details: '{}' },
      { ...audit, details: '{}' },
    ]);
  });
});

it.each([
  // Each label names the patch() rule whose deletion alone turns that case red. Envelope-shape
  // bodies have no single such rule (object and key-set rules each reject them), and an empty
  // object turns red only when both the key-set and boolean rules are gone.
  ['a null body (object rule)', null],
  ['an array body (envelope shape)', [SENTINEL]],
  ['a string body (envelope shape)', SENTINEL],
  ['an empty object (key-set and boolean rules)', {}],
  ['an extra key (key-set rule)', { webToolsEnabled: true, [SENTINEL]: 1 }],
  ['a string value (boolean rule)', { webToolsEnabled: 'true' }],
  ['a numeric value (boolean rule)', { webToolsEnabled: 1 }],
  ['a null value (boolean rule)', { webToolsEnabled: null }],
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

it.each(['audit', 'write', 'corrupt-json', 'corrupt-type'] as const)(
  'returns a safe storage failure and keeps settings and audits for %s',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit' || boundary === 'write') {
        database.exec(
          `CREATE TRIGGER reject_web_tools_save BEFORE INSERT ON ${boundary === 'audit' ? 'audit_events' : 'settings'} BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare("UPDATE settings SET value = ? WHERE key = 'webToolsEnabled'")
          .run(boundary === 'corrupt-json' ? `{${secret}` : '"yes"');
      }
      const settings = settingsRows(database);
      const before = allAudits(database);

      const response = await save(app, cookie, true);
      const read = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary === 'audit' || boundary === 'write') {
        expect(settings).toEqual(SEEDED_SETTINGS);
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({ webToolsEnabled: false });
      } else {
        expect(read.statusCode).toBe(500);
        expect(read.json()).toEqual(INTERNAL_ERROR);
      }
      expect(settingsRows(database)).toEqual(settings);
      expect(allAudits(database)).toEqual(before);
      for (const value of [secret, 'SQLITE', 'reject_web_tools_save'])
        expect((response.body + read.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

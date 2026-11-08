import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import { SOURCE, withApp } from '../../test/auth-fixture.ts';
import {
  administrator,
  putConfig,
  SEEDED_SETTINGS,
  seededWith,
  settingsRows,
} from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/ragflow-config';
const BASE_URL = 'https://kb.internal/';
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    'Invalid RAGFlow configuration; provide { baseURL: http(s) URL without credentials, query or fragment, apiKey?: non-blank string }',
};
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const SENTINEL = 'RAGFLOW_INPUT_SENTINEL';
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, target_email, source_address, details FROM audit_events WHERE event_type = 'ragflow-config.updated'",
    )
    .all();
const allAudits = (database: DatabaseHandle) =>
  database.prepare('SELECT * FROM audit_events ORDER BY id').all();
const read = (app: FastifyInstance, cookie: string) =>
  app.inject({ url: PATH, headers: { cookie } });

it('reports the seeded connection as unconfigured', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await read(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ baseURL: '', apiKeyConfigured: false });
  });
});

it('saves address and key with one actor/source audit, then keeps the key when omitted', async () => {
  await withApp(async (app, database, lines) => {
    const { user, cookie } = await administrator(app, database);
    const apiKey = `${SENTINEL}-${randomBytes(16).toString('hex')}`;
    const audit = { actor_email: user.email, target_email: null, source_address: SOURCE };

    const saved = await putConfig(app, PATH, cookie, { baseURL: BASE_URL, apiKey }, SOURCE);
    const first = await read(app, cookie);

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      baseURL: BASE_URL,
      apiKeyConfigured: true,
      runningInstances: 0,
    });
    expect(first.json()).toEqual({ baseURL: BASE_URL, apiKeyConfigured: true });
    expect(settingsRows(database)).toEqual(
      seededWith({
        ragflowBaseUrl: JSON.stringify(BASE_URL),
        ragflowApiKey: JSON.stringify(apiKey),
      }),
    );
    expect(audits(database)).toEqual([{ ...audit, details: '{}' }]);

    const moved = await putConfig(app, PATH, cookie, { baseURL: 'http://10.0.0.5:9380' }, SOURCE);
    const second = await read(app, cookie);

    expect(moved.json()).toEqual({
      baseURL: 'http://10.0.0.5:9380',
      apiKeyConfigured: true,
      runningInstances: 0,
    });
    expect(second.json()).toEqual({ baseURL: 'http://10.0.0.5:9380', apiKeyConfigured: true });
    expect(settingsRows(database)).toEqual(
      seededWith({
        ragflowBaseUrl: '"http://10.0.0.5:9380"',
        ragflowApiKey: JSON.stringify(apiKey),
      }),
    );
    expect(audits(database)).toEqual([
      { ...audit, details: '{}' },
      { ...audit, details: '{}' },
    ]);
    const observed = [saved.body, first.body, moved.body, second.body, ...lines].join('');
    expect(observed.includes(apiKey)).toBe(false);
  });
});

it.each(['https://kb.internal/ragflow', 'http://[::1]:9380'])(
  'saves a first address %s without a key as unconfigured and returns it verbatim',
  async (baseURL) => {
    await withApp(async (app, database) => {
      const { cookie } = await administrator(app, database);

      const saved = await putConfig(app, PATH, cookie, { baseURL }, SOURCE);
      const after = await read(app, cookie);

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ baseURL, apiKeyConfigured: false, runningInstances: 0 });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ baseURL, apiKeyConfigured: false });
      expect(settingsRows(database)).toEqual(
        seededWith({ ragflowBaseUrl: JSON.stringify(baseURL) }),
      );
    });
  },
);

it.each([
  // Each label names the patch() rule that isolates the case; address cases name the
  // isRagflowBaseUrl rule that alone rejects that input.
  ['a null body (object rule)', null],
  ['an array body (object rule)', [SENTINEL]],
  ['a string body (object rule)', SENTINEL],
  ['a missing baseURL (string rule)', { apiKey: SENTINEL }],
  ['an extra key (key-set rule)', { baseURL: BASE_URL, [SENTINEL]: 1 }],
  ['a numeric baseURL (string rule)', { baseURL: 9 }],
  [
    'an inner tab the URL parser strips (raw whitespace rule)',
    { baseURL: `https://kb.internal/\t${SENTINEL}` },
  ],
  ['an empty apiKey (non-blank key rule)', { baseURL: BASE_URL, apiKey: '' }],
  ['a blank apiKey (non-blank key rule)', { baseURL: BASE_URL, apiKey: '   ' }],
  ['a numeric apiKey (key string rule)', { baseURL: BASE_URL, apiKey: 9 }],
  ['an ftp address (protocol rule)', { baseURL: `ftp://${SENTINEL}.internal/` }],
  ['credentials (raw @ rule)', { baseURL: `https://user:${SENTINEL}@kb.internal/` }],
  ['an empty userinfo (raw @ rule)', { baseURL: `https://@kb.internal/${SENTINEL}` }],
  ['a query (raw ? rule)', { baseURL: `https://kb.internal/?${SENTINEL}` }],
  ['an empty query (raw ? rule)', { baseURL: `https://kb.internal/${SENTINEL}?` }],
  ['a fragment (raw # rule)', { baseURL: `https://kb.internal/#${SENTINEL}` }],
  ['an empty fragment (raw # rule)', { baseURL: `https://kb.internal/${SENTINEL}#` }],
  [
    'surrounding whitespace (raw whitespace rule)',
    { baseURL: ` https://kb.internal/${SENTINEL} ` },
  ],
  ['inner whitespace (raw whitespace rule)', { baseURL: `https://kb.internal/${SENTINEL} x` }],
  ['an inner line break (raw whitespace rule)', { baseURL: `https://kb.internal/\n${SENTINEL}` }],
  ['a C0 control character (raw control rule)', { baseURL: `https://kb.internal/\x01${SENTINEL}` }],
  ['a backslash (raw backslash rule)', { baseURL: `https://kb.internal\\${SENTINEL}` }],
  [
    'more than 2048 characters (raw length rule)',
    { baseURL: `https://kb.internal/${SENTINEL}${'a'.repeat(2048)}` },
  ],
  ['an unparseable address (URL parse rule)', { baseURL: `https//${SENTINEL}` }],
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
          `CREATE TRIGGER reject_ragflow_save BEFORE INSERT ON ${boundary === 'audit' ? 'audit_events' : 'settings'} BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare("UPDATE settings SET value = ? WHERE key = 'ragflowBaseUrl'")
          .run(boundary === 'corrupt-json' ? `{${secret}` : '"ftp://x"');
      }
      const settings = settingsRows(database);
      const before = allAudits(database);

      const response = await putConfig(
        app,
        PATH,
        cookie,
        { baseURL: BASE_URL, apiKey: secret },
        SOURCE,
      );
      const after = await read(app, cookie);

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary === 'audit' || boundary === 'write') {
        expect(settings).toEqual(SEEDED_SETTINGS);
        expect(after.statusCode).toBe(200);
        expect(after.json()).toEqual({ baseURL: '', apiKeyConfigured: false });
      } else {
        expect(after.statusCode).toBe(500);
        expect(after.json()).toEqual(INTERNAL_ERROR);
      }
      expect(settingsRows(database)).toEqual(settings);
      expect(allAudits(database)).toEqual(before);
      for (const value of [secret, 'SQLITE', 'reject_ragflow_save'])
        expect((response.body + after.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

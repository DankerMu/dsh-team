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

const PATH = '/_platform/api/admin/document-server';
const EXTERNAL_URL = 'https://office.internal/ds/';
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    "Invalid Document Server configuration; provide { mode: 'bundled' } or { mode: 'external', url: http(s) URL without credentials, query or fragment, jwtSecret?: non-blank string }",
};
const PAIRING = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'External Document Server requires jwtSecret',
};
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const SENTINEL = 'DOCUMENT_SERVER_INPUT_SENTINEL';
const BUNDLED = { mode: 'bundled', bundledConfigured: false, url: '', jwtConfigured: false };
const jwt = () => `${SENTINEL}-${randomBytes(16).toString('hex')}`;
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, target_email, source_address, details FROM audit_events WHERE event_type = 'document-server-config.updated'",
    )
    .all();
const allAudits = (database: DatabaseHandle) =>
  database.prepare('SELECT * FROM audit_events ORDER BY id').all();
const read = (app: FastifyInstance, cookie: string) =>
  app.inject({ url: PATH, headers: { cookie } });

it('reports the seeded bundled mode without a bundled deployment', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await read(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(BUNDLED);
  });
});

it('reports a configured bundled deployment without echoing its container name or JWT', async () => {
  const containerName = `container-${SENTINEL}`;
  const jwtSecret = jwt();
  await withApp(
    async (app, database, lines) => {
      const { cookie } = await administrator(app, database);

      const initial = await read(app, cookie);
      const saved = await putConfig(app, PATH, cookie, { mode: 'bundled' }, SOURCE);

      expect(initial.json()).toEqual({ ...BUNDLED, bundledConfigured: true });
      expect(saved.json()).toEqual({ ...BUNDLED, bundledConfigured: true, runningInstances: 0 });
      const observed = [initial.body, saved.body, ...lines].join('');
      for (const value of [containerName, jwtSecret]) expect(observed.includes(value)).toBe(false);
    },
    false,
    [],
    undefined,
    { documentServer: { containerName, jwtSecret } },
  );
});

it('switches to external, keeps an omitted JWT, replaces a supplied one and clears both on bundled', async () => {
  await withApp(async (app, database, lines) => {
    const { user, cookie } = await administrator(app, database);
    const first = jwt();
    const second = ` ${jwt()} `;
    const audit = { actor_email: user.email, target_email: null, source_address: SOURCE };
    const external = { mode: 'external', bundledConfigured: false, jwtConfigured: true };

    const saved = await putConfig(
      app,
      PATH,
      cookie,
      {
        mode: 'external',
        url: EXTERNAL_URL,
        jwtSecret: first,
      },
      SOURCE,
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...external, url: EXTERNAL_URL, runningInstances: 0 });
    expect((await read(app, cookie)).json()).toEqual({ ...external, url: EXTERNAL_URL });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: JSON.stringify(EXTERNAL_URL),
        documentServerJwtSecret: JSON.stringify(first),
      }),
    );

    const moved = await putConfig(
      app,
      PATH,
      cookie,
      { mode: 'external', url: 'http://10.0.0.7' },
      SOURCE,
    );
    expect(moved.json()).toEqual({ ...external, url: 'http://10.0.0.7', runningInstances: 0 });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: '"http://10.0.0.7"',
        documentServerJwtSecret: JSON.stringify(first),
      }),
    );

    const replaced = await putConfig(
      app,
      PATH,
      cookie,
      {
        mode: 'external',
        url: 'http://10.0.0.7',
        jwtSecret: second,
      },
      SOURCE,
    );
    expect(replaced.json()).toEqual({ ...external, url: 'http://10.0.0.7', runningInstances: 0 });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: '"http://10.0.0.7"',
        documentServerJwtSecret: JSON.stringify(second),
      }),
    );

    const bundled = await putConfig(app, PATH, cookie, { mode: 'bundled' }, SOURCE);
    expect(bundled.json()).toEqual({ ...BUNDLED, runningInstances: 0 });
    expect((await read(app, cookie)).json()).toEqual(BUNDLED);
    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(audits(database)).toEqual(
      Array.from({ length: 4 }, () => ({ ...audit, details: '{}' })),
    );
    const observed = [saved.body, moved.body, replaced.body, bundled.body, ...lines].join('');
    for (const value of [first, second.trim()]) expect(observed.includes(value)).toBe(false);
  });
});

it('rejects a first external save without a JWT through the pairing rule and rolls back', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const before = allAudits(database);

    const response = await putConfig(
      app,
      PATH,
      cookie,
      { mode: 'external', url: EXTERNAL_URL },
      SOURCE,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(PAIRING);
    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(allAudits(database)).toEqual(before);
  });
});

it('accepts an omitted JWT when a stored JWT already pairs with the new address', async () => {
  const stored = jwt();
  await withApp(
    async (app, database) => {
      const { cookie } = await administrator(app, database);

      const response = await putConfig(
        app,
        PATH,
        cookie,
        { mode: 'external', url: EXTERNAL_URL },
        SOURCE,
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        mode: 'external',
        bundledConfigured: false,
        url: EXTERNAL_URL,
        jwtConfigured: true,
        runningInstances: 0,
      });
      expect(response.body.includes(stored)).toBe(false);
    },
    false,
    [],
    undefined,
    { initialSettings: { documentServerJwtSecret: stored } },
  );
});

it.each([
  ['a null body (object rule)', null],
  ['an array body (object rule)', [SENTINEL]],
  ['a string body (object rule)', SENTINEL],
  ['an empty object (mode rule)', {}],
  ['an unknown mode (mode rule)', { mode: SENTINEL }],
  ['a numeric mode (mode rule)', { mode: 1 }],
  ['bundled with a url (bundled key-set rule)', { mode: 'bundled', url: EXTERNAL_URL }],
  ['bundled with a JWT (bundled key-set rule)', { mode: 'bundled', jwtSecret: SENTINEL }],
  [
    'an external extra key (external key-set rule)',
    { mode: 'external', url: EXTERNAL_URL, [SENTINEL]: 1 },
  ],
  ['an external body without url (url string rule)', { mode: 'external', jwtSecret: SENTINEL }],
  ['a numeric url (url string rule)', { mode: 'external', url: 9, jwtSecret: SENTINEL }],
  ['an empty url (address rule)', { mode: 'external', url: '', jwtSecret: SENTINEL }],
  [
    'a url with credentials (address rule)',
    { mode: 'external', url: `https://user:${SENTINEL}@office.internal/`, jwtSecret: 'x' },
  ],
  [
    'a url with a query (address rule)',
    { mode: 'external', url: `https://office.internal/?${SENTINEL}`, jwtSecret: 'x' },
  ],
  ['an empty JWT (non-blank rule)', { mode: 'external', url: EXTERNAL_URL, jwtSecret: '' }],
  ['a blank JWT (non-blank rule)', { mode: 'external', url: EXTERNAL_URL, jwtSecret: ' \t ' }],
  ['a numeric JWT (JWT string rule)', { mode: 'external', url: EXTERNAL_URL, jwtSecret: 9 }],
  ['a null JWT (JWT string rule)', { mode: 'external', url: EXTERNAL_URL, jwtSecret: null }],
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

it.each(['audit', 'corrupt'] as const)(
  'returns a safe storage failure and keeps settings and audits for %s',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit') {
        database.exec(
          `CREATE TRIGGER reject_document_server_save BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare("UPDATE settings SET value = ? WHERE key = 'documentServerUrl'")
          .run('"ftp://x"');
      }
      const settings = settingsRows(database);
      const before = allAudits(database);

      const response = await putConfig(
        app,
        PATH,
        cookie,
        {
          mode: 'external',
          url: EXTERNAL_URL,
          jwtSecret: secret,
        },
        SOURCE,
      );
      const after = await read(app, cookie);

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      expect(after.json()).toEqual(boundary === 'audit' ? BUNDLED : INTERNAL_ERROR);
      expect(settingsRows(database)).toEqual(settings);
      expect(allAudits(database)).toEqual(before);
      for (const value of [secret, 'SQLITE', 'reject_document_server_save'])
        expect((response.body + after.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);

import { randomBytes } from 'node:crypto';
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

const PATH = '/_platform/api/admin/document-server';
const EXTERNAL_URL = 'https://office.internal/ds';
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, error: 'Forbidden', message: 'Forbidden' };
const INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message:
    "Invalid Document Server configuration; provide { mode: 'bundled' } or { mode: 'external', url: http(s) URL without credentials, query or fragment, jwtSecret?: non-blank string }",
};
const PAIRING = { ...INVALID, message: 'External Document Server requires jwtSecret' };
const MARKER = 'DOCUMENT_SERVER_JWT_MARKER';
const BUNDLED = { mode: 'bundled', bundledConfigured: false, url: '', jwtConfigured: false };
const EXTERNAL = { mode: 'external', bundledConfigured: false, url: EXTERNAL_URL };
const snapshot = (database: DatabaseHandle) => ({
  settings: settingsRows(database),
  audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
});
const jwt = () => `${MARKER}-${randomBytes(16).toString('hex')}`;
const external = (jwtSecret: string) =>
  JSON.stringify({ mode: 'external', url: EXTERNAL_URL, jwtSecret });
const audits = (database: DatabaseHandle) =>
  database
    .prepare('SELECT actor_email, target_email, details FROM audit_events WHERE event_type = ?')
    .all('document-server-config.updated');

it('rejects anonymous and employee callers on both methods with fixed bodies', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'document-server-employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    const before = snapshot(database);

    for (const [headers, error] of [
      [jsonRequestHeaders(), UNAUTHORIZED],
      [jsonRequestHeaders({ cookie }), FORBIDDEN],
    ] as const) {
      const read = await fetch(`${base}${PATH}`, { headers });
      const saved = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers,
        body: external(jwt()),
      });
      expect([read.status, saved.status]).toEqual([error.statusCode, error.statusCode]);
      expect([await read.json(), await saved.json()]).toEqual([error, error]);
    }
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(SEEDED_SETTINGS);
    expect(lines.join('').includes(MARKER)).toBe(false);
  });
});

it.each([
  ['revoke', UNAUTHORIZED],
  ['demote', FORBIDDEN],
  ['disable', UNAUTHORIZED],
] as const)(
  'refuses a delayed save after the admitted administrator loses authority (%s)',
  async (change, error) => {
    await withApp(async (app, database, lines) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const before = snapshot(database);

      const response = await send(base, cookie, external(jwt()), () => {
        loseAdministratorAuthority(database, user.id, change);
      });

      expect(response.status).toBe(error.statusCode);
      expect(JSON.parse(response.body)).toEqual(error);
      expect(snapshot(database)).toEqual(before);
      expect(before.settings).toEqual(SEEDED_SETTINGS);
      expect((response.body + lines.join('')).includes(MARKER)).toBe(false);
    });
  },
);

it('walks bundled → external → keep JWT → replace JWT → bundled over TCP on the version-7 ledger', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'document-server-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });
    const put = async (body: string) => {
      const response = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      return { status: response.status, body: await response.text() };
    };
    const get = async () =>
      (await fetch(`${base}${PATH}`, { headers: { cookie: login.header } })).text();
    const first = jwt();
    const second = jwt();
    const audit = { actor_email: user.email, target_email: null, details: '{}' };
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([1, 2, 3, 4, 5, 6, 7].map((version) => ({ version })));
    const bodies: string[] = [];

    const initial = await get();
    expect(JSON.parse(initial)).toEqual(BUNDLED);

    const saved = await put(external(first));
    const afterSave = await get();
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toEqual({
      ...EXTERNAL,
      jwtConfigured: true,
      runningInstances: 0,
    });
    expect(JSON.parse(afterSave)).toEqual({ ...EXTERNAL, jwtConfigured: true });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: JSON.stringify(EXTERNAL_URL),
        documentServerJwtSecret: JSON.stringify(first),
      }),
    );
    expect(audits(database)).toEqual([audit]);

    const moved = await put(JSON.stringify({ mode: 'external', url: 'http://10.0.0.7:8000' }));
    expect(JSON.parse(moved.body)).toEqual({
      ...EXTERNAL,
      url: 'http://10.0.0.7:8000',
      jwtConfigured: true,
      runningInstances: 0,
    });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: '"http://10.0.0.7:8000"',
        documentServerJwtSecret: JSON.stringify(first),
      }),
    );

    const replaced = await put(external(second));
    expect(JSON.parse(replaced.body)).toEqual({
      ...EXTERNAL,
      jwtConfigured: true,
      runningInstances: 0,
    });
    expect(settingsRows(database)).toEqual(
      seededWith({
        documentServerUrl: JSON.stringify(EXTERNAL_URL),
        documentServerJwtSecret: JSON.stringify(second),
      }),
    );

    const bundled = await put(JSON.stringify({ mode: 'bundled' }));
    const afterBundled = await get();
    expect(JSON.parse(bundled.body)).toEqual({ ...BUNDLED, runningInstances: 0 });
    expect(JSON.parse(afterBundled)).toEqual(BUNDLED);
    expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
    expect(audits(database)).toEqual([audit, audit, audit, audit]);

    bodies.push(initial, saved.body, afterSave, moved.body, replaced.body, bundled.body);
    const observed = [...bodies, afterBundled, JSON.stringify(audits(database)), ...lines];
    for (const value of [first, second, MARKER])
      expect(observed.join('').includes(value)).toBe(false);
  });
});

it.each([
  ['a null body', 'null'],
  ['an array body', JSON.stringify([MARKER])],
  ['an unknown field', JSON.stringify({ mode: 'external', url: EXTERNAL_URL, [MARKER]: 1 })],
  ['another mode', JSON.stringify({ mode: MARKER })],
  ['bundled with an extra key', JSON.stringify({ mode: 'bundled', jwtSecret: MARKER })],
  ['a numeric url', JSON.stringify({ mode: 'external', url: 1, jwtSecret: MARKER })],
  ['a fragment url', JSON.stringify({ mode: 'external', url: `${EXTERNAL_URL}#${MARKER}` })],
  ['a blank JWT', JSON.stringify({ mode: 'external', url: EXTERNAL_URL, jwtSecret: '   ' })],
  ['a numeric JWT', JSON.stringify({ mode: 'external', url: EXTERNAL_URL, jwtSecret: 7 })],
])(
  'rejects %s with the fixed 400 and leaves settings and audits unchanged',
  async (_label, body) => {
    await withListeningApp(async (base, app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const before = snapshot(database);

      const response = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie }),
        body,
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual(INVALID);
      expect(snapshot(database)).toEqual(before);
      expect((text + lines.join('')).includes(MARKER)).toBe(false);
    });
  },
);

it('rejects a first external save without a JWT and rolls back the address', async () => {
  await withListeningApp(async (base, app, database) => {
    const { cookie } = await administrator(app, database);
    const before = snapshot(database);

    const response = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie }),
      body: JSON.stringify({ mode: 'external', url: EXTERNAL_URL }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(PAIRING);
    expect(snapshot(database)).toEqual(before);
    expect(before.settings).toEqual(SEEDED_SETTINGS);
  });
});

it('rolls back the previous external configuration when the audit cannot be inserted over TCP', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const headers = jsonRequestHeaders({ cookie });
    const first = jwt();
    const replacement = jwt();
    const saved = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body: external(first) });
    expect(saved.status).toBe(200);
    await saved.text();
    const before = snapshot(database);
    database.exec(`CREATE TRIGGER reject_document_server_audit BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'document-server-config.updated' BEGIN SELECT RAISE(ABORT, '${first}'); END;`);

    for (const body of [external(replacement), JSON.stringify({ mode: 'bundled' })]) {
      const response = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      expect(snapshot(database)).toEqual(before);
      for (const value of [first, replacement, 'reject_document_server_audit', 'SQLITE'])
        expect((text + lines.join('')).includes(value)).toBe(false);
    }
  });
});

it.each([
  ['no bundled deployment', null, false],
  ['a bundled deployment', 'configured', true],
] as const)(
  'reports bundledConfigured for %s without echoing bundled container name or JWT',
  async (_label, deployment, bundledConfigured) => {
    const containerName = `dsh-team-documentserver-${MARKER}-name`;
    const jwtSecret = `${MARKER}-${randomBytes(16).toString('hex')}`;
    const documentServer = deployment === null ? null : { containerName, jwtSecret };
    await withListeningApp(
      async (base, app, database, lines) => {
        const { cookie } = await administrator(app, database);
        const headers = jsonRequestHeaders({ cookie });
        const externalJwt = jwt();

        const initial = await fetch(`${base}${PATH}`, { headers: { cookie } });
        const toExternal = await fetch(`${base}${PATH}`, {
          method: 'PUT',
          headers,
          body: external(externalJwt),
        });
        const toBundled = await fetch(`${base}${PATH}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ mode: 'bundled' }),
        });
        const bodies = [await initial.text(), await toExternal.text(), await toBundled.text()];

        expect(bodies.map((body) => JSON.parse(body) as unknown)).toEqual([
          { ...BUNDLED, bundledConfigured },
          { ...EXTERNAL, bundledConfigured, jwtConfigured: true, runningInstances: 0 },
          { ...BUNDLED, bundledConfigured, runningInstances: 0 },
        ]);
        const observed = [...bodies, ...lines].join('');
        for (const value of [containerName, jwtSecret, externalJwt, MARKER])
          expect(observed.includes(value)).toBe(false);
      },
      false,
      [],
      { documentServer },
    );
  },
);

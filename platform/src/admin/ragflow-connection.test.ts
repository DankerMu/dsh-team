import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createSession } from '../auth/index.ts';
import { writeSettings } from '../db/index.ts';
import { jsonRequestHeaders, withApp } from '../../test/auth-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';
import {
  administrator,
  loseAdministratorAuthority,
  settingsRows,
} from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/ragflow-config/test';
const BASE = 'https://ragflow.invalid/kb';

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(
  app: Parameters<Parameters<typeof withApp>[0]>[0],
  cookie: string | undefined,
  payload = '{}',
  contentType = 'application/json',
) {
  return app.inject({
    method: 'POST',
    url: PATH,
    headers: { ...jsonRequestHeaders({ cookie }), 'content-type': contentType },
    payload,
  });
}
function audits(database: Parameters<typeof settingsRows>[0]) {
  return database.prepare('SELECT * FROM audit_events ORDER BY id').all();
}

it('returns not-configured without contacting RAGFlow while nothing is saved', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const before = [settingsRows(database), audits(database)];

    const response = await post(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'not-configured' });
    expect([settingsRows(database), audits(database)]).toEqual(before);
    expect(lines.join('')).toContain('Administrator RAGFlow connection test failed');
    expect(lines.join('')).toContain('"result":"not-configured"');
  });
});

it('keeps a saved key that cannot form a header out of the response and logs', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const sentinel = `owned-${randomBytes(16).toString('hex')}`;
    writeSettings(database, { ragflowBaseUrl: BASE, ragflowApiKey: `${sentinel}\nX: y` });

    const response = await post(app, cookie);

    expect(response.json()).toEqual({ result: 'not-configured' });
    const output = response.body + lines.join('');
    for (const value of [sentinel, BASE, 'ragflow.invalid']) expect(output).not.toContain(value);
  });
});

it('rejects anonymous and employee callers', async () => {
  await withApp(async (app, database) => {
    const employee = await registerAccount(app, 'employee@example.com');
    const employeeCookie = `platform_session=${createSession(database, employee.id, Date.now())}`;

    const anonymous = await post(app, undefined);
    const forbidden = await post(app, employeeCookie);

    expect([anonymous.statusCode, anonymous.json()]).toEqual([
      401,
      { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
    ]);
    expect([forbidden.statusCode, forbidden.json()]).toEqual([
      403,
      { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
    ]);
  });
});

it.each([
  ['null', 'application/json', 400, 'Empty RAGFlow connection test body required'],
  ['{"baseURL":"x"}', 'application/json', 400, 'Empty RAGFlow connection test body required'],
  ['[]', 'application/json', 400, 'Empty RAGFlow connection test body required'],
  [`{"p":"${'x'.repeat(1_048_576)}"}`, 'application/json', 413, 'Request body too large'],
  ['{}', 'text/plain', 415, 'JSON request body required'],
])('rejects body %# with %s %i', async (payload, contentType, status, message) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await post(app, cookie, payload, contentType);

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ statusCode: status, message });
  });
});

it('sanitizes corrupted stored settings as a fixed 500', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    database.prepare("UPDATE settings SET value = '{private' WHERE key = 'ragflowBaseUrl'").run();

    const response = await post(app, cookie);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(lines.join('')).toContain('Administrator RAGFlow connection test failure');
    expect(response.body + lines.join('')).not.toContain('private');
  });
});

it.each([
  ['revoke', 401],
  ['demote', 403],
] as const)('rechecks authority after the body is read: %s gives %i', async (change, status) => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    writeSettings(database, { ragflowBaseUrl: BASE, ragflowApiKey: 'owned-key' });
    const send = vi.fn(() => Promise.reject(new TypeError('unexpected request')));
    vi.stubGlobal('fetch', send);
    let sent = false;
    // Body bytes are pulled only after entry admission, so the change lands between both checks.
    const payload = new Readable({
      read() {
        if (sent) return;
        sent = true;
        loseAdministratorAuthority(database, user.id, change);
        this.push('{}');
        this.push(null);
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: jsonRequestHeaders({ cookie }),
      payload,
    });

    expect(sent).toBe(true);
    expect(response.statusCode).toBe(status);
    expect(send).not.toHaveBeenCalled();
  });
});

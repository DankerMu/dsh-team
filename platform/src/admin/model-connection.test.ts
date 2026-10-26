import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { writeSettings } from '../db/index.ts';
import { jsonRequestHeaders, withApp } from '../../test/auth-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';
import { administrator, loseAdministratorAuthority } from '../../test/admin-config-fixture.ts';
import { createSession } from '../auth/index.ts';

const PATH = '/_platform/api/admin/model-config/test';
const MODELS = { models: [{ name: 'alpha' }], defaultModel: 'alpha' };

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

it('returns unconfigured without contacting a model when saved settings are incomplete', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    writeSettings(database, { modelBaseUrl: 'http://127.0.0.1:9/v1', ...MODELS });

    const response = await post(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'unconfigured', httpStatus: null, elapsedMs: 0 });
    expect(lines.join('')).toContain('Administrator model connection test failed');
    expect(lines.join('')).toContain('"result":"unconfigured"');
  });
});

it.each([
  ['invalid-address', 'www.dmxapi.cn/v1', randomBytes(16).toString('hex')],
  ['invalid-key', 'http://127.0.0.1:9/v1', `owned-${randomBytes(16).toString('hex')}\r\nX: y`],
])('returns %s for saved values without echoing them', async (result, address, key) => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    writeSettings(database, { modelBaseUrl: address, modelApiKey: key, ...MODELS });

    const response = await post(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result, httpStatus: null, elapsedMs: 0 });
    const output = response.body + lines.join('');
    for (const value of [address, key, key.slice(0, 38)])
      expect(output.includes(value)).toBe(false);
  });
});

it('rejects anonymous and employee callers before reading settings', async () => {
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
  ['null', 'application/json', 400, 'Empty model connection test body required'],
  ['{"baseURL":"x"}', 'application/json', 400, 'Empty model connection test body required'],
  ['[]', 'application/json', 400, 'Empty model connection test body required'],
  ['{', 'application/json', 400, 'Empty model connection test body required'],
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
    database.prepare("INSERT INTO settings (key, value) VALUES ('models', ?)").run('{private');

    const response = await post(app, cookie);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(lines.join('')).toContain('Administrator model connection test failure');
    expect((response.body + lines.join('')).includes('private')).toBe(false);
  });
});

it.each([
  ['revoke', 401],
  ['demote', 403],
] as const)('rechecks authority after the body is read: %s gives %i', async (change, status) => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    writeSettings(database, { modelBaseUrl: 'www.dmxapi.cn/v1', modelApiKey: 'k', ...MODELS });
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
  });
});

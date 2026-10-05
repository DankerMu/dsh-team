import { describe, expect, it } from 'vitest';
import {
  cookieHeaders,
  injectLogin,
  injectRegister,
  snapshotAuthState,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';

const EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const WRONG_PASSWORD = 'wrong-password';
const SHORT_PASSWORD = 'short';
const AUDIT_ABORT = 'audit-write-aborted';
const SESSION_ABORT = 'session-write-aborted';
const UPDATE_STATUS = "UPDATE users SET status = 'disabled' WHERE email = ?";
const UNAUTHORIZED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Invalid email or password',
} as const;
const FORBIDDEN = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Account is disabled',
} as const;
const TOO_MANY_REQUESTS = {
  statusCode: 429,
  error: 'Too Many Requests',
  message: 'Too many login attempts',
} as const;

function abortInserts(
  database: DatabaseHandle,
  table: 'platform_sessions' | 'audit_events',
  message: string,
  trigger: string,
): void {
  database.exec(
    `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`,
  );
}

async function expectStatus(
  app: Parameters<typeof injectLogin>[0],
  credentials: { email: string; password: string },
  statusCode: number,
  body: unknown,
): Promise<void> {
  const response = await injectLogin(app, credentials);
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual(body);
  expect(cookieHeaders(response)).toEqual([]);
}

const WRONG_CREDENTIALS = { email: LOGIN_EMAIL, password: WRONG_PASSWORD };

async function withNineWrongFailures(
  run: (app: Parameters<typeof injectLogin>[0], database: DatabaseHandle) => Promise<void>,
): Promise<void> {
  await withApp(async (app, database) => {
    const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
    expect(registered.statusCode).toBe(201);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expectStatus(app, WRONG_CREDENTIALS, 401, UNAUTHORIZED);
    }
    await run(app, database);
  });
}

describe('POST /_platform/api/login failure counting', () => {
  it.each([
    {
      label: 'unknown email',
      register: false,
      disable: false,
      credentials: { email: 'missing@example.com', password: PASSWORD },
      counted: UNAUTHORIZED,
    },
    {
      label: 'wrong password',
      register: true,
      disable: false,
      credentials: { email: LOGIN_EMAIL, password: WRONG_PASSWORD },
      counted: UNAUTHORIZED,
    },
    {
      label: 'short password',
      register: true,
      disable: false,
      credentials: { email: LOGIN_EMAIL, password: SHORT_PASSWORD },
      counted: UNAUTHORIZED,
    },
    {
      label: 'verified disabled account',
      register: true,
      disable: true,
      credentials: { email: LOGIN_EMAIL, password: PASSWORD },
      counted: FORBIDDEN,
    },
  ])('counts $label toward the tenth failure then blocks', async (scenario) => {
    await withApp(async (app, database) => {
      if (scenario.register) {
        const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
        expect(registered.statusCode).toBe(201);
        if (scenario.disable) {
          database.prepare(UPDATE_STATUS).run(EMAIL);
        }
      }
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await expectStatus(
          app,
          scenario.credentials,
          scenario.counted.statusCode,
          scenario.counted,
        );
      }
      const sessions = snapshotAuthState(database).sessions;
      await expectStatus(app, scenario.credentials, scenario.counted.statusCode, scenario.counted);
      await expectStatus(
        app,
        { email: scenario.credentials.email, password: PASSWORD },
        429,
        TOO_MANY_REQUESTS,
      );
      expect(snapshotAuthState(database).sessions).toEqual(sessions);
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 20, eventType: 'login.failed' }),
      ).toHaveLength(11);
    });
  });

  it('does not count a 400 validation rejection toward the window', async () => {
    await withNineWrongFailures(async (app, database) => {
      const rejected = await injectLogin(app, { email: 'not-an-email', password: PASSWORD });
      expect(rejected.statusCode).toBe(400);
      expect(cookieHeaders(rejected)).toEqual([]);
      await expectStatus(app, WRONG_CREDENTIALS, 401, UNAUTHORIZED);
      await expectStatus(app, { email: LOGIN_EMAIL, password: PASSWORD }, 429, TOO_MANY_REQUESTS);
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 20, eventType: 'login.failed' }),
      ).toHaveLength(11);
    });
  });

  it('does not count a 500 persistence failure toward the window', async () => {
    await withNineWrongFailures(async (app, database) => {
      abortInserts(database, 'platform_sessions', SESSION_ABORT, 'abort_session');
      const failed = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
      expect(failed.statusCode).toBe(500);
      expect(cookieHeaders(failed)).toEqual([]);
      database.exec('DROP TRIGGER abort_session');
      await expectStatus(app, WRONG_CREDENTIALS, 401, UNAUTHORIZED);
      await expectStatus(app, { email: LOGIN_EMAIL, password: PASSWORD }, 429, TOO_MANY_REQUESTS);
    });
  });

  it('does not count an aborted authentication-failure audit', async () => {
    await withNineWrongFailures(async (app, database) => {
      abortInserts(database, 'audit_events', AUDIT_ABORT, 'abort_failed_audit');
      const aborted = await injectLogin(app, WRONG_CREDENTIALS);
      expect(aborted.statusCode).toBe(500);
      expect(cookieHeaders(aborted)).toEqual([]);
      database.exec('DROP TRIGGER abort_failed_audit');
      await expectStatus(app, WRONG_CREDENTIALS, 401, UNAUTHORIZED);
      await expectStatus(app, { email: LOGIN_EMAIL, password: PASSWORD }, 429, TOO_MANY_REQUESTS);
      expect(tableCounts(database).sessions).toBe(1);
    });
  });

  it('keeps a live limit when a blocked login.failed audit returns 500', async () => {
    await withApp(async (app, database) => {
      await injectRegister(app, { email: EMAIL, password: PASSWORD });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expectStatus(
          app,
          { email: LOGIN_EMAIL, password: WRONG_PASSWORD },
          401,
          UNAUTHORIZED,
        );
      }
      const sessions = snapshotAuthState(database).sessions;
      abortInserts(database, 'audit_events', AUDIT_ABORT, 'abort_blocked_audit');
      const aborted = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
      expect(aborted.statusCode).toBe(500);
      expect(cookieHeaders(aborted)).toEqual([]);
      expect(snapshotAuthState(database).sessions).toEqual(sessions);
      database.exec('DROP TRIGGER abort_blocked_audit');
      await expectStatus(app, { email: LOGIN_EMAIL, password: PASSWORD }, 429, TOO_MANY_REQUESTS);
      expect(snapshotAuthState(database).sessions).toEqual(sessions);
    });
  });
});

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaders,
  injectLogin,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
  snapshotAuthState,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { validateSession } from './index.ts';

const EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const SESSION_ABORT = 'session-write-aborted';
const AUDIT_ABORT = 'audit-write-aborted';
const BACKDATE_ACTIVITY =
  'UPDATE platform_sessions SET last_activity_at = last_activity_at - 60000';
const DROP_AUDIT_TRIGGER = 'DROP TRIGGER abort_audit';

function injectLogout(app: FastifyInstance, token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/_platform/api/logout',
    remoteAddress: SOURCE,
    headers: { cookie: `platform_session=${token}` },
  });
}

function abortInserts(
  database: DatabaseHandle,
  table: 'platform_sessions' | 'audit_events',
  message: string,
): void {
  database.exec(
    `CREATE TEMP TRIGGER abort_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`,
  );
}

async function registerThenLogin(
  app: FastifyInstance,
): Promise<{ id: string; loginToken: string; registerToken: string }> {
  const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
  expect(registered.statusCode).toBe(201);
  // JSON.parse is typed as any; the HTTP body is JSON text.
  const identity = readPublicIdentity(JSON.parse(registered.body) as unknown);
  const login = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
  expect(login.statusCode).toBe(200);
  return {
    id: identity.id,
    loginToken: sessionCookieToken(cookieHeaders(login)),
    registerToken: sessionCookieToken(cookieHeaders(registered)),
  };
}

describe('login and logout persistence failures', () => {
  it.each([
    ['session INSERT', SESSION_ABORT, 'platform_sessions' as const],
    ['audit INSERT', AUDIT_ABORT, 'audit_events' as const],
  ])(
    'rolls login back when %s aborts, returns 500, and sets no success cookie',
    async (_label, abortMessage, table) => {
      await withApp(async (app, database, lines) => {
        const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
        expect(registered.statusCode).toBe(201);
        const before = snapshotAuthState(database);
        abortInserts(database, table, abortMessage);

        const login = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });

        expect(login.statusCode).toBe(500);
        expect(login.json()).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: abortMessage,
        });
        expect(cookieHeaders(login)).toEqual([]);
        expect(snapshotAuthState(database)).toEqual(before);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 1 });
        expect(
          queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'login.succeeded' }),
        ).toEqual([]);
        expect(`${login.body}${lines.join('')}`).not.toContain(PASSWORD);
      });
    },
  );

  it('rolls logout deletion and activity back when audit INSERT aborts, then succeeds after dropping the trigger', async () => {
    await withApp(async (app, database, lines) => {
      const { id, loginToken, registerToken } = await registerThenLogin(app);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotAuthState(database);
      database.exec(
        `CREATE TEMP TRIGGER abort_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, '${AUDIT_ABORT}'); END`,
      );

      const failed = await injectLogout(app, loginToken);

      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: AUDIT_ABORT,
      });
      expect(cookieHeaders(failed)).toEqual([]);
      expect(snapshotAuthState(database)).toEqual(before);
      expect(validateSession(database, loginToken, Date.now())).toBe(id);
      expect(validateSession(database, registerToken, Date.now())).toBe(id);

      database.exec(DROP_AUDIT_TRIGGER);
      const retry = await injectLogout(app, loginToken);

      expect(retry.statusCode).toBe(204);
      expect(cookieHeaders(retry)).toHaveLength(1);
      expect(cookieHeaders(retry)[0]).toContain('Max-Age=0');
      expect(validateSession(database, loginToken, Date.now())).toBeNull();
      expect(validateSession(database, registerToken, Date.now())).toBe(id);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 3 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'logout.succeeded',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'logout.succeeded',
        actorEmail: EMAIL,
        targetEmail: EMAIL,
        target: id,
        sourceAddress: SOURCE,
        details: {},
      });
      const written = `${failed.body}${retry.body}${lines.join('')}${JSON.stringify(events)}`;
      for (const secret of [PASSWORD, loginToken, registerToken]) {
        expect(written).not.toContain(secret);
      }
    });
  });
});

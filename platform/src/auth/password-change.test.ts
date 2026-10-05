import { describe, expect, it } from 'vitest';
import {
  cookieAttributes,
  cookieHeaders,
  injectLogin,
  injectRegister,
  readPublicIdentity,
  sessionCookieHeader,
  sessionCookieToken,
  snapshotAuthState,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import { getSessionUser, validateSession, verifyPassword } from './index.ts';

const EMAIL = 'user@example.com';
const PASSWORD = ' PassW0rd ';
const NEW_PASSWORD = ' NewPassW0rd ';
const SELECT_PASSWORD = 'SELECT password_hash FROM users WHERE email = ?';
const BACKDATE_ACTIVITY =
  'UPDATE platform_sessions SET last_activity_at = last_activity_at - 60000';
interface PasswordRow {
  password_hash: string;
}

const INVALID_BODIES = [
  null,
  [],
  {},
  { currentPassword: 123456, newPassword: NEW_PASSWORD },
  { currentPassword: [PASSWORD], newPassword: NEW_PASSWORD },
  { currentPassword: null, newPassword: NEW_PASSWORD },
  { currentPassword: PASSWORD, newPassword: 123456 },
  { currentPassword: PASSWORD, newPassword: [NEW_PASSWORD] },
  { currentPassword: PASSWORD, newPassword: null },
  { currentPassword: PASSWORD, newPassword: '😀'.repeat(5) },
  { currentPassword: PASSWORD, newPassword: '😀'.repeat(257) },
] as const;

describe('POST /_platform/api/change-password', () => {
  it.each([false, true])(
    'replaces all user sessions, preserves another account, and records the change with cookieSecure=%s',
    async (cookieSecure) => {
      await withApp(async (app, database, lines) => {
        const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
        expect(registered.statusCode).toBe(201);
        const identity = readPublicIdentity(registered.json<unknown>());
        const originalToken = sessionCookieToken(cookieHeaders(registered));
        const login = await injectLogin(app, { email: EMAIL, password: PASSWORD });
        expect(login.statusCode).toBe(200);
        const loginToken = sessionCookieToken(cookieHeaders(login));
        const other = await injectRegister(app, {
          email: 'other@example.com',
          password: PASSWORD,
        });
        expect(other.statusCode).toBe(201);
        const otherIdentity = readPublicIdentity(other.json<unknown>());
        const otherToken = sessionCookieToken(cookieHeaders(other));
        const beforeHash = database.prepare<[string], PasswordRow>(SELECT_PASSWORD).get(EMAIL);
        if (beforeHash === undefined) {
          throw new Error('expected original password row');
        }
        const otherSessions = database
          .prepare('SELECT * FROM platform_sessions WHERE user_id = ?')
          .all(otherIdentity.id);

        const changed = await app.inject({
          method: 'POST',
          url: '/_platform/api/change-password',
          remoteAddress: SOURCE,
          headers: { cookie: `platform_session=${loginToken}` },
          payload: {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
            email: 'other@example.com',
          },
        });

        expect(changed.statusCode).toBe(204);
        expect(changed.body).toBe('');
        const cookies = cookieHeaders(changed);
        expect(cookies).toHaveLength(1);
        expect(cookieAttributes(sessionCookieHeader(cookies))).toEqual(
          ['HttpOnly', 'Path=/', 'SameSite=Lax', ...(cookieSecure ? ['Secure'] : [])].sort(),
        );
        const freshToken = sessionCookieToken(cookies);
        expect(freshToken).not.toBe(loginToken);
        expect(validateSession(database, originalToken, Date.now())).toBeNull();
        expect(validateSession(database, loginToken, Date.now())).toBeNull();
        expect(getSessionUser(database, freshToken, Date.now())).toEqual(identity);
        expect(getSessionUser(database, otherToken, Date.now())).toEqual(otherIdentity);
        expect(tableCounts(database)).toEqual({ users: 2, sessions: 2, audits: 4 });
        const current = database.prepare<[string], PasswordRow>(SELECT_PASSWORD).get(EMAIL);
        if (current === undefined) {
          throw new Error('expected password row');
        }
        expect(current).not.toEqual(beforeHash);
        expect(await verifyPassword(NEW_PASSWORD, current.password_hash)).toBe(true);
        expect(await verifyPassword(PASSWORD, current.password_hash)).toBe(false);
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'password.changed',
        });
        expect(events).toEqual([
          expect.objectContaining({
            type: 'password.changed',
            actorEmail: EMAIL,
            targetEmail: EMAIL,
            target: identity.id,
            sourceAddress: SOURCE,
            details: {},
          }),
        ]);
        expect(
          database
            .prepare('SELECT * FROM platform_sessions WHERE user_id = ?')
            .all(otherIdentity.id),
        ).toEqual(otherSessions);
        const written = `${changed.body}${lines.join('')}${JSON.stringify(events)}`;
        for (const secret of [PASSWORD, NEW_PASSWORD, originalToken, loginToken, freshToken]) {
          expect(written).not.toContain(secret);
        }
      }, cookieSecure);
    },
  );

  it.each([
    { currentPassword: 'wrong-password', status: 401, message: 'Current password is incorrect' },
    { currentPassword: '', status: 401, message: 'Current password is incorrect' },
  ])('rejects incorrect current password without renewing any session', async (failure) => {
    await withApp(async (app, database) => {
      const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
      expect(registered.statusCode).toBe(201);
      const token = sessionCookieToken(cookieHeaders(registered));
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotAuthState(database);
      const hash = database.prepare(SELECT_PASSWORD).get(EMAIL);

      const changed = await app.inject({
        method: 'POST',
        url: '/_platform/api/change-password',
        headers: { cookie: `platform_session=${token}` },
        payload: { currentPassword: failure.currentPassword, newPassword: NEW_PASSWORD },
      });

      expect(changed.statusCode).toBe(failure.status);
      expect(changed.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: failure.message,
      });
      expect(cookieHeaders(changed)).toEqual([]);
      expect(snapshotAuthState(database)).toEqual(before);
      expect(database.prepare(SELECT_PASSWORD).get(EMAIL)).toEqual(hash);
    });
  });

  it.each(INVALID_BODIES.map((payload) => ({ payload })))(
    'rejects an invalid raw password-change body %# without mutation',
    async ({ payload }) => {
      await withApp(async (app, database) => {
        const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
        expect(registered.statusCode).toBe(201);
        const token = sessionCookieToken(cookieHeaders(registered));
        database.exec(BACKDATE_ACTIVITY);
        const before = snapshotAuthState(database);
        const hash = database.prepare(SELECT_PASSWORD).get(EMAIL);

        const changed = await app.inject({
          method: 'POST',
          url: '/_platform/api/change-password',
          headers: { 'content-type': 'application/json', cookie: `platform_session=${token}` },
          payload: JSON.stringify(payload),
        });

        expect(changed.statusCode).toBe(400);
        expect(cookieHeaders(changed)).toEqual([]);
        expect(snapshotAuthState(database)).toEqual(before);
        expect(database.prepare(SELECT_PASSWORD).get(EMAIL)).toEqual(hash);
      });
    },
  );

  it('rejects a missing cookie rather than trusting a body identity', async () => {
    await withApp(async (app, database) => {
      const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
      expect(registered.statusCode).toBe(201);
      const before = snapshotAuthState(database);

      const changed = await app.inject({
        method: 'POST',
        url: '/_platform/api/change-password',
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, email: EMAIL },
      });

      expect(changed.statusCode).toBe(401);
      expect(changed.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
      });
      expect(cookieHeaders(changed)).toEqual([]);
      expect(snapshotAuthState(database)).toEqual(before);
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  cookieAttributes,
  cookieHeaders,
  injectLogin,
  injectRegister,
  readPublicIdentity,
  sessionCookieHeader,
  sessionCookieToken,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import { validateSession } from './index.ts';

const REGISTER_EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const USER_ID = /^[a-z0-9]{12}$/;
const COOKIE_ATTRIBUTES = ['HttpOnly', 'Path=/', 'SameSite=Lax'];
const UPDATE_STATUS = "UPDATE users SET status = 'disabled' WHERE email = ?";
const UNAUTHORIZED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Invalid email or password',
} as const;

describe('POST /_platform/api/login', () => {
  it('logs in a registered employee with mixed-case email and the exact password', async () => {
    await withApp(async (app, database, lines) => {
      const registered = await injectRegister(app, {
        email: REGISTER_EMAIL,
        password: PASSWORD,
      });
      expect(registered.statusCode).toBe(201);
      // JSON.parse is typed as any; the HTTP body is JSON text.
      const registeredBody = readPublicIdentity(JSON.parse(registered.body) as unknown);
      expect(registeredBody.id).toMatch(USER_ID);
      expect(registeredBody).toEqual({
        id: registeredBody.id,
        email: REGISTER_EMAIL,
        role: 'employee',
      });
      const registerCookies = cookieHeaders(registered);
      expect(registerCookies).toHaveLength(1);
      const registerHeader = sessionCookieHeader(registerCookies);
      const registerToken = sessionCookieToken(registerCookies);
      const registerAttributes = cookieAttributes(registerHeader);
      expect(registerAttributes).toEqual(COOKIE_ATTRIBUTES);

      const login = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });

      expect(login.statusCode).toBe(200);
      // JSON.parse is typed as any; the HTTP body is JSON text.
      const loginBody = readPublicIdentity(JSON.parse(login.body) as unknown);
      expect(loginBody).toEqual({
        id: registeredBody.id,
        email: REGISTER_EMAIL,
        role: 'employee',
      });
      const loginCookies = cookieHeaders(login);
      expect(loginCookies).toHaveLength(1);
      const loginHeader = sessionCookieHeader(loginCookies);
      const loginToken = sessionCookieToken(loginCookies);
      const loginAttributes = cookieAttributes(loginHeader);
      expect(loginToken).not.toBe(registerToken);
      expect(loginAttributes).toEqual(COOKIE_ATTRIBUTES);
      expect(loginAttributes).toEqual(registerAttributes);
      expect(loginHeader).not.toContain('Secure');
      expect(loginHeader).not.toContain('Domain=');
      expect(validateSession(database, loginToken, Date.now())).toBe(registeredBody.id);
      expect(validateSession(database, registerToken, Date.now())).toBe(registeredBody.id);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.succeeded',
      });
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) {
        throw new Error('expected login.succeeded audit row');
      }
      expect(event).toMatchObject({
        type: 'login.succeeded',
        actorEmail: REGISTER_EMAIL,
        targetEmail: REGISTER_EMAIL,
        target: registeredBody.id,
        sourceAddress: SOURCE,
        details: {},
      });
      const written = `${registered.body}${login.body}${lines.join('')}${JSON.stringify(event)}`;
      for (const secret of [PASSWORD, registerToken, loginToken]) {
        expect(written).not.toContain(secret);
      }
    });
  });

  it('returns the same 401 for an unknown email and a wrong password and records login.failed', async () => {
    await withApp(async (app, database, lines) => {
      const registered = await injectRegister(app, {
        email: REGISTER_EMAIL,
        password: PASSWORD,
      });
      expect(registered.statusCode).toBe(201);

      const unknown = await injectLogin(app, {
        email: 'missing@example.com',
        password: PASSWORD,
      });
      const wrong = await injectLogin(app, {
        email: LOGIN_EMAIL,
        password: 'wrong-password',
      });

      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json()).toEqual(UNAUTHORIZED);
      expect(wrong.json()).toEqual(UNAUTHORIZED);
      expect(cookieHeaders(unknown)).toEqual([]);
      expect(cookieHeaders(wrong)).toEqual([]);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 3 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.failed',
      });
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'login.failed',
            actorEmail: 'missing@example.com',
            targetEmail: null,
            target: null,
            sourceAddress: SOURCE,
            details: {},
          }),
          expect.objectContaining({
            type: 'login.failed',
            actorEmail: REGISTER_EMAIL,
            targetEmail: null,
            target: null,
            sourceAddress: SOURCE,
            details: {},
          }),
        ]),
      );
      const written = `${unknown.body}${wrong.body}${lines.join('')}${JSON.stringify(events)}`;
      for (const secret of [PASSWORD, 'wrong-password']) {
        expect(written).not.toContain(secret);
      }
    });
  });

  it('rejects a verified disabled account with 403, no session, and login.failed', async () => {
    await withApp(async (app, database, lines) => {
      const registered = await injectRegister(app, {
        email: REGISTER_EMAIL,
        password: PASSWORD,
      });
      expect(registered.statusCode).toBe(201);
      database.prepare(UPDATE_STATUS).run(REGISTER_EMAIL);

      const login = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });

      expect(login.statusCode).toBe(403);
      expect(login.json()).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Account is disabled',
      });
      expect(cookieHeaders(login)).toEqual([]);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 2 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.failed',
      });
      expect(events).toHaveLength(1);
      const event = events[0];
      if (event === undefined) {
        throw new Error('expected login.failed audit row');
      }
      expect(event).toMatchObject({
        type: 'login.failed',
        actorEmail: REGISTER_EMAIL,
        targetEmail: null,
        target: null,
        sourceAddress: SOURCE,
        details: {},
      });
      expect(`${login.body}${lines.join('')}${JSON.stringify(event)}`).not.toContain(PASSWORD);
    });
  });
});

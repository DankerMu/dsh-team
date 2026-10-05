import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import {
  cookieAttributes,
  sessionCookieHeader,
  snapshotAuthState,
  tableCounts,
} from './auth-fixture.ts';
import {
  expectNoSecrets,
  getIdentity,
  LOOPBACK_ADDRESSES,
  PASSWORD,
  postJson,
  registerAccount,
  sessionTimes,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';

const DAY_MS = 86_400_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THROTTLE_MS = 60_000;
const UPDATE_ROLE = "UPDATE users SET role = 'admin' WHERE email = ?";
const UPDATE_STATUS = "UPDATE users SET status = 'disabled' WHERE email = ?";
const BACKDATE_ACTIVITY = 'UPDATE platform_sessions SET last_activity_at = ? WHERE token_hash = ?';
const LOGIN_COOKIE_ATTRIBUTES = ['HttpOnly', 'Path=/', 'SameSite=Lax'];
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

describe('login, logout, and session recognition over a real TCP port', () => {
  it.each([
    { role: 'employee' as const, promote: false, cookieSecure: false, extra: [] as const },
    { role: 'admin' as const, promote: true, cookieSecure: true, extra: ['Secure'] as const },
  ])(
    'logs in a $role and recognizes the public identity when cookieSecure is $cookieSecure',
    async ({ role, promote, cookieSecure, extra }) => {
      await withListeningApp(async (baseUrl, app, database, lines) => {
        const registered = await registerAccount(app, 'User@Example.com');
        if (promote) {
          database.prepare(UPDATE_ROLE).run(registered.email);
        }
        const login = await successfulLogin(baseUrl, '  User@Example.com  ');
        expect(login.identity).toEqual({
          id: registered.id,
          email: registered.email,
          role,
        });
        expect(cookieAttributes(login.header)).toEqual(
          [...LOGIN_COOKIE_ATTRIBUTES, ...extra].sort(),
        );
        expect(login.header).not.toContain('Domain=');
        if (!cookieSecure) {
          expect(login.header).not.toContain('Secure');
        }
        const recognized = await getIdentity(
          baseUrl,
          `theme=dark; platform_session=${login.token}`,
        );
        expect(recognized.status).toBe(200);
        expect(await recognized.json()).toEqual(login.identity);
        expect((await fetch(`${baseUrl}/_platform/api/me`)).status).toBe(404);
        expect((await fetch(`${baseUrl}/me`)).status).toBe(404);
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'login.succeeded',
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'login.succeeded',
          actorEmail: registered.email,
          targetEmail: registered.email,
          target: registered.id,
          details: {},
        });
        expect(LOOPBACK_ADDRESSES).toContain(events[0]?.sourceAddress);
        expectNoSecrets(lines, events, [PASSWORD, login.token]);
      }, cookieSecure);
    },
  );

  it('returns the exact 401 body for unknown and wrong credentials and 403 for a disabled account', async () => {
    await withListeningApp(async (baseUrl, app, database, lines) => {
      const registered = await registerAccount(app, 'user@example.com');
      const unknown = await postJson(`${baseUrl}/_platform/api/login`, {
        email: 'missing@example.com',
        password: PASSWORD,
      });
      const wrong = await postJson(`${baseUrl}/_platform/api/login`, {
        email: '  User@Example.com  ',
        password: 'wrong-password',
      });
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(await unknown.json()).toEqual(UNAUTHORIZED);
      expect(await wrong.json()).toEqual(UNAUTHORIZED);
      expect(unknown.headers.getSetCookie()).toEqual([]);
      expect(wrong.headers.getSetCookie()).toEqual([]);
      database.prepare(UPDATE_STATUS).run(registered.email);
      const disabled = await postJson(`${baseUrl}/_platform/api/login`, {
        email: '  User@Example.com  ',
        password: PASSWORD,
      });
      expect(disabled.status).toBe(403);
      expect(await disabled.json()).toEqual(FORBIDDEN);
      expect(disabled.headers.getSetCookie()).toEqual([]);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 4 });
      const failed = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.failed',
      });
      expect(failed).toHaveLength(3);
      expectNoSecrets(lines, failed, [PASSWORD, 'wrong-password']);
    });
  });

  it('revokes only one of two login sessions and rejects replay while the other remains recognized', async () => {
    await withListeningApp(async (baseUrl, app, database, lines) => {
      const registered = await registerAccount(app, 'user@example.com');
      const first = await successfulLogin(baseUrl, 'user@example.com');
      const second = await successfulLogin(baseUrl, 'user@example.com');
      expect(first.token).not.toBe(second.token);
      expect((await getIdentity(baseUrl, `platform_session=${first.token}`)).status).toBe(200);
      expect((await getIdentity(baseUrl, `platform_session=${second.token}`)).status).toBe(200);
      const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
        method: 'POST',
        headers: { cookie: `platform_session=${first.token}` },
      });
      expect(logout.status).toBe(204);
      expect(await logout.text()).toBe('');
      expect(cookieAttributes(sessionCookieHeader(logout.headers.getSetCookie()))).toEqual([
        'HttpOnly',
        'Max-Age=0',
        'Path=/',
        'SameSite=Lax',
      ]);
      const replay = await getIdentity(baseUrl, `platform_session=${first.token}`);
      const other = await getIdentity(baseUrl, `platform_session=${second.token}`);
      expect(replay.status).toBe(401);
      expect(other.status).toBe(200);
      expect(await other.json()).toEqual({
        id: registered.id,
        email: registered.email,
        role: 'employee',
      });
      const events = queryAuditEvents(database, { page: 1, pageSize: 10 });
      expect(events.filter((event) => event.type === 'logout.succeeded')).toHaveLength(1);
      expectNoSecrets(lines, events, [PASSWORD, first.token, second.token]);
    });
  });

  it('rejects digest, malformed, and duplicate cookies as 401 without changing stored rows', async () => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, 'user@example.com');
      const login = await successfulLogin(baseUrl, 'user@example.com');
      const digest = createHash('sha256').update(login.token).digest('hex');
      const before = snapshotAuthState(database);
      const cookies = [
        `platform_session=${digest}`,
        `platform_session=${login.token.slice(0, 63)}g`,
        `platform_session=${login.token}; platform_session=${login.token}`,
      ];
      for (const cookie of cookies) {
        const recognized = await getIdentity(baseUrl, cookie);
        const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
          method: 'POST',
          headers: { cookie },
        });
        expect(recognized.status).toBe(401);
        expect(logout.status).toBe(401);
        expect(logout.headers.getSetCookie()).toEqual([]);
        expect(snapshotAuthState(database)).toEqual(before);
      }
    });
  });

  it('renews day-6 activity so day 12 still authenticates, independently of exact 7-day and +1ms expiry', async () => {
    await withListeningApp(async (baseUrl, app, database, _lines, now) => {
      await registerAccount(app, 'user@example.com');
      const sliding = await successfulLogin(baseUrl, 'user@example.com');
      const exact = await successfulLogin(baseUrl, 'user@example.com');
      const expired = await successfulLogin(baseUrl, 'user@example.com');
      const slidingIssued = sessionTimes(database, sliding.token);
      const exactIssued = sessionTimes(database, exact.token);
      const expiredIssued = sessionTimes(database, expired.token);
      now.ms = slidingIssued.last_activity_at + 6 * DAY_MS;
      expect((await getIdentity(baseUrl, `platform_session=${sliding.token}`)).status).toBe(200);
      expect(sessionTimes(database, sliding.token).last_activity_at).toBe(now.ms);
      now.ms += 6 * DAY_MS;
      expect((await getIdentity(baseUrl, `platform_session=${sliding.token}`)).status).toBe(200);
      expect(sessionTimes(database, sliding.token).last_activity_at).toBe(now.ms);
      now.ms = exactIssued.last_activity_at + SEVEN_DAYS_MS;
      expect((await getIdentity(baseUrl, `platform_session=${exact.token}`)).status).toBe(200);
      expect(sessionTimes(database, exact.token)).toEqual({
        created_at: exactIssued.created_at,
        last_activity_at: now.ms,
      });
      now.ms = expiredIssued.last_activity_at + SEVEN_DAYS_MS + 1;
      expect((await getIdentity(baseUrl, `platform_session=${expired.token}`)).status).toBe(401);
      expect(sessionTimes(database, expired.token)).toEqual(expiredIssued);
    });
  });

  it('leaves a disabled retained session unchanged after recognition and logout at elapsed >= 60_000ms', async () => {
    await withListeningApp(async (baseUrl, app, database, _lines, now) => {
      const registered = await registerAccount(app, 'user@example.com');
      const login = await successfulLogin(baseUrl, 'user@example.com');
      const digest = createHash('sha256').update(login.token).digest('hex');
      const issued = sessionTimes(database, login.token);
      database.prepare(BACKDATE_ACTIVITY).run(issued.last_activity_at - THROTTLE_MS, digest);
      database.prepare(UPDATE_STATUS).run(registered.email);
      const before = snapshotAuthState(database);
      now.ms = issued.last_activity_at;
      const recognized = await getIdentity(baseUrl, `platform_session=${login.token}`);
      const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
        method: 'POST',
        headers: { cookie: `platform_session=${login.token}` },
      });
      expect(recognized.status).toBe(401);
      expect(logout.status).toBe(401);
      expect(logout.headers.getSetCookie()).toEqual([]);
      expect(snapshotAuthState(database)).toEqual(before);
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'logout.succeeded' }),
      ).toEqual([]);
    });
  });
});

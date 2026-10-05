import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import {
  cookieAttributes,
  sessionCookieHeader,
  snapshotAuthState,
  tableCounts,
  withApp,
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

describe('source address over a real TCP port', () => {
  const CLIENT_A = '198.51.100.7';
  const CLIENT_B = '203.0.113.10';
  const EMAIL = 'client@example.com';
  const TRUSTED_LOOPBACK = ['127.0.0.1'] as const;

  it.each([
    {
      label:
        'records the forwarded client as the registration audit source when the loopback peer is trusted',
      trustedProxies: TRUSTED_LOOPBACK,
      forwardedFor: CLIENT_A,
      source: CLIENT_A,
    },
    {
      label: 'ignores forged X-Forwarded-For when there are no trusted proxies',
      trustedProxies: [] as const,
      forwardedFor: CLIENT_A,
      source: LOOPBACK_ADDRESSES,
    },
    {
      label:
        'ignores forged X-Forwarded-For when there is a trust list that does not include the loopback peer',
      trustedProxies: ['192.0.2.10'] as const,
      forwardedFor: CLIENT_A,
      source: LOOPBACK_ADDRESSES,
    },
    {
      label:
        'falls back to the loopback peer when a trusted proxy sends a malformed X-Forwarded-For',
      trustedProxies: TRUSTED_LOOPBACK,
      forwardedFor: 'not-an-ip',
      source: LOOPBACK_ADDRESSES,
    },
    {
      label: 'records the first untrusted hop rather than a spoofed prefix',
      trustedProxies: TRUSTED_LOOPBACK,
      forwardedFor: `203.0.113.1, ${CLIENT_A}`,
      source: CLIENT_A,
    },
  ])('$label', async ({ trustedProxies, forwardedFor, source }) => {
    await withListeningApp(
      async (baseUrl, _app, database) => {
        const response = await postJson(
          `${baseUrl}/_platform/api/register`,
          { email: EMAIL, password: PASSWORD },
          { 'X-Forwarded-For': forwardedFor },
        );
        expect(response.status).toBe(201);
        await response.json();
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'account.registered',
        });
        expect(events).toHaveLength(1);
        if (typeof source === 'string') {
          expect(events[0]?.sourceAddress).toBe(source);
        } else {
          expect(source).toContain(events[0]?.sourceAddress);
        }
      },
      false,
      trustedProxies,
    );
  });

  it('attributes ten failed logins, a later success, and logout to distinct forwarded clients', async () => {
    await withListeningApp(
      async (baseUrl, _app, database) => {
        const registered = await postJson(
          `${baseUrl}/_platform/api/register`,
          { email: EMAIL, password: PASSWORD },
          { 'X-Forwarded-For': CLIENT_A },
        );
        expect(registered.status).toBe(201);
        await registered.json();

        for (let attempt = 0; attempt < 10; attempt += 1) {
          const failed = await postJson(
            `${baseUrl}/_platform/api/login`,
            { email: EMAIL, password: 'wrong-password' },
            { 'X-Forwarded-For': CLIENT_A },
          );
          expect(failed.status).toBe(401);
          await failed.json();
        }

        const login = await postJson(
          `${baseUrl}/_platform/api/login`,
          { email: EMAIL, password: PASSWORD },
          { 'X-Forwarded-For': CLIENT_B },
        );
        expect(login.status).toBe(200);
        await login.json();
        const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
          method: 'POST',
          headers: {
            cookie: sessionCookieHeader(login.headers.getSetCookie()),
            'X-Forwarded-For': CLIENT_B,
          },
        });
        expect(logout.status).toBe(204);
        expect(await logout.text()).toBe('');

        const events = queryAuditEvents(database, { page: 1, pageSize: 50 });
        const failed = events.filter((event) => event.type === 'login.failed');
        const succeeded = events.filter((event) => event.type === 'login.succeeded');
        const loggedOut = events.filter((event) => event.type === 'logout.succeeded');
        expect(failed).toHaveLength(10);
        expect(failed.every((event) => event.sourceAddress === CLIENT_A)).toBe(true);
        expect(succeeded).toHaveLength(1);
        expect(succeeded[0]?.sourceAddress).toBe(CLIENT_B);
        expect(loggedOut).toHaveLength(1);
        expect(loggedOut[0]?.sourceAddress).toBe(CLIENT_B);
      },
      false,
      TRUSTED_LOOPBACK,
    );
  });

  it('records X-Forwarded-For over conflicting Forwarded and X-Real-IP on a successful login', async () => {
    await withListeningApp(
      async (baseUrl, _app, database) => {
        const registered = await postJson(
          `${baseUrl}/_platform/api/register`,
          { email: EMAIL, password: PASSWORD },
          { 'X-Forwarded-For': CLIENT_A },
        );
        expect(registered.status).toBe(201);
        await registered.json();

        const login = await postJson(
          `${baseUrl}/_platform/api/login`,
          { email: EMAIL, password: PASSWORD },
          {
            'X-Forwarded-For': CLIENT_A,
            Forwarded: `for=${CLIENT_B}`,
            'X-Real-IP': CLIENT_B,
          },
        );
        expect(login.status).toBe(200);
        await login.json();

        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'login.succeeded',
        });
        expect(events).toHaveLength(1);
        expect(events[0]?.sourceAddress).toBe(CLIENT_A);
      },
      false,
      TRUSTED_LOOPBACK,
    );
  });

  it('leaves hostname and protocol unchanged when forwarded Host and Proto headers are present', async () => {
    await withApp(
      async (app) => {
        app.get('/_test/request-origin', (request, reply) => {
          return reply.send({ hostname: request.hostname, protocol: request.protocol });
        });
        const observed = await fetch(
          `${await app.listen({ host: '127.0.0.1', port: 0 })}/_test/request-origin`,
          {
            headers: {
              'X-Forwarded-For': CLIENT_A,
              'X-Forwarded-Host': 'evil.example',
              'X-Forwarded-Proto': 'https',
              Forwarded: 'for=198.51.100.7;host=evil.example;proto=https',
              'X-Real-IP': CLIENT_A,
            },
          },
        );
        expect(observed.status).toBe(200);
        expect(await observed.json()).toEqual({ hostname: '127.0.0.1', protocol: 'http' });
      },
      false,
      TRUSTED_LOOPBACK,
    );
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import { cookieAttributes, readPublicIdentity, sessionCookieToken } from './auth-fixture.ts';
import {
  getIdentity,
  PASSWORD,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import {
  BACKDATE_ACTIVITY,
  changePassword,
  NEW_PASSWORD,
  snapshotPasswordState,
} from './password-change-fixture.ts';

const EMAIL = 'user@example.com';
const NOW = 1_700_000_000_000;
const CLIENT = '198.51.100.7';
const DAY_MS = 86_400_000;

describe('password change over a real TCP port', () => {
  it('changes the password and replaces the current browser session for the original identity', async () => {
    await withListeningApp(async (baseUrl, app) => {
      const registered = await registerAccount(app, 'user@example.com');
      const login = await successfulLogin(baseUrl, registered.email);
      const oldCookie = `platform_session=${login.token}`;
      const before = await getIdentity(baseUrl, oldCookie);
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual(registered);

      const changed = await postJson(
        `${baseUrl}/_platform/api/change-password`,
        { currentPassword: PASSWORD, newPassword: ' NewPassW0rd ' },
        { cookie: oldCookie },
      );

      expect(changed.status).toBe(204);
      expect(await changed.text()).toBe('');
      const cookies = changed.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      const freshToken = sessionCookieToken(cookies);
      expect(freshToken).not.toBe(login.token);
      const freshIdentity = await getIdentity(baseUrl, `platform_session=${freshToken}`);
      expect(freshIdentity.status).toBe(200);
      expect(await freshIdentity.json()).toEqual(registered);
      const oldIdentity = await getIdentity(baseUrl, oldCookie);
      expect(oldIdentity.status).toBe(401);
    });
  });
});

describe('password-change browser and password contracts', () => {
  it.each([false, true])(
    'revokes both browsers and issues one replacement with cookieSecure=%s',
    async (cookieSecure) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      try {
        await withListeningApp(
          async (baseUrl, app, database, lines) => {
            const identity = await registerAccount(app, EMAIL);
            const otherIdentity = await registerAccount(app, 'other@example.com');
            const browserA = await successfulLogin(baseUrl, EMAIL);
            const browserB = await successfulLogin(baseUrl, EMAIL);
            const other = await successfulLogin(baseUrl, otherIdentity.email);
            const otherRows = database
              .prepare('SELECT * FROM platform_sessions WHERE user_id = ? ORDER BY token_hash')
              .all(otherIdentity.id);

            const changed = await changePassword(
              baseUrl,
              `platform_session=${browserA.token}`,
              PASSWORD,
              NEW_PASSWORD,
              {
                'x-forwarded-for': CLIENT,
              },
            );

            expect(changed.status).toBe(204);
            expect(await changed.text()).toBe('');
            const cookies = changed.headers.getSetCookie();
            expect(cookies).toHaveLength(1);
            expect(cookieAttributes(cookies[0] ?? '')).toEqual(
              ['HttpOnly', 'Path=/', 'SameSite=Lax', ...(cookieSecure ? ['Secure'] : [])].sort(),
            );
            const fresh = sessionCookieToken(cookies);
            expect(fresh).not.toBe(browserA.token);
            expect(fresh).not.toBe(browserB.token);
            expect(
              database
                .prepare('SELECT * FROM platform_sessions WHERE user_id = ? ORDER BY token_hash')
                .all(otherIdentity.id),
            ).toEqual(otherRows);
            const recognized = await getIdentity(baseUrl, `platform_session=${fresh}`);
            expect(recognized.status).toBe(200);
            expect(await recognized.json()).toEqual(identity);
            expect((await getIdentity(baseUrl, `platform_session=${browserA.token}`)).status).toBe(
              401,
            );
            expect((await getIdentity(baseUrl, `platform_session=${browserB.token}`)).status).toBe(
              401,
            );
            const retained = await getIdentity(baseUrl, `platform_session=${other.token}`);
            expect(retained.status).toBe(200);
            expect(await retained.json()).toEqual(otherIdentity);
            expect(
              database
                .prepare(
                  'SELECT created_at, last_activity_at FROM platform_sessions WHERE user_id = ?',
                )
                .all(identity.id),
            ).toEqual([{ created_at: NOW, last_activity_at: NOW }]);
            const events = queryAuditEvents(database, {
              page: 1,
              pageSize: 10,
              eventType: 'password.changed',
            });
            expect(events).toEqual([
              {
                id: 6,
                createdAt: NOW,
                type: 'password.changed',
                actorEmail: EMAIL,
                targetEmail: EMAIL,
                target: identity.id,
                sourceAddress: CLIENT,
                details: {},
              },
            ]);
            const oldLogin = await postJson(`${baseUrl}/_platform/api/login`, {
              email: EMAIL,
              password: PASSWORD,
            });
            expect(oldLogin.status).toBe(401);
            expect(oldLogin.headers.getSetCookie()).toEqual([]);
            const newLogin = await postJson(`${baseUrl}/_platform/api/login`, {
              email: EMAIL,
              password: NEW_PASSWORD,
            });
            expect(newLogin.status).toBe(200);
            expect(readPublicIdentity(await newLogin.json())).toEqual(identity);
            for (const secret of [
              PASSWORD,
              NEW_PASSWORD,
              browserA.token,
              browserB.token,
              fresh,
              other.token,
            ]) {
              expect(`${lines.join('')}${JSON.stringify(events)}`).not.toContain(secret);
            }
          },
          cookieSecure,
          ['127.0.0.1'],
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([6, 256])(
    'accepts %s Unicode code points without changing password identity',
    async (count) => {
      await withListeningApp(async (baseUrl, app) => {
        const identity = await registerAccount(app, EMAIL);
        const login = await successfulLogin(baseUrl, EMAIL);
        const password = '😀'.repeat(count);

        const changed = await changePassword(
          baseUrl,
          `platform_session=${login.token}`,
          PASSWORD,
          password,
        );

        expect(changed.status).toBe(204);
        const loginNew = await postJson(`${baseUrl}/_platform/api/login`, {
          email: EMAIL,
          password,
        });
        expect(loginNew.status).toBe(200);
        expect(await loginNew.json()).toEqual(identity);
      });
    },
  );

  it('keeps distinct lone surrogate and replacement-character passwords distinct in both fields', async () => {
    await withListeningApp(async (baseUrl, _app, database) => {
      const current = 'abcde\uD800';
      const replacement = 'vwxyz\uDC00';
      const registered = await postJson(`${baseUrl}/_platform/api/register`, {
        email: EMAIL,
        password: current,
      });
      expect(registered.status).toBe(201);
      const identity = readPublicIdentity(await registered.json());
      const cookie = `platform_session=${sessionCookieToken(registered.headers.getSetCookie())}`;
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);
      for (const wrong of ['abcde\uDC00', 'abcde\uFFFD']) {
        const rejected = await changePassword(baseUrl, cookie, wrong, replacement);
        expect(rejected.status).toBe(401);
        expect(rejected.headers.getSetCookie()).toEqual([]);
        expect(snapshotPasswordState(database)).toEqual(before);
      }

      const changed = await changePassword(baseUrl, cookie, current, replacement);

      expect(changed.status).toBe(204);
      for (const wrong of ['vwxyz\uD800', 'vwxyz\uFFFD']) {
        const rejected = await postJson(`${baseUrl}/_platform/api/login`, {
          email: EMAIL,
          password: wrong,
        });
        expect(rejected.status).toBe(401);
      }
      const login = await postJson(`${baseUrl}/_platform/api/login`, {
        email: EMAIL,
        password: replacement,
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual(identity);
    });
  });

  it('allows the same password while rotating the hash and revoking old sessions', async () => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      const before = database.prepare('SELECT password_hash FROM users WHERE email = ?').get(EMAIL);

      const changed = await changePassword(
        baseUrl,
        `platform_session=${login.token}`,
        PASSWORD,
        PASSWORD,
      );

      expect(changed.status).toBe(204);
      expect(
        database.prepare('SELECT password_hash FROM users WHERE email = ?').get(EMAIL),
      ).not.toEqual(before);
      const fresh = sessionCookieToken(changed.headers.getSetCookie());
      expect(fresh).not.toBe(login.token);
      expect((await getIdentity(baseUrl, `platform_session=${login.token}`)).status).toBe(401);
      expect((await getIdentity(baseUrl, `platform_session=${fresh}`)).status).toBe(200);
      expect(
        (await postJson(`${baseUrl}/_platform/api/login`, { email: EMAIL, password: PASSWORD }))
          .status,
      ).toBe(200);
    });
  });
});

describe('password-change rejection preserves all persisted state', () => {
  it.each([
    'missing',
    'malformed',
    'duplicate',
    'digest',
    'unknown',
    'expired',
    'disabled',
  ] as const)('rejects a %s cookie without activity renewal', async (kind) => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      let cookie: string | undefined = `platform_session=${login.token}`;
      if (kind === 'missing') cookie = undefined;
      if (kind === 'malformed') cookie = 'platform_session=not-a-token';
      if (kind === 'duplicate')
        cookie = `platform_session=${login.token}; platform_session=${login.token}`;
      if (kind === 'digest')
        cookie = `platform_session=${createHash('sha256').update(login.token).digest('hex')}`;
      if (kind === 'unknown') cookie = `platform_session=${'a'.repeat(64)}`;
      if (kind === 'expired')
        database
          .prepare('UPDATE platform_sessions SET last_activity_at = ?')
          .run(Date.now() - 7 * DAY_MS - 1);
      if (kind === 'disabled') database.exec("UPDATE users SET status = 'disabled'");
      const before = snapshotPasswordState(database);

      const rejected = await changePassword(baseUrl, cookie);

      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
      });
      expect(rejected.headers.getSetCookie()).toEqual([]);
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });

  it.each([
    { current: 'wrong-password', next: NEW_PASSWORD, status: 401 },
    { current: PASSWORD, next: '😀'.repeat(5), status: 400 },
    { current: PASSWORD, next: '😀'.repeat(257), status: 400 },
  ])('rejects invalid credentials %# without renewing or changing rows', async (scenario) => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);

      const rejected = await changePassword(
        baseUrl,
        `platform_session=${login.token}`,
        scenario.current,
        scenario.next,
      );

      expect(rejected.status).toBe(scenario.status);
      expect(rejected.headers.getSetCookie()).toEqual([]);
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });

  it('neither increments nor clears the existing login failure window', async () => {
    await withListeningApp(async (baseUrl, app) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      for (let attempt = 0; attempt < 9; attempt += 1) {
        expect(
          (
            await postJson(`${baseUrl}/_platform/api/login`, {
              email: EMAIL,
              password: 'wrong-password',
            })
          ).status,
        ).toBe(401);
      }
      const cookie = `platform_session=${login.token}`;
      expect((await changePassword(baseUrl, cookie, 'wrong-password')).status).toBe(401);
      expect((await changePassword(baseUrl, cookie)).status).toBe(204);
      const stillAllowed = await postJson(`${baseUrl}/_platform/api/login`, {
        email: EMAIL,
        password: NEW_PASSWORD,
      });
      expect(stillAllowed.status).toBe(200);
      expect(
        (
          await postJson(`${baseUrl}/_platform/api/login`, {
            email: EMAIL,
            password: 'wrong-password',
          })
        ).status,
      ).toBe(401);
      const blocked = await postJson(`${baseUrl}/_platform/api/login`, {
        email: EMAIL,
        password: NEW_PASSWORD,
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.getSetCookie()).toEqual([]);
    });
  });
});

describe('password-change raw HTTP input types', () => {
  it.each([
    { currentPassword: 123456, newPassword: NEW_PASSWORD },
    { currentPassword: [PASSWORD], newPassword: NEW_PASSWORD },
    { currentPassword: null, newPassword: NEW_PASSWORD },
    { currentPassword: PASSWORD, newPassword: 123456 },
    { currentPassword: PASSWORD, newPassword: [NEW_PASSWORD] },
    { currentPassword: PASSWORD, newPassword: null },
  ])('rejects implicit password coercion %# without changing state', async (payload) => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);

      const rejected = await postJson(`${baseUrl}/_platform/api/change-password`, payload, {
        cookie: `platform_session=${login.token}`,
      });

      expect(rejected.status).toBe(400);
      expect(rejected.headers.getSetCookie()).toEqual([]);
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });
});

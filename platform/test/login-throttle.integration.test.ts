import { describe, expect, it, vi } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import { sessionCookieHeader, snapshotAuthState } from './auth-fixture.ts';
import {
  getIdentity,
  LOOPBACK_ADDRESSES,
  PASSWORD,
  postJson,
  registerAccount,
  withListeningApp,
} from './auth-tcp-fixture.ts';

const EMAIL = '  User@Example.com  ';
const CANONICAL_EMAIL = 'user@example.com';
const OTHER_EMAIL = 'other@example.com';
const WRONG_PASSWORD = 'wrong-password';
const CLIENT_A = '198.51.100.7';
const MAPPED_A = '::ffff:198.51.100.7';
const CLIENT_B = '203.0.113.10';
const TRUSTED_LOOPBACK = ['127.0.0.1'] as const;
const NOW = new Date('2026-01-15T00:00:00.000Z');
const WINDOW_MS = 900_000;
const TOO_MANY_LOGIN_ATTEMPTS = {
  statusCode: 429,
  error: 'Too Many Requests',
  message: 'Too many login attempts',
} as const;

function loginUrl(baseUrl: string): string {
  return `${baseUrl}/_platform/api/login`;
}

async function withControlledDate(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(NOW);
    await run();
  } finally {
    vi.useRealTimers();
  }
}

async function failWrongPassword(
  baseUrl: string,
  email: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<void> {
  const failed = await postJson(
    loginUrl(baseUrl),
    { email, password: WRONG_PASSWORD },
    extraHeaders,
  );
  expect(failed.status).toBe(401);
  await failed.json();
}

async function expectBlocked(
  response: Response,
  database: Parameters<typeof snapshotAuthState>[0],
  sessions: unknown[],
): Promise<void> {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual(TOO_MANY_LOGIN_ATTEMPTS);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(snapshotAuthState(database).sessions).toEqual(sessions);
}

describe('login failure throttling over a real TCP port', () => {
  it('rejects a correct password as 429 after ten wrong-password failures for the same canonical email and source', async () => {
    await withControlledDate(async () => {
      await withListeningApp(async (baseUrl, app, database) => {
        await registerAccount(app, EMAIL);
        const sessions = snapshotAuthState(database).sessions;

        for (let attempt = 0; attempt < 10; attempt += 1) {
          await failWrongPassword(baseUrl, EMAIL);
        }

        const blocked = await postJson(loginUrl(baseUrl), { email: EMAIL, password: PASSWORD });
        await expectBlocked(blocked, database, sessions);
      });
    });
  });

  it('keeps a successful login after nine failures and still blocks on the tenth completed failure', async () => {
    await withControlledDate(async () => {
      await withListeningApp(async (baseUrl, app, database, lines) => {
        await registerAccount(app, EMAIL);
        for (let attempt = 0; attempt < 9; attempt += 1) {
          await failWrongPassword(baseUrl, EMAIL);
        }

        const succeeded = await postJson(loginUrl(baseUrl), { email: EMAIL, password: PASSWORD });
        expect(succeeded.status).toBe(200);
        const cookie = sessionCookieHeader(succeeded.headers.getSetCookie());
        await succeeded.json();
        const sessions = snapshotAuthState(database).sessions;

        await failWrongPassword(baseUrl, EMAIL);
        const blocked = await postJson(loginUrl(baseUrl), { email: EMAIL, password: PASSWORD });
        const blockedBody = await blocked.json();
        expect(blocked.status).toBe(429);
        expect(blockedBody).toEqual(TOO_MANY_LOGIN_ATTEMPTS);
        expect(blocked.headers.getSetCookie()).toEqual([]);
        expect(snapshotAuthState(database).sessions).toEqual(sessions);

        const identity = await getIdentity(baseUrl, cookie);
        expect(identity.status).toBe(200);
        const failed = queryAuditEvents(database, {
          page: 1,
          pageSize: 20,
          eventType: 'login.failed',
        });
        expect(failed).toHaveLength(11);
        expect(failed[0]).toMatchObject({ type: 'login.failed', details: {} });
        expect(
          `${JSON.stringify(blockedBody)}${lines.join('')}${JSON.stringify(failed)}`,
        ).not.toContain(PASSWORD);
      });
    });
  });

  it('recovers at the first-failure deadline and does not extend the window with blocked traffic', async () => {
    await withControlledDate(async () => {
      await withListeningApp(async (baseUrl, app, database) => {
        await registerAccount(app, EMAIL);
        await failWrongPassword(baseUrl, EMAIL);
        vi.setSystemTime(new Date(NOW.getTime() + 1_000));
        for (let attempt = 0; attempt < 9; attempt += 1) {
          await failWrongPassword(baseUrl, EMAIL);
        }
        const sessions = snapshotAuthState(database).sessions;

        const blockedEarly = await postJson(loginUrl(baseUrl), {
          email: EMAIL,
          password: PASSWORD,
        });
        await expectBlocked(blockedEarly, database, sessions);

        vi.setSystemTime(new Date(NOW.getTime() + WINDOW_MS - 1));
        const stillBlocked = await postJson(loginUrl(baseUrl), {
          email: EMAIL,
          password: PASSWORD,
        });
        await expectBlocked(stillBlocked, database, sessions);

        vi.setSystemTime(new Date(NOW.getTime() + WINDOW_MS));
        const recovered = await postJson(loginUrl(baseUrl), { email: EMAIL, password: PASSWORD });
        expect(recovered.status).toBe(200);
        expect(recovered.headers.getSetCookie()).toHaveLength(1);
        await recovered.json();
      });
    });
  });

  it('isolates canonical email and forwarded-source aliases from other emails and sources', async () => {
    await withControlledDate(async () => {
      await withListeningApp(
        async (baseUrl, app, database) => {
          await registerAccount(app, EMAIL);
          await registerAccount(app, OTHER_EMAIL);
          const aliases = [
            { email: EMAIL, forwardedFor: CLIENT_A },
            { email: CANONICAL_EMAIL, forwardedFor: MAPPED_A },
          ] as const;
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const alias = aliases[attempt % aliases.length];
            if (alias === undefined) {
              throw new Error('expected alias');
            }
            await failWrongPassword(baseUrl, alias.email, {
              'X-Forwarded-For': alias.forwardedFor,
            });
          }
          const sessions = snapshotAuthState(database).sessions;

          const blocked = await postJson(
            loginUrl(baseUrl),
            { email: EMAIL, password: PASSWORD },
            { 'X-Forwarded-For': CLIENT_A },
          );
          await expectBlocked(blocked, database, sessions);

          const otherEmail = await postJson(
            loginUrl(baseUrl),
            { email: OTHER_EMAIL, password: PASSWORD },
            { 'X-Forwarded-For': CLIENT_A },
          );
          expect(otherEmail.status).toBe(200);
          await otherEmail.json();

          const otherSource = await postJson(
            loginUrl(baseUrl),
            { email: EMAIL, password: PASSWORD },
            { 'X-Forwarded-For': CLIENT_B },
          );
          expect(otherSource.status).toBe(200);
          await otherSource.json();
        },
        false,
        TRUSTED_LOOPBACK,
      );
    });
  });

  it('does not split an untrusted loopback key with forged X-Forwarded-For values', async () => {
    await withControlledDate(async () => {
      await withListeningApp(async (baseUrl, app, database) => {
        await registerAccount(app, EMAIL);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await failWrongPassword(baseUrl, EMAIL, { 'X-Forwarded-For': CLIENT_A });
        }
        const sessions = snapshotAuthState(database).sessions;

        const blocked = await postJson(
          loginUrl(baseUrl),
          { email: EMAIL, password: PASSWORD },
          { 'X-Forwarded-For': CLIENT_B },
        );
        await expectBlocked(blocked, database, sessions);
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 20,
          eventType: 'login.failed',
        });
        expect(events).toHaveLength(11);
        expect(LOOPBACK_ADDRESSES).toContain(events[0]?.sourceAddress);
      });
    });
  });
});

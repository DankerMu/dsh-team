import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_ORIGIN } from './auth-fixture.ts';
import {
  LOOPBACK_ADDRESSES,
  PASSWORD,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import {
  EMAIL,
  expectGuardRejection,
  FOREIGN_ORIGIN,
  INVALID_ORIGIN,
  JSON_REQUIRED,
  postRaw,
  rejectedMutationRequests,
  sendRejectedRequest,
} from './origin-fixture.ts';
import { BACKDATE_ACTIVITY, snapshotPasswordState } from './password-change-fixture.ts';

describe('platform request origin over a real TCP port', () => {
  it('rejects registration without Origin without changing users, sessions, or audits', async () => {
    await withListeningApp(async (baseUrl, _app, database) => {
      const before = snapshotPasswordState(database);

      // Raw fetch deliberately omits Origin, independent of positive helper defaults.
      const response = await fetch(`${baseUrl}/_platform/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', password: PASSWORD }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Invalid request origin',
      });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });

  it('rejects mutation traffic without changing full state or incrementing or resetting nine login failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
      await withListeningApp(
        async (baseUrl, app, database) => {
          await registerAccount(app, EMAIL);
          const login = await successfulLogin(baseUrl, EMAIL);
          const cookie = `platform_session=${login.token}`;
          database.exec(BACKDATE_ACTIVITY);
          for (let attempt = 0; attempt < 9; attempt += 1) {
            const failed = await postJson(`${baseUrl}/_platform/api/login`, {
              email: EMAIL,
              password: 'wrong-password',
            });
            expect(failed.status).toBe(401);
            expect(await failed.json()).toEqual({
              statusCode: 401,
              error: 'Unauthorized',
              message: 'Invalid email or password',
            });
          }
          const before = snapshotPasswordState(database);

          for (const testCase of rejectedMutationRequests(cookie)) {
            await expectGuardRejection(
              await sendRejectedRequest(baseUrl, testCase),
              database,
              before,
              testCase.status,
              testCase.label,
            );
          }
          for (const origin of [
            '',
            'null',
            `${PUBLIC_ORIGIN}, ${PUBLIC_ORIGIN}`,
            'https://127.0.0.1:8080',
            'http://localhost:8080',
            'http://127.0.0.1:8081',
            'http://127.0.0.1:08080',
            `${PUBLIC_ORIGIN}/`,
            `${PUBLIC_ORIGIN}/page`,
            `${PUBLIC_ORIGIN}?query`,
            `${PUBLIC_ORIGIN}#fragment`,
            'http://user@127.0.0.1:8080',
          ]) {
            await expectGuardRejection(
              await sendRejectedRequest(baseUrl, {
                label: 'nonexact Origin',
                route: 'login',
                headers: { origin, 'content-type': 'application/json' },
                body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
                status: 403,
              }),
              database,
              before,
              403,
              'nonexact Origin',
            );
          }
          for (const origin of [undefined, FOREIGN_ORIGIN]) {
            await expectGuardRejection(
              await sendRejectedRequest(baseUrl, {
                label: 'spoofed origin substitutes',
                route: 'login',
                status: 403,
                body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
                headers: {
                  origin,
                  'content-type': 'application/json',
                  host: '127.0.0.1:8080',
                  referer: `${PUBLIC_ORIGIN}/page`,
                  'x-forwarded-host': '127.0.0.1:8080',
                  'x-forwarded-proto': 'http',
                  'x-forwarded-for': '127.0.0.1',
                  forwarded: 'for=127.0.0.1;host="127.0.0.1:8080";proto=http',
                },
              }),
              database,
              before,
              403,
              'spoofed origin substitutes',
            );
            for (const media of [
              { contentType: 'application/json', body: '{', status: 400 },
              {
                contentType: 'application/x-www-form-urlencoded',
                body: 'email=user%40example.com&password=PassW0rd',
                status: 415,
              },
            ]) {
              const testCase = {
                label: 'Origin before media or parsing',
                route: 'login',
                status: 403 as const,
                body: media.body,
                headers: { origin, 'content-type': media.contentType },
              };
              await expectGuardRejection(
                await sendRejectedRequest(baseUrl, testCase),
                database,
                before,
                403,
                testCase.label,
              );
              const sameOrigin = await sendRejectedRequest(baseUrl, {
                ...testCase,
                headers: { ...testCase.headers, origin: PUBLIC_ORIGIN },
              });
              expect(sameOrigin.status).toBe(media.status);
              if (media.status === 400) {
                expect(await sameOrigin.json()).toMatchObject({
                  statusCode: 400,
                  error: 'Bad Request',
                });
              } else {
                expect(await sameOrigin.json()).toEqual(JSON_REQUIRED);
              }
              expect(sameOrigin.headers.getSetCookie()).toEqual([]);
              expect(snapshotPasswordState(database)).toEqual(before);
            }
          }
          for (const secondOrigin of [PUBLIC_ORIGIN, FOREIGN_ORIGIN]) {
            const duplicate = await postRaw(
              baseUrl,
              'login?origin=ignored',
              {
                email: EMAIL,
                password: PASSWORD,
              },
              ['Origin', PUBLIC_ORIGIN, 'oRiGiN', secondOrigin],
            );
            expect(duplicate.statusCode).toBe(403);
            expect(JSON.parse(duplicate.body)).toEqual(INVALID_ORIGIN);
            expect(duplicate.headers['set-cookie']).toBeUndefined();
            expect(snapshotPasswordState(database)).toEqual(before);
          }

          const tenth = await postJson(`${baseUrl}/_platform/api/login`, {
            email: EMAIL,
            password: 'wrong-password',
          });
          expect(tenth.status).toBe(401);
          expect(await tenth.json()).toEqual({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Invalid email or password',
          });
          expect(tenth.headers.getSetCookie()).toEqual([]);
          const afterTenth = snapshotPasswordState(database);
          expect(afterTenth.users).toEqual(before.users);
          expect(afterTenth.sessions).toEqual(before.sessions);
          const blocked = await postJson(`${baseUrl}/_platform/api/login`, {
            email: EMAIL,
            password: PASSWORD,
          });
          expect(blocked.status).toBe(429);
          expect(await blocked.json()).toEqual({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Too many login attempts',
          });
          expect(blocked.headers.getSetCookie()).toEqual([]);
          const afterBlocked = snapshotPasswordState(database);
          expect(afterBlocked.users).toEqual(afterTenth.users);
          expect(afterBlocked.sessions).toEqual(afterTenth.sessions);
          expect(afterBlocked.audits).toHaveLength(afterTenth.audits.length + 1);
          expect(afterBlocked.audits.slice(0, -1)).toEqual(afterTenth.audits);
          expect(afterBlocked.audits.at(-1)).toMatchObject({
            created_at: new Date('2026-01-15T00:00:00.000Z').getTime(),
            event_type: 'login.failed',
            actor_email: EMAIL,
            target_email: null,
            target: null,
            source_address: '127.0.0.1',
            details: '{}',
          });
        },
        false,
        LOOPBACK_ADDRESSES,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

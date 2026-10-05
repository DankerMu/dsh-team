import type * as NodeCrypto from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import { deleteUserSessions, hashPassword } from '../src/auth/index.ts';
import {
  createBarrier,
  cryptoBarrier,
  discardBarrier,
  waitForDerivation,
} from './auth-crypto-fixture.ts';
import { sessionCookieToken, tableCounts } from './auth-fixture.ts';
import {
  expectNoSecrets,
  getIdentity,
  PASSWORD,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import type { PasswordStateSnapshot } from './password-change-fixture.ts';
import {
  BACKDATE_ACTIVITY,
  changePassword,
  NEW_PASSWORD,
  snapshotPasswordState,
} from './password-change-fixture.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  // Vitest hoists this factory before static imports initialize; load the shared controls here.
  const { controlledScrypt } = await import('./auth-crypto-fixture.ts');
  return { ...actual, scrypt: controlledScrypt(actual.scrypt) };
});

afterAll(() => {
  vi.doUnmock('node:crypto');
});

const EMAIL = 'user@example.com';
const WINNER_PASSWORD = 'winner-password';
const DAY_MS = 86_400_000;
type Phase = 'verification' | 'replacement';

/** Observes verification separately, so replacement holds demonstrably occur after the first await. */
async function changeWhileHeld(
  baseUrl: string,
  cookie: string,
  phase: Phase,
  duringHold: () => void | Promise<void>,
  error?: Error,
): Promise<Response> {
  const verification = createBarrier(phase === 'verification' ? error : undefined);
  const replacement = phase === 'replacement' ? createBarrier(error) : undefined;
  const callsBefore = cryptoBarrier.calls;
  let pending: Promise<Response> | undefined;
  cryptoBarrier.queue.push(verification);
  if (replacement !== undefined) cryptoBarrier.queue.push(replacement);
  try {
    pending = changePassword(baseUrl, cookie);
    await waitForDerivation(verification, pending, 'password verification');
    expect(cryptoBarrier.calls).toBe(callsBefore + 1);
    if (replacement !== undefined) {
      verification.release();
      await waitForDerivation(replacement, pending, 'replacement password hashing');
      expect(cryptoBarrier.calls).toBe(callsBefore + 2);
    }
    await duringHold();
    verification.release();
    replacement?.release();
    return await pending;
  } finally {
    discardBarrier(verification);
    if (replacement !== undefined) discardBarrier(replacement);
    if (pending !== undefined) await Promise.allSettled([pending]);
  }
}

const RACES = [
  { phase: 'verification', change: 'logout', sessions: 1, audits: 3 },
  { phase: 'verification', change: 'competing rotation', sessions: 1, audits: 3 },
  { phase: 'replacement', change: 'logout', sessions: 1, audits: 3 },
  { phase: 'replacement', change: 'competing rotation', sessions: 1, audits: 3 },
  { phase: 'replacement', change: 'user-wide revocation', sessions: 0, audits: 2 },
  { phase: 'replacement', change: 'disabled account', sessions: 2, audits: 2 },
  { phase: 'replacement', change: 'expired session', sessions: 2, audits: 2 },
  { phase: 'replacement', change: 'changed password hash', sessions: 2, audits: 2 },
] as const;

describe('password-change authorization after real crypto over TCP', () => {
  it.each(RACES)(
    'rejects $change during $phase without overwriting intervening state',
    async (scenario) => {
      await withListeningApp(async (baseUrl, app, database, lines) => {
        const identity = await registerAccount(app, EMAIL);
        const login = await successfulLogin(baseUrl, EMAIL);
        const interveningHash = await hashPassword(WINNER_PASSWORD);
        database.exec(BACKDATE_ACTIVITY);
        const before = snapshotPasswordState(database);
        let intervening: PasswordStateSnapshot | undefined;
        let winningToken: string | undefined;

        const stale = await changeWhileHeld(
          baseUrl,
          `platform_session=${login.token}`,
          scenario.phase,
          async () => {
            expect(snapshotPasswordState(database)).toEqual(before);
            if (scenario.change === 'logout') {
              const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
                method: 'POST',
                headers: { cookie: `platform_session=${login.token}` },
              });
              expect(logout.status).toBe(204);
              expect(await logout.text()).toBe('');
            } else if (scenario.change === 'competing rotation') {
              const winner = await changePassword(
                baseUrl,
                `platform_session=${login.token}`,
                PASSWORD,
                WINNER_PASSWORD,
              );
              expect(winner.status).toBe(204);
              expect(await winner.text()).toBe('');
              winningToken = sessionCookieToken(winner.headers.getSetCookie());
            } else if (scenario.change === 'user-wide revocation') {
              deleteUserSessions(database, identity.id);
            } else if (scenario.change === 'disabled account') {
              database
                .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
                .run(identity.id);
            } else if (scenario.change === 'expired session') {
              database
                .prepare('UPDATE platform_sessions SET last_activity_at = ? WHERE user_id = ?')
                .run(Date.now() - 7 * DAY_MS - 1, identity.id);
            } else {
              database
                .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
                .run(interveningHash, identity.id);
            }
            intervening = snapshotPasswordState(database);
          },
        );

        expect(stale.status).toBe(401);
        const body: unknown = await stale.json();
        expect(body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
        expect(stale.headers.getSetCookie()).toEqual([]);
        if (intervening === undefined) throw new Error('expected intervening state snapshot');
        expect(snapshotPasswordState(database)).toEqual(intervening);
        expect(tableCounts(database)).toEqual({
          users: 1,
          sessions: scenario.sessions,
          audits: scenario.audits,
        });
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'password.changed',
        });
        expect(events).toHaveLength(scenario.change === 'competing rotation' ? 1 : 0);
        if (winningToken !== undefined) {
          const recognized = await getIdentity(baseUrl, `platform_session=${winningToken}`);
          expect(recognized.status).toBe(200);
          expect(await recognized.json()).toEqual(identity);
          expect((await getIdentity(baseUrl, `platform_session=${login.token}`)).status).toBe(401);
        }
        expectNoSecrets(lines, { body, events }, [
          PASSWORD,
          NEW_PASSWORD,
          WINNER_PASSWORD,
          login.token,
          ...(winningToken === undefined ? [] : [winningToken]),
        ]);
        expect(cryptoBarrier.queue).toEqual([]);
      });
    },
  );

  it.each(['verification', 'replacement'] as const)(
    'propagates a %s crypto error without any mutation or cookie',
    async (phase) => {
      await withListeningApp(async (baseUrl, app, database, lines) => {
        await registerAccount(app, EMAIL);
        const login = await successfulLogin(baseUrl, EMAIL);
        database.exec(BACKDATE_ACTIVITY);
        const before = snapshotPasswordState(database);
        const error = new Error(`${phase}-crypto-fault`);

        const failed = await changeWhileHeld(
          baseUrl,
          `platform_session=${login.token}`,
          phase,
          () => {
            expect(snapshotPasswordState(database)).toEqual(before);
          },
          error,
        );

        expect(failed.status).toBe(500);
        const body: unknown = await failed.json();
        expect(body).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: error.message,
        });
        expect(failed.headers.getSetCookie()).toEqual([]);
        expect(snapshotPasswordState(database)).toEqual(before);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });
        expectNoSecrets(lines, body, [PASSWORD, NEW_PASSWORD, login.token]);
        expect(cryptoBarrier.queue).toEqual([]);
      });
    },
  );

  it('rejects a missing identity without invoking crypto or touching persisted state', async () => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);
      const callsBefore = cryptoBarrier.calls;

      const rejected = await changePassword(baseUrl, undefined);

      expect(rejected.status).toBe(401);
      expect(rejected.headers.getSetCookie()).toEqual([]);
      expect(cryptoBarrier.calls).toBe(callsBefore);
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });
});

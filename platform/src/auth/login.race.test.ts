import type * as NodeCrypto from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  cookieHeaders,
  injectLogin,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import { hashPassword, validateSession } from './index.ts';

const EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const REPLACEMENT_PASSWORD = 'replacement-password';
const SNAPSHOT_SESSIONS =
  'SELECT token_hash, user_id, created_at, last_activity_at FROM platform_sessions ORDER BY token_hash';
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

interface CallbackBarrier {
  derived: Promise<void>;
  hold: (deliver: () => void) => void;
  release: () => void;
}

const cryptoBarrier = vi.hoisted((): { next: CallbackBarrier | undefined } => ({
  next: undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    scrypt: (...args: Parameters<typeof actual.scrypt>): void => {
      const [password, salt, keyLength, options, callback] = args;
      const barrier = cryptoBarrier.next;
      cryptoBarrier.next = undefined;
      actual.scrypt(password, salt, keyLength, options, (error, derivedKey) => {
        const deliver = (): void => {
          callback(error, derivedKey);
        };
        if (barrier === undefined || error !== null) {
          deliver();
        } else {
          barrier.hold(deliver);
        }
      });
    },
  };
});

afterAll(() => {
  vi.doUnmock('node:crypto');
});

function createBarrier(): CallbackBarrier {
  const derived = Promise.withResolvers<undefined>();
  let released = false;
  let held: (() => void) | undefined;
  return {
    derived: derived.promise,
    hold: (deliver) => {
      held = deliver;
      derived.resolve(undefined);
      if (released) {
        held = undefined;
        deliver();
      }
    },
    release: () => {
      released = true;
      const deliver = held;
      held = undefined;
      deliver?.();
    },
  };
}

async function loginDuringChange(
  app: FastifyInstance,
  change: () => void,
): Promise<LightMyRequestResponse> {
  const barrier = createBarrier();
  let pending: Promise<LightMyRequestResponse> | undefined;
  // Startup's dummy hash, registration, and replacement hashing have already finished.
  cryptoBarrier.next = barrier;
  try {
    pending = injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
    await Promise.race([
      barrier.derived,
      pending.then(() => {
        throw new Error('login completed before real password derivation reached the barrier');
      }),
    ]);
    change();
    barrier.release();
    return await pending;
  } finally {
    cryptoBarrier.next = undefined;
    barrier.release();
    // Drain the held request before withApp closes its app/database, even if change throws.
    if (pending !== undefined) {
      await Promise.allSettled([pending]);
    }
  }
}

describe('POST /_platform/api/login account changes during verification', () => {
  it.each([
    {
      label: 'disabled',
      sql: "UPDATE users SET status = 'disabled' WHERE email = ?",
      replacePassword: false,
      expected: FORBIDDEN,
    },
    {
      label: 'given a different password hash',
      sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
      replacePassword: true,
      expected: UNAUTHORIZED,
    },
  ])('rejects an account $label before issuing a session', async (scenario) => {
    await withApp(async (app, database, lines) => {
      const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
      expect(registered.statusCode).toBe(201);
      const registerToken = sessionCookieToken(cookieHeaders(registered));
      const user = database
        .prepare<[string], { password_hash: string }>(
          'SELECT password_hash FROM users WHERE email = ?',
        )
        .get(EMAIL);
      if (user === undefined) {
        throw new Error('expected registered user');
      }
      const replacementHash = scenario.replacePassword
        ? await hashPassword(REPLACEMENT_PASSWORD)
        : undefined;
      const sessionsBefore = database.prepare(SNAPSHOT_SESSIONS).all();

      const login = await loginDuringChange(app, () => {
        if (replacementHash === undefined) {
          database.prepare(scenario.sql).run(EMAIL);
        } else {
          database.prepare(scenario.sql).run(replacementHash, EMAIL);
        }
      });

      expect(login.statusCode).toBe(scenario.expected.statusCode);
      expect(login.json()).toEqual(scenario.expected);
      expect(cookieHeaders(login)).toEqual([]);
      expect(database.prepare(SNAPSHOT_SESSIONS).all()).toEqual(sessionsBefore);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 2 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.failed',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'login.failed',
        actorEmail: EMAIL,
        targetEmail: null,
        target: null,
        sourceAddress: SOURCE,
        details: {},
      });
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'login.succeeded' }),
      ).toEqual([]);
      const written = `${login.body}${lines.join('')}${JSON.stringify(events)}`;
      for (const secret of [PASSWORD, REPLACEMENT_PASSWORD, user.password_hash, registerToken]) {
        expect(written).not.toContain(secret);
      }
      if (replacementHash !== undefined) {
        expect(written).not.toContain(replacementHash);
      }
    });
  });

  it('returns the current admin identity after promotion during verification', async () => {
    await withApp(async (app, database, lines) => {
      const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
      expect(registered.statusCode).toBe(201);
      // JSON.parse is typed as any; the HTTP body is JSON text.
      const registeredUser = readPublicIdentity(JSON.parse(registered.body) as unknown);
      expect(registeredUser).toEqual({ id: registeredUser.id, email: EMAIL, role: 'employee' });
      const registerToken = sessionCookieToken(cookieHeaders(registered));

      const login = await loginDuringChange(app, () => {
        database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(EMAIL);
      });

      expect(login.statusCode).toBe(200);
      expect(login.json()).toEqual({ id: registeredUser.id, email: EMAIL, role: 'admin' });
      expect(cookieHeaders(login)).toHaveLength(1);
      const loginToken = sessionCookieToken(cookieHeaders(login));
      expect(loginToken).not.toBe(registerToken);
      expect(validateSession(database, loginToken, Date.now())).toBe(registeredUser.id);
      expect(validateSession(database, registerToken, Date.now())).toBe(registeredUser.id);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'login.succeeded',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'login.succeeded',
        actorEmail: EMAIL,
        targetEmail: EMAIL,
        target: registeredUser.id,
        sourceAddress: SOURCE,
        details: {},
      });
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'login.failed' }),
      ).toEqual([]);
      const written = `${login.body}${lines.join('')}${JSON.stringify(events)}`;
      for (const secret of [PASSWORD, registerToken, loginToken]) {
        expect(written).not.toContain(secret);
      }
    });
  });
});

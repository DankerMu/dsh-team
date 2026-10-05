import type * as NodeCrypto from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
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
import { hashPassword, validateSession } from './index.ts';

const EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const REPLACEMENT_PASSWORD = 'replacement-password';
const UNKNOWN_LOGIN_EMAIL = '  Nobody@Example.com  ';
const FORWARDED_CLIENT = '198.51.100.7';
const UNKNOWN_EMAIL = 'nobody@example.com';
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
const TOO_MANY_REQUESTS = {
  statusCode: 429,
  error: 'Too Many Requests',
  message: 'Too many login attempts',
} as const;
const WRONG_PASSWORD = 'wrong-password';
const NO_FORWARD_HEADERS: Readonly<Record<string, string>> = {};

const FORWARDED_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'x-forwarded-for': FORWARDED_CLIENT,
};

interface CallbackBarrier {
  derived: Promise<void>;
  hold: (deliver: () => void) => void;
  release: () => void;
}

const cryptoBarrier = vi.hoisted((): { queue: CallbackBarrier[] } => ({
  queue: [],
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    scrypt: (...args: Parameters<typeof actual.scrypt>): void => {
      const [password, salt, keyLength, options, callback] = args;
      const barrier = cryptoBarrier.queue.shift();
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

function discardBarrier(barrier: CallbackBarrier): void {
  const index = cryptoBarrier.queue.indexOf(barrier);
  if (index !== -1) {
    cryptoBarrier.queue.splice(index, 1);
  }
  barrier.release();
}

async function waitForDerivation(
  barrier: CallbackBarrier,
  pending: Promise<LightMyRequestResponse>,
  label: string,
): Promise<void> {
  await Promise.race([
    barrier.derived,
    pending.then(() => {
      throw new Error(`${label} completed before real password derivation reached the barrier`);
    }),
  ]);
}

async function loginWhileHeld(
  app: FastifyInstance,
  duringHold: () => void | Promise<void>,
  credentials: { email: string; password: string } = { email: LOGIN_EMAIL, password: PASSWORD },
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  const barrier = createBarrier();
  let pending: Promise<LightMyRequestResponse> | undefined;
  cryptoBarrier.queue.push(barrier);
  try {
    pending = injectLogin(app, credentials, extraHeaders);
    await waitForDerivation(barrier, pending, 'login');
    await duringHold();
    barrier.release();
    return await pending;
  } finally {
    discardBarrier(barrier);
    if (pending !== undefined) {
      await Promise.allSettled([pending]);
    }
  }
}

async function loginDuringChange(
  app: FastifyInstance,
  change: () => void,
  credentials: { email: string; password: string } = { email: LOGIN_EMAIL, password: PASSWORD },
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  return loginWhileHeld(app, change, credentials, extraHeaders);
}

async function failLogin(
  app: FastifyInstance,
  credentials: { email: string; password: string },
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  const response = await injectLogin(app, credentials, extraHeaders);
  expect(response.statusCode).toBe(401);
  expect(cookieHeaders(response)).toEqual([]);
  return response;
}

async function failLogins(
  app: FastifyInstance,
  count: number,
  credentials: { email: string; password: string } = {
    email: LOGIN_EMAIL,
    password: WRONG_PASSWORD,
  },
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    await failLogin(app, credentials, extraHeaders);
  }
}

async function holdLogin(
  app: FastifyInstance,
  credentials: { email: string; password: string },
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ pending: Promise<LightMyRequestResponse>; release: () => void }> {
  const barrier = createBarrier();
  cryptoBarrier.queue.push(barrier);
  const pending = injectLogin(app, credentials, extraHeaders);
  try {
    await waitForDerivation(barrier, pending, 'held login');
  } catch (error) {
    discardBarrier(barrier);
    await Promise.allSettled([pending]);
    throw error;
  }
  return {
    pending,
    release: () => {
      discardBarrier(barrier);
    },
  };
}

async function expectStillBlocked(
  app: FastifyInstance,
  database: DatabaseHandle,
  sessions: unknown[],
): Promise<void> {
  expect(snapshotAuthState(database).sessions).toEqual(sessions);
  const blocked = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
  expect(blocked.statusCode).toBe(429);
  expect(
    queryAuditEvents(database, { page: 1, pageSize: 20, eventType: 'login.failed' }),
  ).toHaveLength(12);
}

function expectSafeLoginFailure(
  database: DatabaseHandle,
  responses: readonly LightMyRequestResponse[],
  lines: readonly string[],
  actorEmail: string,
  secrets: readonly string[],
  sourceAddress: string = SOURCE,
  failureCount = 1,
): void {
  const events = queryAuditEvents(database, {
    page: 1,
    pageSize: 20,
    eventType: 'login.failed',
  });
  expect(events).toHaveLength(failureCount);
  for (const event of events) {
    expect(event).toMatchObject({
      type: 'login.failed',
      actorEmail,
      targetEmail: null,
      target: null,
      sourceAddress,
      details: {},
    });
  }
  expect(
    queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'login.succeeded' }),
  ).toEqual([]);
  const written = `${responses.map((response) => response.body).join('')}${lines.join('')}${JSON.stringify(events)}`;
  for (const secret of secrets) {
    expect(written).not.toContain(secret);
  }
}

describe('POST /_platform/api/login account changes during verification', () => {
  it.each([
    {
      label: 'disabled',
      sql: "UPDATE users SET status = 'disabled' WHERE email = ?",
      replacePassword: false,
      expected: FORBIDDEN,
      trustedProxies: [SOURCE] as const,
      extraHeaders: FORWARDED_CLIENT_HEADERS,
      sourceAddress: FORWARDED_CLIENT,
    },
    {
      label: 'given a different password hash',
      sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
      replacePassword: true,
      expected: UNAUTHORIZED,
      trustedProxies: [] as const,
      extraHeaders: NO_FORWARD_HEADERS,
      sourceAddress: SOURCE,
    },
  ])('rejects an account $label before issuing a session', async (scenario) => {
    await withApp(
      async (app, database, lines) => {
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
        await failLogins(
          app,
          9,
          { email: LOGIN_EMAIL, password: WRONG_PASSWORD },
          scenario.extraHeaders,
        );
        const sessionsBefore = database.prepare(SNAPSHOT_SESSIONS).all();

        const login = await loginDuringChange(
          app,
          () => {
            if (replacementHash === undefined) {
              database.prepare(scenario.sql).run(EMAIL);
            } else {
              database.prepare(scenario.sql).run(replacementHash, EMAIL);
            }
          },
          { email: LOGIN_EMAIL, password: PASSWORD },
          scenario.extraHeaders,
        );

        expect(login.statusCode).toBe(scenario.expected.statusCode);
        expect(login.json()).toEqual(scenario.expected);
        expect(cookieHeaders(login)).toEqual([]);
        expect(database.prepare(SNAPSHOT_SESSIONS).all()).toEqual(sessionsBefore);
        const blocked = await injectLogin(
          app,
          { email: LOGIN_EMAIL, password: PASSWORD },
          scenario.extraHeaders,
        );
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json()).toEqual(TOO_MANY_REQUESTS);
        expect(cookieHeaders(blocked)).toEqual([]);
        expect(database.prepare(SNAPSHOT_SESSIONS).all()).toEqual(sessionsBefore);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 12 });
        const secrets = [
          PASSWORD,
          WRONG_PASSWORD,
          REPLACEMENT_PASSWORD,
          user.password_hash,
          registerToken,
        ];
        if (replacementHash !== undefined) {
          secrets.push(replacementHash);
        }
        expectSafeLoginFailure(
          database,
          [login, blocked],
          lines,
          EMAIL,
          secrets,
          scenario.sourceAddress,
          11,
        );
      },
      false,
      scenario.trustedProxies,
    );
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

describe('POST /_platform/api/login unknown account derivation', () => {
  it('derives against the dummy hash for a valid-length unknown email before 401', async () => {
    await withApp(async (app, database, lines) => {
      const login = await loginDuringChange(app, () => undefined, {
        email: UNKNOWN_LOGIN_EMAIL,
        password: PASSWORD,
      });

      expect(login.statusCode).toBe(401);
      expect(login.json()).toEqual(UNAUTHORIZED);
      expect(cookieHeaders(login)).toEqual([]);
      expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 1 });
      expectSafeLoginFailure(database, [login], lines, UNKNOWN_EMAIL, [PASSWORD]);
    });
  });
});

describe('POST /_platform/api/login overlapping verification and throttling', () => {
  it('rejects a held correct password as 429 after ten completed wrong-password failures', async () => {
    await withApp(async (app, database) => {
      const registered = await injectRegister(app, { email: EMAIL, password: PASSWORD });
      expect(registered.statusCode).toBe(201);
      const sessions = snapshotAuthState(database).sessions;

      const held = await loginWhileHeld(
        app,
        async () => {
          await failLogins(app, 10);
        },
        { email: LOGIN_EMAIL, password: PASSWORD },
      );

      expect(held.statusCode).toBe(429);
      expect(held.json()).toEqual(TOO_MANY_REQUESTS);
      expect(cookieHeaders(held)).toEqual([]);
      await expectStillBlocked(app, database, sessions);
    });
  });

  it('counts overlapping wrong-password completions without losing the tenth failure', async () => {
    await withApp(async (app, database) => {
      await injectRegister(app, { email: EMAIL, password: PASSWORD });
      await failLogins(app, 9);
      const sessions = snapshotAuthState(database).sessions;
      const first = await holdLogin(app, { email: LOGIN_EMAIL, password: WRONG_PASSWORD });
      const second = await holdLogin(app, { email: LOGIN_EMAIL, password: WRONG_PASSWORD });
      try {
        first.release();
        const firstResult = await first.pending;
        expect(firstResult.statusCode).toBe(401);
        expect(firstResult.json()).toEqual(UNAUTHORIZED);
        second.release();
        const secondResult = await second.pending;
        expect(secondResult.statusCode).toBe(429);
        expect(secondResult.json()).toEqual(TOO_MANY_REQUESTS);
        expect(cookieHeaders(secondResult)).toEqual([]);
      } finally {
        first.release();
        second.release();
        await Promise.allSettled([first.pending, second.pending]);
      }
      await expectStillBlocked(app, database, sessions);
    });
  });

  it('rejects a blocked pair before password derivation', async () => {
    await withApp(async (app, database) => {
      await injectRegister(app, { email: EMAIL, password: PASSWORD });
      await failLogins(app, 10);
      const sessions = snapshotAuthState(database).sessions;
      const barrier = createBarrier();
      cryptoBarrier.queue.push(barrier);
      const pending = injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
      try {
        await Promise.race([
          pending.then((response) => {
            expect(response.statusCode).toBe(429);
          }),
          barrier.derived.then(() => {
            throw new Error('blocked login reached password derivation');
          }),
        ]);
        const blocked = await pending;
        expect(blocked.json()).toEqual(TOO_MANY_REQUESTS);
        expect(cookieHeaders(blocked)).toEqual([]);
        expect(snapshotAuthState(database).sessions).toEqual(sessions);
      } finally {
        discardBarrier(barrier);
        await Promise.allSettled([pending]);
      }
    });
  });
});

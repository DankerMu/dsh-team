import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  jsonRequestHeaders,
  sessionCookieToken,
  withApp,
} from '../../test/auth-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';

const URL = '/_platform/api/session';
const PASSWORD = 'session-route-password';
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FAILURE = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};

async function signIn(app: FastifyInstance, email: string): Promise<string> {
  const registered = await injectRegister(app, { email, password: PASSWORD });
  expect(registered.statusCode).toBe(201);
  return sessionCookieToken(cookieHeaders(registered));
}

function read(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'GET',
    url: URL,
    headers: token === undefined ? {} : { cookie: `platform_session=${token}` },
  });
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

it.each([
  ['employee', false],
  ['admin', true],
] as const)('returns exactly the canonical email and %s role', async (role, promote) => {
  await withApp(async (app, database) => {
    const token = await signIn(app, ' Person@Example.COM ');
    if (promote) database.prepare("UPDATE users SET role = 'admin'").run();

    const response = await read(app, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ email: 'person@example.com', role });
    expect(Object.keys(response.json<object>())).toEqual(['email', 'role']);
    expect(response.body).not.toContain(token);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

it('reflects a demotion on the next read of the same session', async () => {
  await withApp(async (app, database) => {
    const token = await signIn(app, 'demoted@example.com');
    database.prepare("UPDATE users SET role = 'admin'").run();
    expect((await read(app, token)).json()).toEqual({
      email: 'demoted@example.com',
      role: 'admin',
    });

    database.prepare("UPDATE users SET role = 'employee'").run();

    expect((await read(app, token)).json()).toEqual({
      email: 'demoted@example.com',
      role: 'employee',
    });
  });
});

it.each<[string, (app: FastifyInstance, database: DatabaseHandle, token: string) => unknown]>([
  ['an anonymous request', () => undefined],
  ['an unknown token', () => 'f'.repeat(64)],
  ['a malformed token', () => 'not-a-token'],
  [
    'a disabled account',
    (_app, database, token) => {
      database.prepare("UPDATE users SET status = 'disabled'").run();
      return token;
    },
  ],
  [
    'an expired session',
    (_app, database, token) => {
      database
        .prepare('UPDATE platform_sessions SET last_activity_at = ? WHERE token_hash = ?')
        .run(Date.now() - 7 * 86_400_000 - 1000, digest(token));
      return token;
    },
  ],
  [
    'a logged-out session',
    async (app, _database, token) => {
      const logout = await app.inject({
        method: 'POST',
        url: '/_platform/api/logout',
        headers: jsonRequestHeaders({ cookie: `platform_session=${token}` }),
        payload: '{}',
      });
      expect(logout.statusCode).toBe(204);
      return token;
    },
  ],
])('answers a sanitized 401 for %s', async (_name, prepare) => {
  await withApp(async (app, database, lines) => {
    const token = await signIn(app, 'rejected@example.com');
    const presented = await prepare(app, database, token);

    const response = await read(app, typeof presented === 'string' ? presented : undefined);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual(UNAUTHORIZED);
    expect(response.body + lines.join('')).not.toContain(token);
  });
});

it('renews activity at admission like the other current-session routes', async () => {
  await withApp(async (app, database) => {
    const login = await signIn(app, 'renewed@example.com');
    const stale = Date.now() - 120_000;
    database
      .prepare('UPDATE platform_sessions SET last_activity_at = ? WHERE token_hash = ?')
      .run(stale, digest(login));

    expect((await read(app, login)).statusCode).toBe(200);

    const row = database
      .prepare<[string], { last_activity_at: number }>(
        'SELECT last_activity_at FROM platform_sessions WHERE token_hash = ?',
      )
      .get(digest(login));
    expect(row?.last_activity_at).toBeGreaterThan(stale);
  });
});

it.each([
  ['admission', 0],
  ['the handler recheck', 1],
])('answers a sanitized 500 with fixed logging when storage fails at %s', async (_name, calls) => {
  await withApp(async (app, database, lines) => {
    const token = await signIn(app, 'storage@example.com');
    const original = database.prepare.bind(database);
    let lookups = 0;
    vi.spyOn(database, 'prepare').mockImplementation((source: string) => {
      if (source.includes('FROM platform_sessions') && lookups++ >= calls)
        throw new Error('private storage detail');
      return original(source);
    });

    const response = await read(app, token);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toStrictEqual(FAILURE);
    const log = lines.join('');
    expect(log).toContain('Session lookup storage failure');
    expect(log).not.toContain('private storage detail');
    expect(log).not.toContain(token);
  });
});

it('answers 401 when the session is revoked between admission and the handler recheck', async () => {
  await withApp(async (app, database) => {
    const token = await signIn(app, 'revoked@example.com');
    const original = database.prepare.bind(database);
    let lookups = 0;
    vi.spyOn(database, 'prepare').mockImplementation((source: string) => {
      const statement = original(source);
      if (source.includes('FROM platform_sessions') && lookups++ === 1)
        database.prepare('DELETE FROM platform_sessions').run();
      return statement;
    });

    const response = await read(app, token);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual(UNAUTHORIZED);
  });
});

it('declares the read-only route and its response schema in the contract', async () => {
  await withApp(async (app) => {
    await app.ready();

    const operation = app.swagger().paths?.[URL];

    expect(Object.keys(operation ?? {})).toEqual(['get']);
    expect(JSON.stringify(operation?.get?.responses['200'])).toContain('"admin","employee"');
  });
});

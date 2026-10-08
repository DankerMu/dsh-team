import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { queryAuditEvents } from '../src/audit/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { validateSession, verifyPassword } from '../src/auth/index.ts';
import { tableCounts } from './auth-fixture.ts';

const PASSWORD = 'passw0rd';
const ASTRAL = '😀';
const TOKEN_VALUE = /^platform_session=([0-9a-f]{64})/;
const SELECT_USERS = 'SELECT id, email, password_hash, role, status FROM users';
const SELECT_USER_BY_ID = `${SELECT_USERS} WHERE id = ?`;
const SELECT_SESSIONS = 'SELECT token_hash, user_id FROM platform_sessions';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
}

const CONFIG = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  dataDir: './data',
  managedConfigDir: './data/managed-config',
  dockerSocketPath: '/var/run/docker.sock',
  userImage: 'dsh-team-user:local',
  seccompProfilePath: '/unused/seccomp.json',
  publicUrl: 'http://127.0.0.1',
  authority: '127.0.0.1',
  cookieSecure: false,
  trustedProxies: [],
} as const;

function cookieToken(setCookie: readonly string[]): string {
  const header = setCookie.find((value) => value.startsWith('platform_session='));
  const token = header === undefined ? undefined : TOKEN_VALUE.exec(header)?.[1];
  if (token === undefined) {
    throw new Error('expected platform_session cookie token');
  }
  return token;
}

describe('POST /_platform/api/register over a real TCP port', () => {
  let baseUrl = '';
  let database: DatabaseHandle;
  let close: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    database = openDatabase(':memory:');
    let app: FastifyInstance | undefined;
    try {
      applyMigrations(database);
      app = await buildApp(CONFIG, database);
      await app.listen({ host: '127.0.0.1', port: 0 });
    } catch (error) {
      if (app === undefined) {
        database.close();
      } else {
        await app.close();
      }
      throw error;
    }
    const started = app;
    const address = started.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    close = () => started.close();
  });

  afterAll(async () => {
    await close();
  });

  async function postRegister(body: string): Promise<Response> {
    return fetch(`${baseUrl}/_platform/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CONFIG.publicUrl },
      body,
    });
  }

  it('registers an employee, ignores a supplied admin role, and stores no plaintext password', async () => {
    const before = tableCounts(database);
    const response = await postRegister(
      JSON.stringify({ email: '  First@Example.com  ', password: PASSWORD, role: 'admin' }),
    );
    const body: unknown = await response.json();
    const cookies = response.headers.getSetCookie();
    const token = cookieToken(cookies);
    const users = database.prepare<[], UserRow>(SELECT_USERS).all();
    const user = users.find((row) => row.email === 'first@example.com');
    if (user === undefined || typeof body !== 'object' || body === null) {
      throw new Error('expected registered employee');
    }
    const stored = JSON.stringify({
      users: database.prepare(SELECT_USERS).all(),
      sessions: database.prepare(SELECT_SESSIONS).all(),
      audit: queryAuditEvents(database, { page: 1, pageSize: 50 }),
    });

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: user.id, email: 'first@example.com', role: 'employee' });
    expect(user.role).toBe('employee');
    expect(user.status).toBe('active');
    expect(await verifyPassword(PASSWORD, user.password_hash)).toBe(true);
    expect(validateSession(database, token, Date.now())).toBe(user.id);
    expect(
      cookies.some((header) => header.includes('HttpOnly') && header.includes('SameSite=Lax')),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(token);
    expect(tableCounts(database)).toEqual({
      users: before.users + 1,
      sessions: before.sessions + 1,
      audits: before.audits + 1,
    });
  });

  it('rejects a mixed-case spaced duplicate of an already registered email', async () => {
    const seed = await postRegister(
      JSON.stringify({ email: 'User@Example.com', password: PASSWORD }),
    );
    expect(seed.status).toBe(201);
    const before = tableCounts(database);

    const response = await postRegister(
      JSON.stringify({ email: '  user@example.com  ', password: PASSWORD }),
    );
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Email already registered',
    });
    expect(cookies).toEqual([]);
    expect(tableCounts(database)).toEqual(before);
  });

  it('rejects an email that is missing @ or has an empty domain without creating an account', async () => {
    const before = tableCounts(database);
    const missingAt = await postRegister(
      JSON.stringify({ email: 'not-an-email', password: PASSWORD }),
    );
    const emptyDomain = await postRegister(JSON.stringify({ email: 'user@', password: PASSWORD }));

    expect(missingAt.status).toBe(400);
    expect(emptyDomain.status).toBe(400);
    expect(missingAt.headers.getSetCookie()).toEqual([]);
    expect(emptyDomain.headers.getSetCookie()).toEqual([]);
    expect(tableCounts(database)).toEqual(before);
  });

  it('rejects 5- and 257-character ASCII and Unicode passwords and accepts 6 and 256', async () => {
    const before = tableCounts(database);
    const tooShortAscii = await postRegister(
      JSON.stringify({ email: 'p5@example.com', password: '12345' }),
    );
    const tooLongAscii = await postRegister(
      JSON.stringify({ email: 'p257@example.com', password: 'z'.repeat(257) }),
    );
    const tooShortUnicode = await postRegister(
      JSON.stringify({ email: 'u5@example.com', password: ASTRAL.repeat(5) }),
    );
    const tooLongUnicode = await postRegister(
      JSON.stringify({ email: 'u257@example.com', password: ASTRAL.repeat(257) }),
    );
    const accepted = [
      { email: 'p6@example.com', password: '123456' },
      { email: 'p256@example.com', password: 'z'.repeat(256) },
      { email: 'u6@example.com', password: ASTRAL.repeat(6) },
      { email: 'u256@example.com', password: ASTRAL.repeat(256) },
    ] as const;
    const acceptedResponses = [];
    for (const { email, password } of accepted) {
      acceptedResponses.push({
        email,
        password,
        response: await postRegister(JSON.stringify({ email, password })),
      });
    }
    let twoFiftySixAstralPassword: string | undefined;
    let twoFiftySixAstralHash: string | undefined;

    expect(tooShortAscii.status).toBe(400);
    expect(tooLongAscii.status).toBe(400);
    expect(tooShortUnicode.status).toBe(400);
    expect(tooLongUnicode.status).toBe(400);
    for (const { email, password, response } of acceptedResponses) {
      expect(response.status).toBe(201);
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('id' in body) ||
        !('email' in body) ||
        typeof body.id !== 'string' ||
        typeof body.email !== 'string'
      ) {
        throw new Error(`expected registered employee for ${email}`);
      }
      expect(body.email).toBe(email);
      const user = database.prepare<[string], UserRow>(SELECT_USER_BY_ID).get(body.id);
      if (user === undefined) {
        throw new Error(`expected stored user ${body.id}`);
      }
      expect(user.email).toBe(email);
      expect(await verifyPassword(password, user.password_hash)).toBe(true);
      const token = cookieToken(response.headers.getSetCookie());
      expect(validateSession(database, token, Date.now())).toBe(body.id);
      if (email === 'u256@example.com') {
        twoFiftySixAstralPassword = password;
        twoFiftySixAstralHash = user.password_hash;
      }
    }
    if (twoFiftySixAstralPassword === undefined || twoFiftySixAstralHash === undefined) {
      throw new Error('expected stored 256-astral password hash');
    }
    expect(
      await verifyPassword(twoFiftySixAstralPassword.slice(0, 256), twoFiftySixAstralHash),
    ).toBe(false);
    expect(tableCounts(database)).toEqual({
      users: before.users + 4,
      sessions: before.sessions + 4,
      audits: before.audits + 4,
    });
  });

  it('rejects numeric, array, and null credential types as 400 without creating rows', async () => {
    const before = tableCounts(database);
    const numericEmail = await postRegister('{"email":123,"password":"passw0rd"}');
    const numericPassword = await postRegister('{"email":"num@example.com","password":123456}');
    const arrayEmail = await postRegister('{"email":["a@b.com"],"password":"passw0rd"}');
    const nullPassword = await postRegister('{"email":"null@example.com","password":null}');

    expect(numericEmail.status).toBe(400);
    expect(numericPassword.status).toBe(400);
    expect(arrayEmail.status).toBe(400);
    expect(nullPassword.status).toBe(400);
    expect(numericEmail.headers.getSetCookie()).toEqual([]);
    expect(tableCounts(database)).toEqual(before);
  });
});

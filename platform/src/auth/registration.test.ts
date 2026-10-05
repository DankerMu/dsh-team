import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/registration-fixture.ts';
import { buildApp } from '../app.ts';
import { queryAuditEvents } from '../audit/index.ts';
import { openDatabase } from '../db/index.ts';
import { validateSession, verifyPassword } from './index.ts';

const EMAIL = '  User@Example.com  ';
const NORMALIZED = 'user@example.com';
const PASSWORD = 'passw0rd';
const USER_ID = /^[a-z0-9]{12}$/;
const TOKEN_VALUE = /^platform_session=([0-9a-f]{64})/;
const SELECT_USERS = 'SELECT id, email, password_hash, role, status FROM users';
const SELECT_SESSIONS = 'SELECT token_hash, user_id FROM platform_sessions';
const SESSION_ABORT = 'session-write-aborted';
const AUDIT_ABORT = 'audit-write-aborted';
const CONSTRUCTION_CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'silent',
  dataDir: './data',
  publicUrl: 'http://127.0.0.1:8080',
  authority: '127.0.0.1:8080',
  cookieSecure: false,
  trustedProxies: [],
} as const;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
}
interface SessionRow {
  token_hash: string;
  user_id: string;
}
interface PublicUser {
  id: string;
  email: string;
  role: string;
}

function isPublicUser(value: unknown): value is PublicUser {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('id' in value) || !('email' in value) || !('role' in value)) {
    return false;
  }
  return (
    Object.keys(value).length === 3 &&
    typeof value.id === 'string' &&
    typeof value.email === 'string' &&
    typeof value.role === 'string'
  );
}

describe('POST /_platform/api/register', () => {
  it('creates an active employee with a platform session from a mixed-case spaced email', async () => {
    await withApp(async (app, database, lines) => {
      const response = await injectRegister(app, {
        email: EMAIL,
        password: PASSWORD,
        role: 'admin',
      });
      expect(response.statusCode).toBe(201);
      // JSON.parse is typed as any; the HTTP body is JSON text.
      const parsed = JSON.parse(response.body) as unknown;
      if (!isPublicUser(parsed)) {
        throw new Error('expected public registration body');
      }
      const cookies = cookieHeaders(response);
      expect(cookies).toHaveLength(1);
      const header = cookies[0];
      if (typeof header !== 'string' || !header.startsWith('platform_session=')) {
        throw new Error('expected platform_session cookie');
      }
      const token = TOKEN_VALUE.exec(header)?.[1];
      if (token === undefined) {
        throw new Error('expected platform_session token');
      }
      const users = database.prepare<[], UserRow>(SELECT_USERS).all();
      const sessions = database.prepare<[], SessionRow>(SELECT_SESSIONS).all();
      const events = queryAuditEvents(database, {
        page: 1,
        pageSize: 10,
        eventType: 'account.registered',
      });
      const user = users[0];
      const session = sessions[0];
      const event = events[0];
      if (user === undefined || session === undefined || event === undefined) {
        throw new Error('expected user, platform session, and account.registered rows');
      }
      const digest = createHash('sha256').update(token).digest('hex');
      expect(parsed.id).toMatch(USER_ID);
      expect(parsed).toEqual({
        id: parsed.id,
        email: NORMALIZED,
        role: 'employee',
      });
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header).not.toContain('Secure');
      expect(users).toHaveLength(1);
      expect(user).toMatchObject({
        id: parsed.id,
        email: NORMALIZED,
        role: 'employee',
        status: 'active',
      });
      expect(await verifyPassword(PASSWORD, user.password_hash)).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(session).toEqual({ token_hash: digest, user_id: parsed.id });
      expect(JSON.stringify(sessions)).not.toContain(token);
      expect(validateSession(database, token, Date.now())).toBe(parsed.id);
      expect(validateSession(database, session.token_hash, Date.now())).toBeNull();
      expect(events).toHaveLength(1);
      expect(event).toMatchObject({
        type: 'account.registered',
        actorEmail: NORMALIZED,
        targetEmail: NORMALIZED,
        target: parsed.id,
        sourceAddress: SOURCE,
        details: {},
      });
      expect(lines.length).toBeGreaterThan(0);
      for (const secret of [PASSWORD, user.password_hash, token]) {
        expect(response.body).not.toContain(secret);
        expect(lines.join('')).not.toContain(secret);
      }
    });
  });

  it('sets Secure on the platform session cookie when cookieSecure is true', async () => {
    await withApp(async (app) => {
      const response = await injectRegister(app, {
        email: 'secure@example.com',
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(201);
      const cookies = cookieHeaders(response);
      expect(cookies).toHaveLength(1);
      const header = cookies[0];
      if (typeof header !== 'string') {
        throw new Error('expected platform_session cookie');
      }
      expect(header).toContain('Secure');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
    }, true);
  });

  it('accepts a concurrent duplicate of a mixed-case spaced email as one 201 and one 409', async () => {
    await withApp(async (app, database) => {
      const [first, second] = await Promise.all([
        injectRegister(app, { email: '  Dup@Example.com  ', password: PASSWORD }),
        injectRegister(app, { email: 'dup@example.com', password: PASSWORD }),
      ]);
      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([201, 409]);
      const created = first.statusCode === 201 ? first : second;
      const conflict = first.statusCode === 409 ? first : second;
      expect(cookieHeaders(conflict)).toEqual([]);
      expect(cookieHeaders(created)).toHaveLength(1);
      expect(conflict.json()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'Email already registered',
      });
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 1 });
      const users = database.prepare<[], UserRow>(SELECT_USERS).all();
      expect(users).toEqual([
        expect.objectContaining({ email: 'dup@example.com', role: 'employee', status: 'active' }),
      ]);
    });
  });

  it.each([
    ['session INSERT', SESSION_ABORT, 'platform_sessions'],
    ['audit INSERT', AUDIT_ABORT, 'audit_events'],
  ] as const)(
    'rolls back all three writes when %s aborts, returns 500 not 409, and sets no cookie',
    async (_label, abortMessage, table) => {
      await withApp(async (app, database, lines) => {
        database.exec(
          `CREATE TEMP TRIGGER abort_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${abortMessage}'); END`,
        );
        const response = await injectRegister(app, {
          email: 'abort@example.com',
          password: PASSWORD,
        });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: abortMessage,
        });
        expect(response.statusCode).not.toBe(409);
        expect(cookieHeaders(response)).toEqual([]);
        expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
        expect(`${response.body}${lines.join('')}`).not.toContain(PASSWORD);
      });
    },
  );
});

describe('registration plugin construction', () => {
  it('rejects buildApp when users is missing without closing the caller-owned database', async () => {
    const database = openDatabase(':memory:');

    try {
      await expect(buildApp(CONSTRUCTION_CONFIG, database)).rejects.toMatchObject({
        code: 'SQLITE_ERROR',
        message: 'no such table: users',
      });

      expect(database.open).toBe(true);
      expect(database.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
      database.close();
    }
  });
});

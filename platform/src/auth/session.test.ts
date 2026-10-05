import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createSession, deleteUserSessions, hashPassword, validateSession } from './index.ts';
import { getSessionUser } from './session.ts';

const USER_ID = 'abcdefghijkl';
const OTHER_USER_ID = 'mnopqrstuvwx';
const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const DAY_6 = NOW + 6 * DAY_MS;
const DAY_12 = NOW + 12 * DAY_MS;
const EXACT_SEVEN_DAYS = NOW + SEVEN_DAYS_MS;
const SEVEN_DAYS_PLUS_ONE_MS = EXACT_SEVEN_DAYS + 1;
const THROTTLE_MS = 60_000;
const UNDER_THROTTLE = NOW + THROTTLE_MS - 1;
const AT_THROTTLE = NOW + THROTTLE_MS;
const BACKWARD_CLOCK = NOW - 1;
const SELECT_SESSIONS =
  'SELECT token_hash, user_id, created_at, last_activity_at FROM platform_sessions ORDER BY token_hash';
const INSERT_USER =
  'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)';
const UPDATE_STATUS = "UPDATE users SET status = 'disabled' WHERE email = ?";
const SELECT_USER = 'SELECT id, email, role, status FROM users WHERE id = ?';
const TOKEN_HEX = /^[0-9a-f]{64}$/;
const UNKNOWN_TOKEN = 'a'.repeat(64);
const WRITE_ABORT = 'session-write-aborted';
const MALFORMED_TOKENS = [
  ['empty', ''],
  ['short', 'a'.repeat(63)],
  ['uppercase', 'A'.repeat(64)],
  ['nonhex', `${'a'.repeat(63)}g`],
  ['trailing newline', `${'a'.repeat(64)}\n`],
] as const;

interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  last_activity_at: number;
}
interface PublicIdentity {
  id: string;
  email: string;
  role: string;
}

interface UserIdentityRow {
  id: string;
  email: string;
  role: string;
  status: string;
}

function expectedRow(
  token: string,
  userId: string,
  createdAt: number,
  lastActivityAt: number,
): SessionRow {
  return {
    token_hash: createHash('sha256').update(token).digest('hex'),
    user_id: userId,
    created_at: createdAt,
    last_activity_at: lastActivityAt,
  };
}

function withDatabase(run: (db: DatabaseHandle) => void): void {
  const db = openDatabase(':memory:');
  try {
    applyMigrations(db);
    db.prepare(INSERT_USER).run(
      USER_ID,
      'user@example.com',
      passwordHash,
      'employee',
      'active',
      NOW,
    );
    run(db);
  } finally {
    db.close();
  }
}

function thrownError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the session call to throw');
}

let passwordHash: string;
let otherPasswordHash: string;

describe('createSession, validateSession, and deleteUserSessions', () => {
  beforeAll(async () => {
    passwordHash = await hashPassword('passw0rd');
    otherPasswordHash = await hashPassword('s3cret');
  });

  it('stores only the SHA-256 of a usable token and rejects presenting the stored digest', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      const rows = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();
      const stored = rows[0];
      if (stored === undefined) {
        throw new Error('expected one platform session row');
      }

      expect(token).toMatch(TOKEN_HEX);
      expect(rows).toEqual([expectedRow(token, USER_ID, NOW, NOW)]);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(validateSession(db, token, NOW)).toBe(USER_ID);
      expect(validateSession(db, stored.token_hash, NOW)).toBeNull();
    });
  });

  it('keeps a session valid on day 6 and records that activity so day 12 still authenticates', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);

      expect(validateSession(db, token, DAY_6)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual([
        expectedRow(token, USER_ID, NOW, DAY_6),
      ]);
      expect(validateSession(db, token, DAY_12)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual([
        expectedRow(token, USER_ID, NOW, DAY_12),
      ]);
    });
  });

  it('treats exact seven days from last persisted activity as valid and renews last_activity_at', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);

      expect(validateSession(db, token, EXACT_SEVEN_DAYS)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual([
        expectedRow(token, USER_ID, NOW, EXACT_SEVEN_DAYS),
      ]);
    });
  });

  it('rejects activity one millisecond past seven days on a separate baseline and does not renew the expired row', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      expect(validateSession(db, token, SEVEN_DAYS_PLUS_ONE_MS)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
      expect(validateSession(db, token, SEVEN_DAYS_PLUS_ONE_MS + THROTTLE_MS)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
    });
  });

  it('does not rewrite last_activity_at 59,999ms after the last persisted activity', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      expect(validateSession(db, token, UNDER_THROTTLE)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
    });
  });

  it('updates last_activity_at after 60,000ms of persisted activity', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);

      expect(validateSession(db, token, AT_THROTTLE)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual([
        expectedRow(token, USER_ID, NOW, AT_THROTTLE),
      ]);
    });
  });

  it('does not rewrite last_activity_at when the clock moves backward', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      expect(validateSession(db, token, BACKWARD_CLOCK)).toBe(USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
    });
  });

  it('revokes every session for one user and leaves another user authenticated', () => {
    withDatabase((db) => {
      db.prepare(INSERT_USER).run(
        OTHER_USER_ID,
        'admin@example.com',
        otherPasswordHash,
        'admin',
        'active',
        NOW,
      );
      const first = createSession(db, USER_ID, NOW);
      const second = createSession(db, USER_ID, NOW + 1);
      const other = createSession(db, OTHER_USER_ID, NOW + 2);

      expect(first).not.toBe(second);
      expect(validateSession(db, first, NOW)).toBe(USER_ID);
      expect(validateSession(db, second, NOW + 1)).toBe(USER_ID);
      expect(validateSession(db, other, NOW + 2)).toBe(OTHER_USER_ID);

      deleteUserSessions(db, USER_ID);

      expect(validateSession(db, first, NOW)).toBeNull();
      expect(validateSession(db, second, NOW + 1)).toBeNull();
      expect(validateSession(db, other, NOW + 2)).toBe(OTHER_USER_ID);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual([
        expectedRow(other, OTHER_USER_ID, NOW + 2, NOW + 2),
      ]);
      expect(JSON.stringify(db.prepare<[], SessionRow>(SELECT_SESSIONS).all())).not.toContain(
        other,
      );
    });
  });

  it.each(MALFORMED_TOKENS)(
    'returns null for a malformed %s token without mutating stored sessions',
    (_label, token) => {
      withDatabase((db) => {
        const issuedToken = createSession(db, USER_ID, NOW);
        const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

        expect(validateSession(db, token, NOW)).toBeNull();
        expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
        expect(validateSession(db, issuedToken, NOW)).toBe(USER_ID);
      });
    },
  );

  it('returns null for an unknown well-formed token without mutating stored sessions', () => {
    withDatabase((db) => {
      const issuedToken = createSession(db, USER_ID, NOW);
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      expect(UNKNOWN_TOKEN).toMatch(TOKEN_HEX);
      expect(validateSession(db, UNKNOWN_TOKEN, NOW)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
      expect(validateSession(db, issuedToken, NOW)).toBe(USER_ID);
    });
  });

  it('propagates a database write failure and leaves caller transaction rollback usable', () => {
    withDatabase((db) => {
      db.exec(
        `CREATE TEMP TRIGGER abort_session BEFORE UPDATE ON platform_sessions BEGIN SELECT RAISE(ABORT, '${WRITE_ABORT}'); END`,
      );
      const token = createSession(db, USER_ID, NOW);
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      db.exec('BEGIN');
      expect(db.inTransaction).toBe(true);
      expect(thrownError(() => validateSession(db, token, AT_THROTTLE)).message).toContain(
        WRITE_ABORT,
      );
      expect(db.inTransaction).toBe(true);
      db.exec('ROLLBACK');

      expect(db.inTransaction).toBe(false);
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
      expect(validateSession(db, token, NOW)).toBe(USER_ID);
    });
  });

  it('returns null for a retained inactive-user session at the renewal threshold without rewriting the row', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      db.prepare(UPDATE_STATUS).run('user@example.com');
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();
      const user = db.prepare<[string], UserIdentityRow>(SELECT_USER).get(USER_ID);
      if (user === undefined) {
        throw new Error('expected seeded user');
      }

      expect(user.status).toBe('disabled');
      expect(issued).toEqual([expectedRow(token, USER_ID, NOW, NOW)]);
      expect(validateSession(db, token, AT_THROTTLE)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
    });
  });
});

describe('getSessionUser', () => {
  it('returns only public identity for an active account and never password hash or token', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      const identity = getSessionUser(db, token, NOW);

      expect(identity).toEqual({
        id: USER_ID,
        email: 'user@example.com',
        role: 'employee',
      } satisfies PublicIdentity);
      expect(identity).not.toBeNull();
      if (identity === null) {
        throw new Error('expected active session identity');
      }
      expect(Object.keys(identity).sort()).toEqual(['email', 'id', 'role']);
      expect(JSON.stringify(identity)).not.toContain(token);
      expect(JSON.stringify(identity)).not.toContain(passwordHash);
    });
  });

  it('returns null for a disabled account before rewriting last_activity_at', () => {
    withDatabase((db) => {
      const token = createSession(db, USER_ID, NOW);
      db.prepare(UPDATE_STATUS).run('user@example.com');
      const issued = db.prepare<[], SessionRow>(SELECT_SESSIONS).all();

      expect(getSessionUser(db, token, AT_THROTTLE)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
      expect(validateSession(db, token, AT_THROTTLE)).toBeNull();
      expect(db.prepare<[], SessionRow>(SELECT_SESSIONS).all()).toEqual(issued);
    });
  });
});

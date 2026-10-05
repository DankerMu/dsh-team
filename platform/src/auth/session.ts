import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseHandle } from '../db/index.ts';

const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const TOKEN_HEX = /^[0-9a-f]{64}$/;
const SESSION_TTL_MS = 7 * 86_400_000;
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;
const INSERT_SESSION =
  'INSERT INTO platform_sessions (token_hash, user_id, created_at, last_activity_at) VALUES (?, ?, ?, ?)';
const SELECT_ACTIVE_SESSION =
  "SELECT u.id AS id, u.email AS email, u.role AS role, s.last_activity_at AS last_activity_at FROM platform_sessions AS s INNER JOIN users AS u ON u.id = s.user_id WHERE s.token_hash = ? AND u.status = 'active'";
const UPDATE_SESSION_ACTIVITY =
  'UPDATE platform_sessions SET last_activity_at = ? WHERE token_hash = ?';
const DELETE_USER_SESSIONS = 'DELETE FROM platform_sessions WHERE user_id = ?';
const DELETE_SESSION = 'DELETE FROM platform_sessions WHERE token_hash = ?';

interface ActiveSessionRow {
  id: string;
  email: string;
  role: 'admin' | 'employee';
  last_activity_at: number;
}

function lookupValidSession(
  db: DatabaseHandle,
  token: string,
  now: number,
): ActiveSessionRow | null {
  if (token.length !== TOKEN_HEX_LENGTH || TOKEN_HEX.exec(token) === null) {
    return null;
  }
  const digest = createHash('sha256').update(token).digest('hex');
  const row = db.prepare<[string], ActiveSessionRow>(SELECT_ACTIVE_SESSION).get(digest);
  if (row === undefined) {
    return null;
  }
  const elapsed = now - row.last_activity_at;
  if (elapsed > SESSION_TTL_MS) {
    return null;
  }
  if (elapsed >= ACTIVITY_WRITE_INTERVAL_MS) {
    db.prepare(UPDATE_SESSION_ACTIVITY).run(now, digest);
  }
  return row;
}

export function createSession(db: DatabaseHandle, userId: string, now: number): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  db.prepare(INSERT_SESSION).run(
    createHash('sha256').update(token).digest('hex'),
    userId,
    now,
    now,
  );
  return token;
}

export function validateSession(db: DatabaseHandle, token: string, now: number): string | null {
  return lookupValidSession(db, token, now)?.id ?? null;
}

export function getSessionUser(
  db: DatabaseHandle,
  token: string,
  now: number,
): { id: string; email: string; role: 'admin' | 'employee' } | null {
  const row = lookupValidSession(db, token, now);
  if (row === null) {
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

export function deleteUserSessions(db: DatabaseHandle, userId: string): void {
  db.prepare(DELETE_USER_SESSIONS).run(userId);
}

export function deleteSession(db: DatabaseHandle, token: string): void {
  db.prepare(DELETE_SESSION).run(createHash('sha256').update(token).digest('hex'));
}

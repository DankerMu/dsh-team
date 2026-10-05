import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseHandle } from '../db/index.ts';

const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const TOKEN_HEX = /^[0-9a-f]{64}$/;
const SESSION_TTL_MS = 7 * 86_400_000;
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;
const INSERT_SESSION =
  'INSERT INTO platform_sessions (token_hash, user_id, created_at, last_activity_at) VALUES (?, ?, ?, ?)';
const SELECT_SESSION_USER =
  'SELECT user_id, last_activity_at FROM platform_sessions WHERE token_hash = ?';
const UPDATE_SESSION_ACTIVITY =
  'UPDATE platform_sessions SET last_activity_at = ? WHERE token_hash = ?';
const DELETE_USER_SESSIONS = 'DELETE FROM platform_sessions WHERE user_id = ?';

interface SessionUserRow {
  user_id: string;
  last_activity_at: number;
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
  if (token.length !== TOKEN_HEX_LENGTH || TOKEN_HEX.exec(token) === null) {
    return null;
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare<[string], SessionUserRow>(SELECT_SESSION_USER).get(tokenHash);
  if (row === undefined) {
    return null;
  }
  const elapsed = now - row.last_activity_at;
  if (elapsed > SESSION_TTL_MS) {
    return null;
  }
  if (elapsed >= ACTIVITY_WRITE_INTERVAL_MS) {
    db.prepare(UPDATE_SESSION_ACTIVITY).run(now, tokenHash);
  }
  return row.user_id;
}

export function deleteUserSessions(db: DatabaseHandle, userId: string): void {
  db.prepare(DELETE_USER_SESSIONS).run(userId);
}

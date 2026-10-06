import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { generateUserId, normalizeEmail } from './identity.ts';
import { hashPassword } from './password.ts';
import { deleteUserSessions } from './session.ts';

interface AccountSnapshot {
  id: string;
  email: string;
  role: 'employee' | 'admin';
  status: 'active' | 'disabled';
  password_hash: string;
  created_at: number;
}

export type AdministratorResult =
  'created' | 'promoted' | 'reset' | 'promoted-and-reset' | 'unchanged';

export class AdministratorConflictError extends Error {
  constructor() {
    super('Account changed during administrator operation; run the command again');
  }
}

function matchesSnapshot(
  snapshot: AccountSnapshot | undefined,
  current: AccountSnapshot | undefined,
): boolean {
  if (snapshot === undefined || current === undefined) {
    return snapshot === current;
  }
  return (
    current.id === snapshot.id &&
    current.email === snapshot.email &&
    current.role === snapshot.role &&
    current.status === snapshot.status &&
    current.password_hash === snapshot.password_hash &&
    current.created_at === snapshot.created_at
  );
}

/** Owns the pre-prompt snapshot and final atomic mutation; null means no password reset. */
export async function administerAccount(
  database: DatabaseHandle,
  rawEmail: string,
  readPassword: (existing: boolean) => Promise<string | null>,
  signal: AbortSignal,
): Promise<AdministratorResult> {
  const email = normalizeEmail(rawEmail);
  if (email === null) {
    throw new Error('Invalid email');
  }
  signal.throwIfAborted();
  const select = database.prepare<[string], AccountSnapshot>(
    'SELECT id, email, role, status, password_hash, created_at FROM users WHERE email = ?',
  );
  const snapshot = select.get(email);
  const password = await readPassword(snapshot !== undefined);
  signal.throwIfAborted();
  if (snapshot === undefined && password === null) {
    throw new Error('New administrator requires a password');
  }
  const passwordHash = password === null ? null : await hashPassword(password);
  signal.throwIfAborted();

  return database
    .transaction((): AdministratorResult => {
      signal.throwIfAborted();
      const current = select.get(email);
      if (!matchesSnapshot(snapshot, current)) {
        throw new AdministratorConflictError();
      }
      const now = Date.now();
      const id = snapshot?.id ?? generateUserId();
      const audit = (type: string): void => {
        recordAuditEvent(database, { type, createdAt: now, targetEmail: email, target: id });
      };
      if (snapshot === undefined) {
        database
          .prepare(
            "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
          )
          .run(id, email, passwordHash, now);
        audit('admin.created');
        return 'created';
      }
      const promote = snapshot.role !== 'admin';
      if (promote) {
        database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
        audit('admin.promoted');
      }
      if (passwordHash !== null) {
        database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
        deleteUserSessions(database, id);
        audit('password.reset');
        return promote ? 'promoted-and-reset' : 'reset';
      }
      return promote ? 'promoted' : 'unchanged';
    })
    .immediate();
}

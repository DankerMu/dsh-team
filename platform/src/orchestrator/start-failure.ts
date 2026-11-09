import { PROFILE_INCOMPATIBLE, recordAuditEvent } from '../audit/index.ts';
import type { StartUserContainerInput } from './start-identity.ts';

/** The whole last error of a pre-create profile rejection: the closed code line, then fixed text. */
export const PROFILE_INCOMPATIBLE_ERROR = `${PROFILE_INCOMPATIBLE}\nManaged composition rejected: incompatible DSH profile`;

/** The code is the first line of the last error; no other writer's first line equals it. */
export function lastErrorCode(lastError: string | null): typeof PROFILE_INCOMPATIBLE | null {
  return lastError?.split('\n', 1)[0] === PROFILE_INCOMPATIBLE ? PROFILE_INCOMPATIBLE : null;
}

const RECORD_INCOMPATIBLE = `INSERT INTO instances(user_id,status,last_error) VALUES (?, 'error', ?)
  ON CONFLICT(user_id) DO UPDATE SET status='error', last_error=excluded.last_error,
  dsh_cookie=NULL, instance_token_hash=NULL
  WHERE instances.container_id IS NULL AND instances.status IN ('stopped','error')`;

/**
 * Persist a managed-composition profile rejection before any network or container exists.
 * Only the same active account's container-less stopped/error row (or no row) is written;
 * returns whether the row and its coded `instance.start-failed` audit were written.
 */
export function recordProfileIncompatible(
  input: Pick<StartUserContainerInput, 'database' | 'userId'>,
  user: Record<string, unknown>,
): boolean {
  const { database, userId } = input;
  return database.transaction(() => {
    const current = database
      .prepare('SELECT id, email, status FROM users WHERE id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (
      current?.status !== 'active' ||
      current.id !== user.id ||
      typeof current.email !== 'string' ||
      current.email !== user.email
    )
      return false;
    if (database.prepare(RECORD_INCOMPATIBLE).run(userId, PROFILE_INCOMPATIBLE_ERROR).changes !== 1)
      return false;
    recordAuditEvent(database, {
      type: 'instance.start-failed',
      createdAt: Date.now(),
      targetEmail: current.email,
      target: userId,
      details: { code: PROFILE_INCOMPATIBLE },
    });
    return true;
  })();
}

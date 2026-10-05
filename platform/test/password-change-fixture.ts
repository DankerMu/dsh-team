import type { DatabaseHandle } from '../src/db/index.ts';
import { snapshotAuthState } from './auth-fixture.ts';
import { PASSWORD, postJson } from './auth-tcp-fixture.ts';

export const NEW_PASSWORD = ' NewPassW0rd ';
export const BACKDATE_ACTIVITY =
  'UPDATE platform_sessions SET last_activity_at = last_activity_at - 60000';

export interface PasswordStateSnapshot {
  users: unknown[];
  sessions: unknown[];
  audits: unknown[];
}

/** Includes passwords, complete session rows, and audits for rollback and race oracles. */
export function snapshotPasswordState(database: DatabaseHandle): PasswordStateSnapshot {
  return {
    users: database.prepare('SELECT * FROM users ORDER BY id').all(),
    ...snapshotAuthState(database),
  };
}

export function changePassword(
  baseUrl: string,
  cookie: string | undefined,
  currentPassword = PASSWORD,
  newPassword = NEW_PASSWORD,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return postJson(
    `${baseUrl}/_platform/api/change-password`,
    { currentPassword, newPassword },
    { ...(cookie === undefined ? {} : { cookie }), ...extraHeaders },
  );
}

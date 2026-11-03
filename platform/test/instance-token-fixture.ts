import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseHandle } from '../src/db/index.ts';

/** A fresh instance token in the orchestrator's issued form: 32 random bytes as lowercase hex. */
export function instanceToken(): string {
  return randomBytes(32).toString('hex');
}

/** The stored digest, computed here as the orchestrator does rather than through the proxy. */
export function instanceTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface SeededInstance {
  readonly userId: string;
  readonly token: string | null;
  readonly host: string;
  readonly status?: 'running' | 'starting' | 'stopped' | 'error';
  readonly userStatus?: 'active' | 'disabled';
}

/** Writes one employee and its instance row directly, as a started orchestrator leaves them. */
export function seedInstance(database: DatabaseHandle, instance: SeededInstance): void {
  database
    .prepare(
      "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, 'unused', 'employee', ?, 0)",
    )
    .run(instance.userId, `${instance.userId}@example.test`, instance.userStatus ?? 'active');
  database
    .prepare(
      'INSERT INTO instances (user_id, status, upstream_host, upstream_port, instance_token_hash) VALUES (?, ?, ?, 3080, ?)',
    )
    .run(
      instance.userId,
      instance.status ?? 'running',
      instance.host,
      instance.token === null ? null : instanceTokenHash(instance.token),
    );
}

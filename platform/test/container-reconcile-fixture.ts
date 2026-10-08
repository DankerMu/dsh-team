import { expect } from 'vitest';
import type { Orchestrator } from '../src/orchestrator/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { START_CONTAINER, START_IMAGE, START_USER } from './container-start-fixture.ts';
import type { Container, StartupRequest } from './container-start-fixture.ts';

// Released cookie protocol; name independently pinned in credential/readiness acceptance fixtures.
const payload = Buffer.from(
  JSON.stringify({
    version: 1,
    authority: 'team.example:8443',
    issuedAt: 1,
    expiresAt: 8_000_000_000_000,
  }),
).toString('base64url');
export const RECONCILE_COOKIE = `dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64=v1.${payload}.${Buffer.alloc(32, 7).toString('base64url')}`;
export const RECONCILE_LIST = `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['dsh-team.user'] }))}`;

export function seedReconciliation(
  database: DatabaseHandle,
  daemon: { containers: Map<string, Container> },
  user = START_USER,
  id = START_CONTAINER,
): void {
  database
    .prepare("INSERT OR IGNORE INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
    .run(user, `${user}@example.test`);
  database
    .prepare(
      `INSERT INTO instances (user_id, status, container_id, image_id, image_tag,
      upstream_host, upstream_port, dsh_cookie, last_started_at, last_activity_at, last_error)
      VALUES (?, 'running', ?, ?, 'dsh-team-user:local', '127.0.0.1', 49173, ?, 101, 202, 'historical diagnostic')`,
    )
    .run(user, id, START_IMAGE, RECONCILE_COOKIE);
  daemon.containers.set(id, {
    Id: id,
    Name: `/dsh-team-u-${user}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': user } },
    State: { Running: true },
    NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] } },
  });
}

export function reconciliationState(database: DatabaseHandle) {
  return {
    rows: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
    accounts: database.prepare('SELECT * FROM users ORDER BY id').all(),
    audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
  };
}

/** Fail-closed public seam: invalid observations cannot mutate either system boundary. */
export async function expectReconciliationRejected(
  database: DatabaseHandle,
  daemon: { readonly requests: readonly StartupRequest[] },
  owner: Orchestrator,
): Promise<void> {
  const before = reconciliationState(database);

  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(reconciliationState(database)).toEqual(before);
  expect(daemon.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
}

export function stoppedRow(user = START_USER) {
  return {
    user_id: user,
    status: 'stopped',
    container_id: null,
    image_id: null,
    image_tag: null,
    upstream_host: null,
    upstream_port: null,
    dsh_cookie: null,
    last_started_at: 101,
    last_activity_at: 202,
    last_error: 'historical diagnostic',
  };
}

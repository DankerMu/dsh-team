import { expect } from 'vitest';
import type { Orchestrator } from '../src/orchestrator/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { START_CONTAINER, START_IMAGE, START_USER } from './container-start-fixture.ts';
import type { Container, StartupRequest } from './container-start-fixture.ts';

// Released cookie protocol; name independently pinned in credential/readiness acceptance fixtures.
function reconciliationCookie(expiresAt: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      authority: 'team.example:8443',
      issuedAt: 1,
      expiresAt,
    }),
  ).toString('base64url');
  return `dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64=v1.${payload}.${Buffer.alloc(32, 7).toString('base64url')}`;
}
export const RECONCILE_COOKIE = reconciliationCookie(8_000_000_000_000);
const RECONCILE_EXPIRED_COOKIE = reconciliationCookie(2);
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

export function expireReconciliation(
  database: DatabaseHandle,
  daemon: { containers: Map<string, Container> },
  state: string,
): void {
  database.prepare('UPDATE instances SET dsh_cookie = ?').run(RECONCILE_EXPIRED_COOKIE);
  if (state === 'missing') daemon.containers.clear();
  if (state === 'stopped') {
    const container = daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Missing fixture');
    container.State.Running = false;
  }
  if (state === 'disabled') database.exec("UPDATE users SET status = 'disabled'");
}

export function expectReconciliationRetired(
  database: DatabaseHandle,
  daemon: {
    readonly containers: ReadonlyMap<string, Container>;
    readonly requests: readonly StartupRequest[];
  },
): void {
  const state = reconciliationState(database);
  expect(state.rows).toEqual([stoppedRow()]);
  expect(state.audits).toEqual([
    expect.objectContaining({
      event_type: 'instance.stopped',
      target: START_USER,
      details: '{"reason":"error"}',
    }),
  ]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.requests.filter(({ path }) => path.includes('/volumes'))).toEqual([]);
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

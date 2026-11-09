import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  lastErrorCode,
  PROFILE_INCOMPATIBLE_ERROR,
  recordProfileIncompatible,
} from './start-failure.ts';

const USER = 'aaaaaaaaaaaa';
const EMAIL = 'employee@example.test';
let database: DatabaseHandle;

beforeEach(() => {
  database = openDatabase(':memory:');
  applyMigrations(database);
  database
    .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
    .run(USER, EMAIL);
});
afterEach(() => {
  database.close();
});

const account = () => database.prepare('SELECT * FROM users WHERE id = ?').get(USER) as object;
const record = (user: object = account()) =>
  recordProfileIncompatible({ database, userId: USER }, user as Record<string, unknown>);
const instance = () =>
  database
    .prepare(
      'SELECT status, container_id, last_error, dsh_cookie, instance_token_hash FROM instances',
    )
    .all();
const audits = () =>
  database.prepare('SELECT event_type, target, target_email, details FROM audit_events').all();

const WRITTEN = {
  status: 'error',
  container_id: null,
  last_error: PROFILE_INCOMPATIBLE_ERROR,
  dsh_cookie: null,
  instance_token_hash: null,
};
const AUDITED = {
  event_type: 'instance.start-failed',
  target: USER,
  target_email: EMAIL,
  details: '{"code":"profile-incompatible"}',
};

it('is the fixed closed code line followed by a fixed explanation without profile content', () => {
  expect(PROFILE_INCOMPATIBLE_ERROR).toBe(
    'profile-incompatible\nManaged composition rejected: incompatible DSH profile',
  );
});

it('creates an error row without a container and its coded audit when no row exists', () => {
  expect(record()).toBe(true);

  expect(instance()).toEqual([WRITTEN]);
  expect(audits()).toEqual([AUDITED]);
});

it.each(['stopped', 'error'])(
  'overwrites a %s row without a container, clearing credentials, in one coded audit',
  (status) => {
    database
      .prepare(
        "INSERT INTO instances(user_id,status,last_error,dsh_cookie,instance_token_hash) VALUES (?,?,'earlier','cookie','hash')",
      )
      .run(USER, status);

    expect(record()).toBe(true);

    expect(instance()).toEqual([WRITTEN]);
    expect(audits()).toEqual([AUDITED]);
  },
);

it.each([
  ['a stopped row that already has a container', 'stopped', 'c'.repeat(64)],
  ['an error row that already has a container', 'error', 'c'.repeat(64)],
  ['a starting row', 'starting', null],
  ['a running row', 'running', null],
])('writes neither row nor audit for %s', (_label, status, container) => {
  database
    .prepare("INSERT INTO instances(user_id,status,container_id,last_error) VALUES (?,?,?,'kept')")
    .run(USER, status, container);
  const before = instance();

  expect(record()).toBe(false);

  expect(instance()).toEqual(before);
  expect(audits()).toEqual([]);
});

it.each([
  ['a changed email', "UPDATE users SET email = 'other@example.test'"],
  ['a disabled account', "UPDATE users SET status = 'disabled'"],
  ['a deleted account', 'DELETE FROM users'],
])('writes neither row nor audit after %s', (_label, change) => {
  const user = account();
  database.prepare(change).run();

  expect(record(user)).toBe(false);

  expect(instance()).toEqual([]);
  expect(audits()).toEqual([]);
});

it('writes neither row nor audit for a snapshot of another account id', () => {
  expect(record({ ...account(), id: 'bbbbbbbbbbbb' })).toBe(false);

  expect(instance()).toEqual([]);
  expect(audits()).toEqual([]);
});

it.each([
  [PROFILE_INCOMPATIBLE_ERROR, 'profile-incompatible'],
  ['profile-incompatible', 'profile-incompatible'],
  ['profile-incompatible\r\nManaged composition rejected', null],
  [' profile-incompatible\nManaged composition rejected', null],
  ['profile-incompatible-extra\nManaged composition rejected', null],
  ['DSH readiness failed; container stopped\nprofile-incompatible', null],
  ['Platform attachment/startup failed; started container and owned network removed', null],
  ['', null],
  [null, null],
] as const)('derives the code from last error %j as %s', (lastError, expected) => {
  expect(lastErrorCode(lastError)).toBe(expected);
});

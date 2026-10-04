import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { applyMigrations, openDatabase } from './index.ts';

const ORIGINAL_USER = {
  id: 'abcdefghijkl',
  email: 'user@example.com',
  password_hash: 'password-hash-placeholder',
  role: 'employee',
  status: 'active',
  created_at: 1_700_000_000_000,
};

const ADMIN_DISABLED_USER = {
  id: 'mnopqrstuvwx',
  email: 'admin@example.com',
  password_hash: 'password-hash-placeholder-admin',
  role: 'admin',
  status: 'disabled',
  created_at: 1_700_000_000_001,
};

const INSERT_USER =
  'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (@id, @email, @password_hash, @role, @status, @created_at)';
const SELECT_USERS = 'SELECT id, email, password_hash, role, status, created_at FROM users';
const INSERT_SESSION =
  'INSERT INTO platform_sessions (token_hash, user_id, created_at, last_activity_at) VALUES (@token_hash, @user_id, @created_at, @last_activity_at)';
const SELECT_SESSIONS =
  'SELECT token_hash, user_id, created_at, last_activity_at FROM platform_sessions ORDER BY token_hash';
const INSERT_INSTANCE = 'INSERT INTO instances (user_id, status) VALUES (?, ?)';
const SELECT_INSTANCE =
  'SELECT user_id, status, container_id, upstream_host, upstream_port, dsh_cookie, image_tag, last_started_at, last_activity_at, last_error FROM instances WHERE user_id = ?';
const INSERT_SETTING = 'INSERT INTO settings (key, value) VALUES (?, ?)';
const SELECT_SETTING = 'SELECT key, value FROM settings WHERE key = ?';
const INSERT_AUDIT =
  'INSERT INTO audit_events (created_at, event_type, details, actor_email, target_email, target, source_address) VALUES (@created_at, @event_type, @details, @actor_email, @target_email, @target, @source_address)';
const SELECT_AUDIT =
  'SELECT created_at, event_type, details, actor_email, target_email, target, source_address FROM audit_events ORDER BY id';
const MODEL_ENDPOINT = {
  key: 'model.endpoint',
  value: 'https://model.example.invalid/v1',
};
const ANONYMOUS_AUDIT = {
  created_at: 1_700_000_000_100,
  event_type: 'platform.started',
  details: '{"reason":"boot"}',
  actor_email: null,
  target_email: null,
  target: null,
  source_address: null,
};
const UNKNOWN_EMAIL_AUDIT = {
  created_at: 1_700_000_000_101,
  event_type: 'login.failed',
  details: '{"reason":"unknown-email"}',
  actor_email: 'unknown@example.com',
  target_email: 'unknown@example.com',
  target: 'user',
  source_address: '192.0.2.10',
};
const PRESTART_NULLS = {
  container_id: null,
  upstream_host: null,
  upstream_port: null,
  dsh_cookie: null,
  image_tag: null,
  last_started_at: null,
  last_activity_at: null,
  last_error: null,
};
const STOPPED_INSTANCE = {
  user_id: ORIGINAL_USER.id,
  status: 'stopped',
  ...PRESTART_NULLS,
};

const FIRST_USER_SESSION_A = {
  token_hash: 'token-hash-placeholder-a',
  user_id: ORIGINAL_USER.id,
  created_at: 1_700_000_000_010,
  last_activity_at: 1_700_000_000_011,
};
const FIRST_USER_SESSION_B = {
  token_hash: 'token-hash-placeholder-b',
  user_id: ORIGINAL_USER.id,
  created_at: 1_700_000_000_012,
  last_activity_at: 1_700_000_000_013,
};
const SECOND_USER_SESSION = {
  token_hash: 'token-hash-placeholder-c',
  user_id: ADMIN_DISABLED_USER.id,
  created_at: 1_700_000_000_014,
  last_activity_at: 1_700_000_000_015,
};

describe('initial schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects a duplicate normalized email without changing the original user', () => {
    const insert = db.prepare(INSERT_USER);
    insert.run(ORIGINAL_USER);

    expect(() => {
      insert.run({ ...ADMIN_DISABLED_USER, email: ORIGINAL_USER.email });
    }).toThrow(/UNIQUE constraint failed: users\.email/);

    expect(db.prepare(SELECT_USERS).all()).toEqual([ORIGINAL_USER]);
  });

  it('rejects an invalid role without changing the original user', () => {
    const insert = db.prepare(INSERT_USER);
    insert.run(ORIGINAL_USER);

    expect(() => {
      insert.run({
        ...ORIGINAL_USER,
        id: 'zzzzzzzzzzzz',
        email: 'other@example.com',
        role: 'manager',
      });
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run('manager', ORIGINAL_USER.id);
    }).toThrow(/CHECK constraint failed/);

    expect(db.prepare(SELECT_USERS).all()).toEqual([ORIGINAL_USER]);
  });

  it('rejects an invalid status without changing the original user', () => {
    db.prepare(INSERT_USER).run(ADMIN_DISABLED_USER);

    expect(() => {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run('pending', ADMIN_DISABLED_USER.id);
    }).toThrow(/CHECK constraint failed/);

    expect(db.prepare(SELECT_USERS).all()).toEqual([ADMIN_DISABLED_USER]);
  });

  it('deletes one user platform sessions without removing users or the other user session', () => {
    db.prepare(INSERT_USER).run(ORIGINAL_USER);
    db.prepare(INSERT_USER).run(ADMIN_DISABLED_USER);
    const insertSession = db.prepare(INSERT_SESSION);
    insertSession.run(FIRST_USER_SESSION_A);
    insertSession.run(FIRST_USER_SESSION_B);
    insertSession.run(SECOND_USER_SESSION);

    expect(() => {
      insertSession.run({
        ...SECOND_USER_SESSION,
        token_hash: 'token-hash-placeholder-orphan',
        user_id: 'zzzzzzzzzzzz',
      });
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare('DELETE FROM platform_sessions WHERE user_id = ?').run(ORIGINAL_USER.id);

    expect(db.prepare(`${SELECT_USERS} ORDER BY id`).all()).toEqual([
      ORIGINAL_USER,
      ADMIN_DISABLED_USER,
    ]);
    expect(db.prepare(SELECT_SESSIONS).all()).toEqual([SECOND_USER_SESSION]);
  });

  it('stores a nullable pre-start instance and running upstream fields for one user', () => {
    db.prepare(INSERT_USER).run(ORIGINAL_USER);
    db.prepare(INSERT_INSTANCE).run(ORIGINAL_USER.id, 'stopped');

    expect(db.prepare(SELECT_INSTANCE).get(ORIGINAL_USER.id)).toEqual(STOPPED_INSTANCE);

    db.prepare(
      'UPDATE instances SET status = ?, upstream_host = ?, upstream_port = ? WHERE user_id = ?',
    ).run('running', '127.0.0.1', 3080, ORIGINAL_USER.id);

    expect(db.prepare(SELECT_INSTANCE).get(ORIGINAL_USER.id)).toEqual({
      user_id: ORIGINAL_USER.id,
      status: 'running',
      ...PRESTART_NULLS,
      upstream_host: '127.0.0.1',
      upstream_port: 3080,
    });

    for (const port of [1, 65_535]) {
      db.prepare('UPDATE instances SET upstream_port = ? WHERE user_id = ?').run(
        port,
        ORIGINAL_USER.id,
      );
      expect(
        db.prepare('SELECT upstream_port FROM instances WHERE user_id = ?').get(ORIGINAL_USER.id),
      ).toEqual({ upstream_port: port });
    }

    for (const status of ['starting', 'error', 'stopped'] as const) {
      db.prepare('UPDATE instances SET status = ? WHERE user_id = ?').run(status, ORIGINAL_USER.id);
      expect(
        db.prepare('SELECT status FROM instances WHERE user_id = ?').get(ORIGINAL_USER.id),
      ).toEqual({ status });
    }
  });

  it('rejects a second instance for the same user, an orphan user, and invalid status or port', () => {
    db.prepare(INSERT_USER).run(ORIGINAL_USER);
    db.prepare(INSERT_INSTANCE).run(ORIGINAL_USER.id, 'stopped');

    expect(() => {
      db.prepare(INSERT_INSTANCE).run(ORIGINAL_USER.id, 'running');
    }).toThrow(/UNIQUE constraint failed: instances\.user_id/);
    expect(() => {
      db.prepare(INSERT_INSTANCE).run('zzzzzzzzzzzz', 'stopped');
    }).toThrow(/FOREIGN KEY constraint failed/);

    const invalid = [
      ['status', 'full'],
      ['upstream_port', 0],
      ['upstream_port', 65_536],
      ['upstream_port', 3080.5],
    ] as const;
    for (const [column, value] of invalid) {
      expect(() => {
        db.prepare(`UPDATE instances SET ${column} = ? WHERE user_id = ?`).run(
          value,
          ORIGINAL_USER.id,
        );
      }).toThrow(/CHECK constraint failed/);
    }

    expect(db.prepare(SELECT_INSTANCE).get(ORIGINAL_USER.id)).toEqual(STOPPED_INSTANCE);
  });

  it('stores a setting and anonymous plus unknown-email audit snapshots', () => {
    db.prepare(INSERT_SETTING).run(MODEL_ENDPOINT.key, MODEL_ENDPOINT.value);
    db.prepare(INSERT_AUDIT).run(ANONYMOUS_AUDIT);
    db.prepare(INSERT_AUDIT).run(UNKNOWN_EMAIL_AUDIT);

    expect(db.prepare(SELECT_SETTING).get(MODEL_ENDPOINT.key)).toEqual(MODEL_ENDPOINT);
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([ANONYMOUS_AUDIT, UNKNOWN_EMAIL_AUDIT]);
  });

  it('reapplying the default migration keeps inserted rows and one version record', () => {
    db.prepare(INSERT_USER).run(ORIGINAL_USER);
    db.prepare(INSERT_SESSION).run(FIRST_USER_SESSION_A);
    db.prepare(INSERT_INSTANCE).run(ORIGINAL_USER.id, 'stopped');
    db.prepare(INSERT_SETTING).run(MODEL_ENDPOINT.key, MODEL_ENDPOINT.value);
    db.prepare(INSERT_AUDIT).run(ANONYMOUS_AUDIT);

    applyMigrations(db);

    expect(db.prepare(SELECT_USERS).all()).toEqual([ORIGINAL_USER]);
    expect(db.prepare(SELECT_SESSIONS).all()).toEqual([FIRST_USER_SESSION_A]);
    expect(db.prepare(SELECT_INSTANCE).get(ORIGINAL_USER.id)).toEqual(STOPPED_INSTANCE);
    expect(db.prepare(SELECT_SETTING).get(MODEL_ENDPOINT.key)).toEqual(MODEL_ENDPOINT);
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([ANONYMOUS_AUDIT]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
    ]);
  });

  it('rejects null and duplicate identity keys without overwriting valid rows', () => {
    db.prepare(INSERT_USER).run(ORIGINAL_USER);
    db.prepare(INSERT_SESSION).run(FIRST_USER_SESSION_A);
    db.prepare(INSERT_INSTANCE).run(ORIGINAL_USER.id, 'stopped');
    db.prepare(INSERT_SETTING).run(MODEL_ENDPOINT.key, MODEL_ENDPOINT.value);

    expect(() => {
      db.prepare(INSERT_USER).run({ ...ORIGINAL_USER, id: null, email: 'null-id@example.com' });
    }).toThrow(/NOT NULL constraint failed: users\.id/);
    expect(() => {
      db.prepare(INSERT_SESSION).run({ ...FIRST_USER_SESSION_A, token_hash: null });
    }).toThrow(/NOT NULL constraint failed: platform_sessions\.token_hash/);
    expect(() => {
      db.prepare(INSERT_INSTANCE).run(null, 'stopped');
    }).toThrow(/NOT NULL constraint failed: instances\.user_id/);
    expect(() => {
      db.prepare(INSERT_SETTING).run(null, MODEL_ENDPOINT.value);
    }).toThrow(/NOT NULL constraint failed: settings\.key/);

    expect(() => {
      db.prepare(INSERT_USER).run({ ...ORIGINAL_USER, email: 'dup-id@example.com' });
    }).toThrow(/UNIQUE constraint failed: users\.id/);
    expect(() => {
      db.prepare(INSERT_SESSION).run({
        ...FIRST_USER_SESSION_A,
        created_at: 1_700_000_000_099,
      });
    }).toThrow(/UNIQUE constraint failed: platform_sessions\.token_hash/);
    expect(() => {
      db.prepare(INSERT_SETTING).run(MODEL_ENDPOINT.key, 'other-value');
    }).toThrow(/UNIQUE constraint failed: settings\.key/);

    expect(db.prepare(SELECT_USERS).all()).toEqual([ORIGINAL_USER]);
    expect(db.prepare(SELECT_SESSIONS).all()).toEqual([FIRST_USER_SESSION_A]);
    expect(db.prepare(SELECT_INSTANCE).get(ORIGINAL_USER.id)).toEqual(STOPPED_INSTANCE);
    expect(db.prepare(SELECT_SETTING).get(MODEL_ENDPOINT.key)).toEqual(MODEL_ENDPOINT);
  });
});

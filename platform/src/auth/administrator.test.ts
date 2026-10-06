import type * as NodeCrypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBarrier,
  cryptoBarrier,
  discardBarrier,
  waitForDerivation,
} from '../../test/auth-crypto-fixture.ts';
import { snapshotAuthState, tableCounts } from '../../test/auth-fixture.ts';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  administerAccount,
  AdministratorConflictError,
  createSession,
  hashPassword,
  verifyPassword,
} from './index.ts';

const EMAIL = 'user@example.com';
const ID = 'abcdefghijkl';
const PASSWORD = ' Original password ';
const NEW_PASSWORD = ' 新密码 😀😀 ';
const NOW = 1700000000000;
interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: number;
}

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  // Vitest hoists the factory; the fixture controls only delivery of real scrypt callbacks.
  const { controlledScrypt } = await import('../../test/auth-crypto-fixture.ts');
  return { ...actual, scrypt: controlledScrypt(actual.scrypt) };
});

afterAll(() => {
  vi.doUnmock('node:crypto');
});

let database: DatabaseHandle;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  database = openDatabase(':memory:');
  applyMigrations(database);
});
afterEach(() => {
  database.close();
  vi.useRealTimers();
});

async function seed(role = 'employee', status = 'active'): Promise<AccountRow> {
  const hash = await hashPassword(PASSWORD);
  database
    .prepare(
      'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(ID, EMAIL, hash, role, status, 1234);
  return { id: ID, email: EMAIL, password_hash: hash, role, status, created_at: 1234 };
}

function account(): AccountRow | undefined {
  return database.prepare<[string], AccountRow>('SELECT * FROM users WHERE email = ?').get(EMAIL);
}

function events(): unknown[] {
  return database
    .prepare(
      'SELECT created_at, event_type, actor_email, target_email, target, source_address, details FROM audit_events ORDER BY id',
    )
    .all();
}

function expectedEvent(eventType: string) {
  return {
    created_at: NOW,
    event_type: eventType,
    actor_email: null,
    target_email: EMAIL,
    target: ID,
    source_address: null,
    details: '{}',
  };
}

describe('administrator account operation', () => {
  it('creates a canonical active administrator with a real password and no terminal session', async () => {
    const result = await administerAccount(
      database,
      ' User@Example.com ',
      () => Promise.resolve(NEW_PASSWORD),
      new AbortController().signal,
    );

    const row = account();
    expect(result).toBe('created');
    if (row === undefined) {
      throw new Error('expected administrator');
    }
    expect(row.id).toMatch(/^[a-z0-9]{12}$/);
    expect(row.password_hash).toMatch(/^scrypt-utf16le\$/);
    expect(row).toEqual({
      id: row.id,
      email: EMAIL,
      password_hash: row.password_hash,
      role: 'admin',
      status: 'active',
      created_at: NOW,
    });
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD.trim(), row.password_hash)).toBe(false);
    expect(tableCounts(database)).toEqual({ users: 1, sessions: 0, audits: 1 });
    expect(events()).toEqual([{ ...expectedEvent('admin.created'), target: row.id }]);
  });

  it.each(['active', 'disabled'])(
    'promotes a %s employee without changing other account fields or sessions',
    async (status) => {
      const before = await seed('employee', status);
      createSession(database, ID, NOW);
      createSession(database, ID, NOW);
      const sessions = snapshotAuthState(database).sessions;

      const result = await administerAccount(
        database,
        EMAIL,
        () => Promise.resolve(null),
        new AbortController().signal,
      );

      expect(result).toBe('promoted');
      expect(account()).toEqual({ ...before, role: 'admin' });
      expect(snapshotAuthState(database).sessions).toEqual(sessions);
      expect(events()).toEqual([expectedEvent('admin.promoted')]);
    },
  );

  it('leaves an existing administrator unchanged without misleading audit', async () => {
    const before = await seed('admin', 'disabled');
    createSession(database, ID, NOW);
    const state = snapshotAuthState(database);

    const result = await administerAccount(
      database,
      EMAIL,
      () => Promise.resolve(null),
      new AbortController().signal,
    );

    expect(result).toBe('unchanged');
    expect(account()).toEqual(before);
    expect(snapshotAuthState(database)).toEqual(state);
  });

  it.each(['employee', 'admin'])(
    'resets a disabled %s and revokes sessions created before and during prompts',
    async (role) => {
      const before = await seed(role, 'disabled');
      createSession(database, ID, NOW);
      database
        .prepare(
          "INSERT INTO users VALUES ('mnopqrstuvwx', 'other@example.com', ?, 'employee', 'active', 1234)",
        )
        .run(before.password_hash);
      createSession(database, 'mnopqrstuvwx', NOW);
      const otherSessions = database
        .prepare("SELECT * FROM platform_sessions WHERE user_id = 'mnopqrstuvwx'")
        .all();

      const result = await administerAccount(
        database,
        EMAIL,
        () => {
          expect(database.inTransaction).toBe(false);
          createSession(database, ID, NOW);
          return Promise.resolve(NEW_PASSWORD);
        },
        new AbortController().signal,
      );

      expect(result).toBe(role === 'employee' ? 'promoted-and-reset' : 'reset');
      const row = account();
      if (row === undefined) {
        throw new Error('expected administrator');
      }
      expect(row.password_hash).not.toBe(before.password_hash);
      expect(row).toEqual({ ...before, role: 'admin', password_hash: row.password_hash });
      expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
      expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
      expect(database.prepare('SELECT * FROM platform_sessions WHERE user_id = ?').all(ID)).toEqual(
        [],
      );
      expect(
        database.prepare("SELECT * FROM platform_sessions WHERE user_id = 'mnopqrstuvwx'").all(),
      ).toEqual(otherSessions);
      expect(events()).toEqual([
        ...(role === 'employee' ? [expectedEvent('admin.promoted')] : []),
        expectedEvent('password.reset'),
      ]);
    },
  );

  it('rolls back promotion, password, revocation and the first audit if reset audit fails', async () => {
    const before = await seed();
    createSession(database, ID, NOW);
    const state = snapshotAuthState(database);
    database.exec(
      "CREATE TRIGGER reject_reset BEFORE INSERT ON audit_events WHEN NEW.event_type = 'password.reset' BEGIN SELECT RAISE(ABORT, 'reset audit unavailable'); END",
    );

    await expect(
      administerAccount(
        database,
        EMAIL,
        () => Promise.resolve(NEW_PASSWORD),
        new AbortController().signal,
      ),
    ).rejects.toThrow('reset audit unavailable');

    expect(account()).toEqual(before);
    expect(snapshotAuthState(database)).toEqual(state);
  });

  it('rolls back new administrator creation if its audit cannot be written', async () => {
    database.exec(
      "CREATE TRIGGER reject_creation BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );

    await expect(
      administerAccount(
        database,
        EMAIL,
        () => Promise.resolve(NEW_PASSWORD),
        new AbortController().signal,
      ),
    ).rejects.toThrow('audit unavailable');

    expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
  });

  it.each([
    "UPDATE users SET id = 'mnopqrstuvwx'",
    "UPDATE users SET email = 'other@example.com'",
    "UPDATE users SET role = 'admin'",
    "UPDATE users SET status = 'disabled'",
    "UPDATE users SET password_hash = 'changed'",
    'UPDATE users SET created_at = 4567',
    'DELETE FROM users',
  ])('rejects a concurrent target change instead of overwriting it: %s', async (sql) => {
    await seed();
    let concurrent: unknown[] = [];

    await expect(
      administerAccount(
        database,
        EMAIL,
        () => {
          database.exec(sql);
          concurrent = database.prepare('SELECT * FROM users').all();
          return Promise.resolve(null);
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AdministratorConflictError);

    expect(database.prepare('SELECT * FROM users').all()).toEqual(concurrent);
    expect(events()).toEqual([]);
  });

  it('rejects an account appearing during prompts without promoting the newcomer', async () => {
    let concurrent: AccountRow | undefined;

    await expect(
      administerAccount(
        database,
        EMAIL,
        async () => {
          concurrent = await seed();
          return NEW_PASSWORD;
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AdministratorConflictError);

    expect(account()).toEqual(concurrent);
    expect(events()).toEqual([]);
  });

  it('rechecks an already-administrator no-op rather than accepting a stale target', async () => {
    await seed('admin');

    await expect(
      administerAccount(
        database,
        EMAIL,
        () => {
          database.exec("UPDATE users SET status = 'disabled'");
          return Promise.resolve(null);
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AdministratorConflictError);

    expect(account()?.status).toBe('disabled');
    expect(events()).toEqual([]);
  });

  it('cancellation while real password crypto is held cannot commit later', async () => {
    const before = await seed();
    createSession(database, ID, NOW);
    const state = snapshotAuthState(database);
    const controller = new AbortController();
    const barrier = createBarrier();
    cryptoBarrier.queue.push(barrier);
    const pending = administerAccount(
      database,
      EMAIL,
      () => Promise.resolve(NEW_PASSWORD),
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    try {
      await waitForDerivation(barrier, pending, 'administrator reset');
      expect(database.inTransaction).toBe(false);
      controller.abort();
      barrier.release();
      await rejected;

      expect(account()).toEqual(before);
      expect(snapshotAuthState(database)).toEqual(state);
    } finally {
      discardBarrier(barrier);
      await Promise.allSettled([pending, rejected]);
    }
  });

  it('revokes target sessions added while hashing without deleting another user session', async () => {
    const before = await seed();
    database
      .prepare(
        "INSERT INTO users VALUES ('mnopqrstuvwx', 'other@example.com', ?, 'employee', 'active', 1234)",
      )
      .run(before.password_hash);
    createSession(database, 'mnopqrstuvwx', NOW);
    const otherSessions = snapshotAuthState(database).sessions;
    const barrier = createBarrier();
    cryptoBarrier.queue.push(barrier);
    const pending = administerAccount(
      database,
      EMAIL,
      () => Promise.resolve(NEW_PASSWORD),
      new AbortController().signal,
    );
    try {
      await waitForDerivation(barrier, pending, 'administrator session revocation');
      createSession(database, ID, NOW);
      barrier.release();

      expect(await pending).toBe('promoted-and-reset');
      expect(snapshotAuthState(database).sessions).toEqual(otherSessions);
      expect(events()).toEqual([expectedEvent('admin.promoted'), expectedEvent('password.reset')]);
    } finally {
      discardBarrier(barrier);
      await Promise.allSettled([pending]);
    }
  });

  it('rejects a password change while hashing rather than overwrite the new credential', async () => {
    const before = await seed();
    createSession(database, ID, NOW);
    const state = snapshotAuthState(database);
    const barrier = createBarrier();
    cryptoBarrier.queue.push(barrier);
    const pending = administerAccount(
      database,
      EMAIL,
      () => Promise.resolve(NEW_PASSWORD),
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(AdministratorConflictError);
    try {
      await waitForDerivation(barrier, pending, 'administrator target recheck');
      database
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run('newer-credential', ID);
      barrier.release();
      await rejected;

      expect(account()).toEqual({ ...before, password_hash: 'newer-credential' });
      expect(snapshotAuthState(database)).toEqual(state);
    } finally {
      discardBarrier(barrier);
      await Promise.allSettled([pending, rejected]);
    }
  });

  it('rolls back promotion and its audit when the password update fails', async () => {
    const before = await seed();
    createSession(database, ID, NOW);
    const state = snapshotAuthState(database);
    database.exec(
      "CREATE TRIGGER reject_password BEFORE UPDATE OF password_hash ON users BEGIN SELECT RAISE(ABORT, 'password write unavailable'); END",
    );

    await expect(
      administerAccount(
        database,
        EMAIL,
        () => Promise.resolve(NEW_PASSWORD),
        new AbortController().signal,
      ),
    ).rejects.toThrow('password write unavailable');

    expect(account()).toEqual(before);
    expect(snapshotAuthState(database)).toEqual(state);
  });

  it('does not create a passwordless administrator when creation input is cancelled', async () => {
    await expect(
      administerAccount(database, EMAIL, () => Promise.resolve(null), new AbortController().signal),
    ).rejects.toThrow('New administrator requires a password');

    expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
  });

  it('rejects invalid email before interactive work or account writes', async () => {
    await expect(
      administerAccount(
        database,
        'invalid-email',
        () => Promise.reject(new Error('unexpected prompt')),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid email');

    expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
  });

  it.each(['😀'.repeat(5), '😀'.repeat(257)])(
    'rejects a password outside the shared Unicode policy without writes',
    async (password) => {
      await expect(
        administerAccount(
          database,
          EMAIL,
          () => Promise.resolve(password),
          new AbortController().signal,
        ),
      ).rejects.toThrow('Password must be 6 to 256 Unicode code points');

      expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
    },
  );
});

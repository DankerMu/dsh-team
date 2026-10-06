import { EventEmitter } from 'node:events';
import type * as NodeCrypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createBarrier,
  cryptoBarrier,
  discardBarrier,
  waitForDerivation,
} from '../test/auth-crypto-fixture.ts';
import { snapshotAuthState } from '../test/auth-fixture.ts';
import type { AccountRow } from '../test/cli-process-fixture.ts';
import { terminalStreams } from '../test/terminal-fixture.ts';
import { applyMigrations, openDatabase } from './db/index.ts';
import type { DatabaseHandle } from './db/index.ts';
import { runCli } from './cli.ts';
import { verifyPassword } from './auth/index.ts';

const PASSWORD = ' 密码 😀😀 ';
const ENV = {
  PLATFORM_PUBLIC_URL: 'http://platform.example.test',
  PLATFORM_DATA_DIR: '/owned-cli-data',
};

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  // Static fixture bindings are unavailable in Vitest's hoisted mock factory.
  const { controlledScrypt } = await import('../test/auth-crypto-fixture.ts');
  return { ...actual, scrypt: controlledScrypt(actual.scrypt) };
});

afterAll(() => {
  vi.doUnmock('node:crypto');
});

function lifecycleFixture(responses: readonly string[]) {
  const streams = terminalStreams(responses);
  const database = openDatabase(':memory:');
  applyMigrations(database);
  let finalState: unknown;
  const closeDatabase = database.close.bind(database);
  // Observe the real SQLite handle at its close boundary; all mutation/commit code stays real.
  database.close = () => {
    finalState = storedState(database);
    return closeDatabase();
  };
  const errors = new PassThrough();
  const signals = new EventEmitter();
  let stderr = '';
  errors.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const run = () =>
    runCli(
      ['admin', 'create', 'user@example.com'],
      ENV,
      streams.input,
      streams.output,
      errors,
      signals,
      () => database,
    );
  return {
    ...streams,
    database,
    signals,
    run,
    stderr: () => stderr,
    finalState: () => finalState,
    dispose() {
      streams.input.destroy();
      streams.output.destroy();
      errors.destroy();
      if (database.open) {
        database.close();
      }
    },
  };
}

function storedState(database: DatabaseHandle) {
  return {
    users: database.prepare('SELECT * FROM users ORDER BY id').all(),
    ...snapshotAuthState(database),
  };
}

describe('administrator CLI database and terminal lifetime', () => {
  it('reports creation only after real account and audit commit, then closes its database and terminal', async () => {
    const fixture = lifecycleFixture([PASSWORD, PASSWORD]);
    let committed: unknown;
    let committedAccount: AccountRow | undefined;
    const startedAt = Date.now();
    fixture.output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Administrator created')) {
        committed = storedState(fixture.database);
        committedAccount = fixture.database
          .prepare<[string], AccountRow>('SELECT * FROM users WHERE email = ?')
          .get('user@example.com');
      }
    });
    try {
      const status = await fixture.run();

      expect(status).toBe(0);
      if (committedAccount === undefined) {
        throw new Error('expected committed administrator at success output');
      }
      expect(committedAccount.id).toMatch(/^[a-z0-9]{12}$/);
      expect(committedAccount.password_hash).toMatch(/^scrypt-utf16le\$/);
      expect(await verifyPassword(PASSWORD, committedAccount.password_hash)).toBe(true);
      expect(committedAccount.created_at).toBeGreaterThanOrEqual(startedAt);
      expect(committedAccount.created_at).toBeLessThanOrEqual(Date.now());
      expect(committed).toEqual({
        users: [
          {
            id: committedAccount.id,
            email: 'user@example.com',
            password_hash: committedAccount.password_hash,
            role: 'admin',
            status: 'active',
            created_at: committedAccount.created_at,
          },
        ],
        sessions: [],
        audits: [
          {
            id: 1,
            created_at: committedAccount.created_at,
            event_type: 'admin.created',
            details: '{}',
            actor_email: null,
            target_email: 'user@example.com',
            target: committedAccount.id,
            source_address: null,
          },
        ],
      });
      expect(fixture.stderr()).toBe('');
      expect(fixture.written()).not.toContain(PASSWORD);
      expect(fixture.database.open).toBe(false);
      expect(fixture.input.isRaw).toBe(false);
      expect(fixture.input.isPaused()).toBe(true);
      expect(fixture.signals.eventNames()).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ['mismatch', 'second secret', /passwords do not match/i],
    ['short', 'short', /6 to 256 Unicode code points/i],
  ] as const)(
    'rejects %s password input without changes or secret disclosure and releases resources',
    async (first, second, diagnostic) => {
      const fixture = lifecycleFixture([first, second]);
      try {
        const status = await fixture.run();

        expect(status).toBe(1);
        expect(fixture.finalState()).toEqual({ users: [], sessions: [], audits: [] });
        expect(fixture.stderr()).toMatch(diagnostic);
        expect(`${fixture.stderr()}${fixture.written()}`).not.toContain('second secret');
        expect(fixture.database.open).toBe(false);
        expect(fixture.input.isRaw).toBe(false);
        expect(fixture.signals.eventNames()).toEqual([]);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'handles repeated %s during held real crypto without a late commit',
    async (signal) => {
      const fixture = lifecycleFixture([PASSWORD, PASSWORD]);
      const barrier = createBarrier();
      cryptoBarrier.queue.push(barrier);
      const pending = fixture.run();
      try {
        await waitForDerivation(barrier, pending, 'CLI creation');
        fixture.signals.emit(signal);
        fixture.signals.emit(signal);
        barrier.release();
        const status = await pending;

        expect(status).toBe(1);
        expect(fixture.finalState()).toEqual({ users: [], sessions: [], audits: [] });
        expect(fixture.stderr()).toMatch(/cancelled/i);
        expect(fixture.written()).not.toMatch(/administrator created/i);
        expect(fixture.database.open).toBe(false);
        expect(fixture.input.isRaw).toBe(false);
        expect(fixture.signals.eventNames()).toEqual([]);
      } finally {
        discardBarrier(barrier);
        await Promise.allSettled([pending]);
        fixture.dispose();
      }
    },
  );

  it('returns a fixed safe failure for unexpected crypto errors and releases resources', async () => {
    const fixture = lifecycleFixture([PASSWORD, PASSWORD]);
    const barrier = createBarrier(new Error('input-bearing-error-sentinel'));
    cryptoBarrier.queue.push(barrier);
    const pending = fixture.run();
    try {
      await waitForDerivation(barrier, pending, 'CLI creation failure');
      expect(storedState(fixture.database)).toEqual({ users: [], sessions: [], audits: [] });
      barrier.release();
      const status = await pending;

      expect(fixture.finalState()).toEqual({ users: [], sessions: [], audits: [] });
      expect(status).toBe(1);
      expect(fixture.stderr()).toMatch(/administrator command failed/i);
      expect(fixture.stderr()).not.toContain('input-bearing-error-sentinel');
      expect(fixture.stderr()).not.toContain('Error:');
      expect(fixture.written()).not.toContain(PASSWORD);
      expect(fixture.database.open).toBe(false);
      expect(fixture.input.isRaw).toBe(false);
      expect(fixture.signals.eventNames()).toEqual([]);
    } finally {
      discardBarrier(barrier);
      await Promise.allSettled([pending]);
      fixture.dispose();
    }
  });
});

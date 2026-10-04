import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { queryAuditEvents, recordAuditEvent } from './index.ts';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const SQL_EMAIL = "alice' OR 1=1 --@example.com";
const T1 = 1_700_000_001_000;
const T2 = 1_700_000_002_000;
const T3 = 1_700_000_003_000;
const T4 = 1_700_000_004_000;
const T5 = 1_700_000_005_000;
const T6 = 1_700_000_006_000;
const UNSAFE_INTEGER = 2 ** 53;
const OVERFLOW_PAGE_SIZE = 2 ** 52;
const INVALID_PAGE_VALUES = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, UNSAFE_INTEGER];
const DETAILS_SENTINEL_A = 'DETAILS_SENTINEL_A';
const DETAILS_SENTINEL_B = '{not-json-DETAILS_SENTINEL_B';
const SNAPSHOT_AUDIT = 'SELECT * FROM audit_events ORDER BY id';

interface AuditFilters {
  eventType?: string;
  email?: string;
  from?: number;
  to?: number;
}

const FILTER_CASES: readonly [string, AuditFilters, readonly number[]][] = [
  ['returns only matching event types from mixed events', { eventType: 'login.succeeded' }, [5, 4]],
  ['matches actor or target email once', { email: ALICE }, [5, 4, 2]],
  ['matches email as actor-only or target-only for a different account', { email: BOB }, [5, 1]],
  ['includes records on both from and to time bounds', { from: T3, to: T5 }, [5, 4, 3]],
  ['applies an open-ended from bound', { from: T5 }, [6, 5]],
  ['applies an open-ended to bound', { to: T2 }, [2, 1]],
  ['returns no rows for an unknown event type', { eventType: 'session.message' }, []],
  ['returns no rows for an unknown email', { email: 'nobody@example.com' }, []],
  ['returns no rows for a reversed time range', { from: T5, to: T1 }, []],
  ['treats SQL-like event type as exact literal', { eventType: "'login.succeeded' OR 1=1 --" }, []],
  ['treats a SQL-like unknown email as an exact literal', { email: "' OR 1=1 --" }, []],
  ['matches a stored SQL-like email as an exact literal', { email: SQL_EMAIL }, [6]],
];

function seedMixedEvents(db: DatabaseHandle): void {
  recordAuditEvent(db, { type: 'login.failed', createdAt: T1, actorEmail: BOB });
  recordAuditEvent(db, {
    type: 'account.disabled',
    createdAt: T2,
    targetEmail: ALICE,
    target: 'user',
  });
  recordAuditEvent(db, {
    type: 'instance.stopped',
    createdAt: T3,
    target: ALICE,
    details: { reason: 'idle' },
  });
  recordAuditEvent(db, {
    type: 'login.succeeded',
    createdAt: T4,
    actorEmail: ALICE,
    targetEmail: ALICE,
  });
  recordAuditEvent(db, {
    type: 'login.succeeded',
    createdAt: T5,
    actorEmail: ALICE,
    targetEmail: BOB,
  });
  recordAuditEvent(db, { type: 'logout.succeeded', createdAt: T6, actorEmail: SQL_EMAIL });
}

function queryError(db: DatabaseHandle, query: { page: number; pageSize: number }): Error {
  try {
    queryAuditEvents(db, query);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected queryAuditEvents to throw');
}

describe('queryAuditEvents', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns seeded events newest first with parsed details and null omitted metadata', () => {
    recordAuditEvent(db, { type: 'login.succeeded', createdAt: 1_700_000_001_000 });
    recordAuditEvent(db, {
      type: 'instance.stopped',
      createdAt: 1_700_000_002_000,
      actorEmail: 'actor@example.com',
      targetEmail: 'target@example.com',
      target: 'user',
      sourceAddress: '192.0.2.20',
      details: { reason: 'idle' },
    });

    const rows = queryAuditEvents(db, { page: 1, pageSize: 10 });

    expect(rows).toEqual([
      {
        id: 2,
        createdAt: 1_700_000_002_000,
        type: 'instance.stopped',
        actorEmail: 'actor@example.com',
        targetEmail: 'target@example.com',
        target: 'user',
        sourceAddress: '192.0.2.20',
        details: { reason: 'idle' },
      },
      {
        id: 1,
        createdAt: 1_700_000_001_000,
        type: 'login.succeeded',
        actorEmail: null,
        targetEmail: null,
        target: null,
        sourceAddress: null,
        details: {},
      },
    ]);
  });

  it('ANDs type, email, and time as the intersection of matching rows', () => {
    recordAuditEvent(db, { type: 'login.succeeded', createdAt: T1, actorEmail: ALICE });
    recordAuditEvent(db, { type: 'login.succeeded', createdAt: T3, actorEmail: ALICE });
    recordAuditEvent(db, { type: 'login.failed', createdAt: T3, actorEmail: ALICE });
    recordAuditEvent(db, { type: 'login.succeeded', createdAt: T3, actorEmail: BOB });

    const cases: readonly [AuditFilters, readonly number[]][] = [
      [{ eventType: 'login.succeeded' }, [4, 2, 1]],
      [{ email: ALICE }, [3, 2, 1]],
      [{ from: T3, to: T3 }, [4, 3, 2]],
      [{ eventType: 'login.succeeded', email: ALICE, from: T3, to: T3 }, [2]],
    ];
    for (const [filters, expectedIds] of cases) {
      const rows = queryAuditEvents(db, { page: 1, pageSize: 10, ...filters });
      expect(rows.map((row) => row.id)).toEqual(expectedIds);
    }
  });

  describe('filters', () => {
    beforeEach(() => {
      seedMixedEvents(db);
    });

    it.each(FILTER_CASES)('%s', (_name, filters, expectedIds) => {
      const rows = queryAuditEvents(db, { page: 1, pageSize: 10, ...filters });

      expect(rows.map((row) => row.id)).toEqual(expectedIds);
    });
  });

  describe('pagination', () => {
    it('returns adjacent pages of mixed timestamps without overlap or gap', () => {
      recordAuditEvent(db, { type: 'login.failed', createdAt: T1, actorEmail: BOB });
      recordAuditEvent(db, { type: 'login.succeeded', createdAt: T2, actorEmail: ALICE });
      recordAuditEvent(db, { type: 'logout.succeeded', createdAt: T3, actorEmail: ALICE });
      recordAuditEvent(db, { type: 'account.disabled', createdAt: T2, targetEmail: BOB });
      const before = db.prepare(SNAPSHOT_AUDIT).all();

      const page1 = queryAuditEvents(db, { page: 1, pageSize: 2 }).map((row) => row.id);
      const page2 = queryAuditEvents(db, { page: 2, pageSize: 2 }).map((row) => row.id);
      const page3 = queryAuditEvents(db, { page: 3, pageSize: 2 }).map((row) => row.id);

      expect(page1).toEqual([3, 4]);
      expect(page2).toEqual([2, 1]);
      expect([...page1, ...page2]).toEqual([3, 4, 2, 1]);
      expect(page3).toEqual([]);
      expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(before);
    });

    it('paginates after filtering and returns empty pages for empty or out-of-range queries', () => {
      expect(queryAuditEvents(db, { page: 1, pageSize: 10 })).toEqual([]);

      seedMixedEvents(db);
      const before = db.prepare(SNAPSHOT_AUDIT).all();
      const pages = [1, 2, 3].map((page) =>
        queryAuditEvents(db, { page, pageSize: 2, email: ALICE }).map((row) => row.id),
      );

      expect(pages).toEqual([[5, 4], [2], []]);
      expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(before);
    });
  });

  describe('invalid pagination', () => {
    it.each(['page', 'pageSize'] as const)(
      'rejects invalid %s values with one constant field-named error and no input echo',
      (field) => {
        seedMixedEvents(db);
        const before = db.prepare(SNAPSHOT_AUDIT).all();
        const messages = INVALID_PAGE_VALUES.map((value) => {
          const query =
            field === 'page' ? { page: value, pageSize: 10 } : { page: 1, pageSize: value };
          const error = queryError(db, query);
          expect(error.message).toMatch(field === 'page' ? /\bpage\b/ : /\bpageSize\b/);
          expect(error.message).not.toContain(String(value));
          return error.message;
        });

        expect(new Set(messages).size).toBe(1);
        expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(before);
      },
    );

    it('rejects an unsafe offset with a constant field-named error and no input echo', () => {
      seedMixedEvents(db);
      const before = db.prepare(SNAPSHOT_AUDIT).all();
      const first = queryError(db, { page: 3, pageSize: OVERFLOW_PAGE_SIZE });
      const second = queryError(db, { page: 5, pageSize: OVERFLOW_PAGE_SIZE });

      expect(first.message).toMatch(/page|pageSize|offset/);
      expect(first.message).not.toContain(String(OVERFLOW_PAGE_SIZE));
      expect(first.message).not.toContain('3');
      expect(second.message).toBe(first.message);
      expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(before);
    });
  });

  describe('malformed details and database errors', () => {
    it('rejects malformed persisted details with a constant error that does not echo the sentinel', () => {
      seedMixedEvents(db);
      db.prepare('UPDATE audit_events SET details = ? WHERE id = 4').run(DETAILS_SENTINEL_A);
      const afterFirst = db.prepare(SNAPSHOT_AUDIT).all();
      const first = queryError(db, { page: 1, pageSize: 10 });

      expect(first.message).not.toContain('DETAILS_SENTINEL_A');
      expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(afterFirst);

      db.prepare('UPDATE audit_events SET details = ? WHERE id = 4').run(DETAILS_SENTINEL_B);
      const afterSecond = db.prepare(SNAPSHOT_AUDIT).all();
      const second = queryError(db, { page: 1, pageSize: 10 });

      expect(second.message).toBe(first.message);
      expect(second.message).not.toContain('DETAILS_SENTINEL_B');
      expect(db.prepare(SNAPSHOT_AUDIT).all()).toEqual(afterSecond);
    });

    it('propagates a dropped-table database error', () => {
      seedMixedEvents(db);
      db.exec('DROP TABLE audit_events');

      expect(queryError(db, { page: 1, pageSize: 10 })).toMatchObject({ code: 'SQLITE_ERROR' });
    });
  });
});

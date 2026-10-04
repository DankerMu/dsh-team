import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { recordAuditEvent } from './index.ts';

const SELECT_AUDIT =
  'SELECT created_at, event_type, details, actor_email, target_email, target, source_address FROM audit_events ORDER BY id';
const COUNT_AUDIT = 'SELECT COUNT(*) AS n FROM audit_events';

const CLOSED_EVENT_TYPES = [
  'account.registered',
  'login.succeeded',
  'login.failed',
  'logout.succeeded',
  'password.changed',
  'account.disabled',
  'account.enabled',
  'password.reset',
  'admin.created',
  'admin.promoted',
  'model-config.updated',
  'runtime-config.updated',
  'instance.restarted',
  'instance.config-reset',
  'instance.created',
  'instance.started',
  'instance.ready',
  'instance.stopped',
  'instance.start-failed',
] as const;

const UNKNOWN_EVENT_TYPES = ['session.message', 'toString', 'constructor', '__proto__'] as const;
const STOP_REASONS = ['idle', 'admin', 'disabled', 'error'] as const;

const METADATA = {
  actorEmail: 'actor@example.com',
  targetEmail: 'target@example.com',
  target: 'user',
  sourceAddress: '192.0.2.20',
} as const;

const SECRETS = {
  password: 'attempted-password-SENTINEL',
  token: 'platform-session-token-SENTINEL',
  cookie: 'dsh-cookie-SENTINEL',
  apiKey: 'model-apiKey-SENTINEL',
  content: 'conversation-content-SENTINEL',
  note: 'unapproved-note',
};

const INVALID_REASON_SENTINEL = 'idle-admin-SENTINEL';
const WRITE_ABORT = 'audit-write-aborted';

interface AuditInput {
  type: string;
  createdAt: number;
  actorEmail?: string;
  targetEmail?: string;
  target?: string;
  sourceAddress?: string;
  details?: Record<string, unknown>;
}

// Object.create is typed as returning any; this object has no own "reason".
const INHERITED_REASON_DETAILS = Object.create({ reason: 'idle' }) as Record<string, unknown>;

const THROWING_TOJSON_EXTRA = {
  content: {
    toJSON() {
      throw new Error(SECRETS.content);
    },
  },
};

function expectedRow(
  type: string,
  createdAt: number,
  details: string,
  meta: Partial<Pick<AuditInput, 'actorEmail' | 'targetEmail' | 'target' | 'sourceAddress'>> | null,
) {
  return {
    created_at: createdAt,
    event_type: type,
    details,
    actor_email: meta?.actorEmail ?? null,
    target_email: meta?.targetEmail ?? null,
    target: meta?.target ?? null,
    source_address: meta?.sourceAddress ?? null,
  };
}

function rejectedMessage(db: DatabaseHandle, event: AuditInput, echoed: readonly string[]): string {
  let caught: unknown;
  try {
    recordAuditEvent(db, event);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw caught;
  }
  for (const fragment of echoed) {
    expect(caught.message).not.toContain(fragment);
  }
  expect(db.prepare(COUNT_AUDIT).get()).toEqual({ n: 0 });
  return caught.message;
}

describe('recordAuditEvent', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('persists login.succeeded with caller metadata and empty details', () => {
    recordAuditEvent(db, {
      type: 'login.succeeded',
      createdAt: 1_700_000_000_200,
      ...METADATA,
    });
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([
      {
        created_at: 1_700_000_000_200,
        event_type: 'login.succeeded',
        details: '{}',
        actor_email: 'actor@example.com',
        target_email: 'target@example.com',
        target: 'user',
        source_address: '192.0.2.20',
      },
    ]);
  });

  it.each(CLOSED_EVENT_TYPES)(
    'persists %s metadata, NULL omissions, and projected details',
    (type) => {
      const projected = type === 'instance.stopped' ? '{"reason":"idle"}' : '{}';
      const details = type === 'instance.stopped' ? { reason: 'idle', ...SECRETS } : SECRETS;
      recordAuditEvent(db, { type, createdAt: 1_700_000_001_000, ...METADATA, details });
      recordAuditEvent(db, {
        type,
        createdAt: 1_700_000_002_000,
        ...(type === 'instance.stopped' ? { details: { reason: 'idle' } } : {}),
      });
      expect(db.prepare(SELECT_AUDIT).all()).toEqual([
        expectedRow(type, 1_700_000_001_000, projected, METADATA),
        expectedRow(type, 1_700_000_002_000, projected, null),
      ]);
    },
  );

  it.each(UNKNOWN_EVENT_TYPES)(
    'rejects unknown event %j without inserting a row or echoing the identifier',
    (type) => {
      rejectedMessage(db, { type, createdAt: 1_700_000_003_000, ...METADATA }, [type]);
    },
  );

  it.each(STOP_REASONS)(
    'persists instance.stopped with reason %s and discards extra detail fields',
    (reason) => {
      recordAuditEvent(db, {
        type: 'instance.stopped',
        createdAt: 1_700_000_005_000,
        ...METADATA,
        details: { reason, ...SECRETS },
      });
      expect(db.prepare(SELECT_AUDIT).all()).toEqual([
        expectedRow('instance.stopped', 1_700_000_005_000, `{"reason":"${reason}"}`, METADATA),
      ]);
    },
  );

  it('discards cyclic extra fields without traversing them for empty-detail events', () => {
    const cyclic: Record<string, unknown> = { password: SECRETS.password };
    cyclic.self = cyclic;
    recordAuditEvent(db, {
      type: 'login.failed',
      createdAt: 1_700_000_006_000,
      actorEmail: 'unknown@example.com',
      details: cyclic,
    });
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([
      expectedRow('login.failed', 1_700_000_006_000, '{}', { actorEmail: 'unknown@example.com' }),
    ]);
  });

  it.each([
    ['BigInt extra', { token: 10n }],
    ['throwing toJSON extra', THROWING_TOJSON_EXTRA],
  ])('discards unserializable %s without traversing them for instance.stopped', (_label, extra) => {
    recordAuditEvent(db, {
      type: 'instance.stopped',
      createdAt: 1_700_000_007_000,
      ...METADATA,
      details: { reason: 'admin', ...extra },
    });
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([
      expectedRow('instance.stopped', 1_700_000_007_000, '{"reason":"admin"}', METADATA),
    ]);
  });

  it.each([
    ['omitted details', undefined],
    ['empty object', {}],
    ['inherited reason', INHERITED_REASON_DETAILS],
    ['invalid string', { reason: INVALID_REASON_SENTINEL }],
    ['null reason', { reason: null }],
    ['number reason', { reason: 1 }],
    ['object reason', { reason: { idle: true } }],
    ['array reason', { reason: ['idle'] }],
    ['toJSON reason', { reason: { toJSON: () => 'idle' } }],
  ])('rejects instance.stopped with %s without a row or echoing input', (_label, details) => {
    const event: AuditInput = {
      type: 'instance.stopped',
      createdAt: 1_700_000_008_000,
      ...METADATA,
      ...(details === undefined ? {} : { details }),
    };
    expect(rejectedMessage(db, event, [INVALID_REASON_SENTINEL, 'idle'])).toContain('reason');
  });

  it('propagates a database write failure and inserts no row', () => {
    db.exec(
      `CREATE TEMP TRIGGER abort_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, '${WRITE_ABORT}'); END`,
    );
    expect(
      rejectedMessage(
        db,
        { type: 'login.succeeded', createdAt: 1_700_000_009_000, ...METADATA },
        [],
      ),
    ).toContain(WRITE_ABORT);
  });

  it('leaves caller transaction ownership unchanged so rollback discards the row', () => {
    db.exec('BEGIN');
    recordAuditEvent(db, {
      type: 'login.succeeded',
      createdAt: 1_700_000_010_000,
      ...METADATA,
    });
    expect(db.prepare(SELECT_AUDIT).all()).toEqual([
      expectedRow('login.succeeded', 1_700_000_010_000, '{}', METADATA),
    ]);
    expect(db.inTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(db.prepare(COUNT_AUDIT).get()).toEqual({ n: 0 });
    expect(db.inTransaction).toBe(false);
  });
});

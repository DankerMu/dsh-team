import type { DatabaseHandle } from '../db/index.ts';

interface AuditEvent {
  readonly type: string;
  readonly createdAt: number;
  readonly actorEmail?: string;
  readonly targetEmail?: string;
  readonly target?: string;
  readonly sourceAddress?: string;
  readonly details?: Record<string, unknown>;
}

const INSERT_AUDIT =
  'INSERT INTO audit_events (created_at, event_type, details, actor_email, target_email, target, source_address) VALUES (?, ?, ?, ?, ?, ?, ?)';

const UNKNOWN_EVENT_TYPE = 'Unknown audit event type';
const INVALID_STOP_REASON = 'Invalid audit details field "reason"';

const STOP_REASONS: Record<string, true> = {
  idle: true,
  admin: true,
  disabled: true,
  error: true,
};

export type InstanceStopReason = 'idle' | 'admin' | 'disabled' | 'error';

export function validateStopReason(value: unknown): asserts value is InstanceStopReason {
  if (typeof value !== 'string' || !Object.hasOwn(STOP_REASONS, value))
    throw new Error(INVALID_STOP_REASON);
}

const EVENT_DETAIL_FIELDS: Record<string, readonly string[]> = {
  'account.registered': [],
  'login.succeeded': [],
  'login.failed': [],
  'logout.succeeded': [],
  'password.changed': [],
  'account.disabled': [],
  'account.enabled': [],
  'password.reset': [],
  'admin.created': [],
  'admin.promoted': [],
  'model-config.updated': [],
  'runtime-config.updated': [],
  'instance.restarted': [],
  'instance.config-reset': [],
  'instance.created': [],
  'instance.started': [],
  'instance.ready': [],
  'instance.stopped': ['reason'],
  'instance.start-failed': [],
};

function projectDetails(type: string, details: Record<string, unknown> | undefined): string {
  const fields = Object.hasOwn(EVENT_DETAIL_FIELDS, type) ? EVENT_DETAIL_FIELDS[type] : undefined;
  if (fields === undefined) {
    throw new Error(UNKNOWN_EVENT_TYPE);
  }
  if (fields.length === 0) {
    return '{}';
  }

  const projected: Record<string, string> = {};
  for (const field of fields) {
    if (details === undefined || !Object.hasOwn(details, field)) {
      throw new Error(INVALID_STOP_REASON);
    }
    const value = details[field];
    validateStopReason(value);
    projected[field] = value;
  }
  return JSON.stringify(projected);
}

export function recordAuditEvent(db: DatabaseHandle, event: AuditEvent): void {
  const details = projectDetails(event.type, event.details);
  db.prepare(INSERT_AUDIT).run(
    event.createdAt,
    event.type,
    details,
    event.actorEmail ?? null,
    event.targetEmail ?? null,
    event.target ?? null,
    event.sourceAddress ?? null,
  );
}

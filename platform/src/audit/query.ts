import type { DatabaseHandle } from '../db/index.ts';

interface AuditQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly eventType?: string;
  readonly email?: string;
  readonly from?: number;
  readonly to?: number;
}

interface AuditRow {
  readonly id: number;
  readonly createdAt: number;
  readonly type: string;
  readonly actorEmail: string | null;
  readonly targetEmail: string | null;
  readonly target: string | null;
  readonly sourceAddress: string | null;
}

interface PersistedAuditRow extends AuditRow {
  details: string;
}

interface AuditEventRow extends AuditRow {
  readonly details: unknown;
}

const INVALID_PAGE = 'Invalid audit query field "page"';
const INVALID_PAGE_SIZE = 'Invalid audit query field "pageSize"';
const INVALID_OFFSET = 'Invalid audit query field "offset"';
const INVALID_AUDIT_DETAILS = 'Invalid audit details';

const SELECT_AUDIT =
  'SELECT id, created_at AS createdAt, event_type AS type, actor_email AS actorEmail, target_email AS targetEmail, target, source_address AS sourceAddress, details FROM audit_events';

const SELECT_AUDIT_ORDER = ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';

function mapRow(row: PersistedAuditRow): AuditEventRow {
  let details: unknown;
  try {
    // JSON.parse is typed as any; persisted details is JSON text.
    details = JSON.parse(row.details) as unknown;
  } catch {
    throw new Error(INVALID_AUDIT_DETAILS);
  }
  return { ...row, details };
}

export function queryAuditEvents(db: DatabaseHandle, query: AuditQuery): AuditEventRow[] {
  if (!Number.isSafeInteger(query.page) || query.page < 1) {
    throw new Error(INVALID_PAGE);
  }
  if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 1) {
    throw new Error(INVALID_PAGE_SIZE);
  }
  const offset = (query.page - 1) * query.pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new Error(INVALID_OFFSET);
  }

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (query.eventType !== undefined) {
    conditions.push('event_type = ?');
    bindings.push(query.eventType);
  }
  if (query.email !== undefined) {
    conditions.push('(actor_email = ? OR target_email = ?)');
    bindings.push(query.email, query.email);
  }
  if (query.from !== undefined) {
    conditions.push('created_at >= ?');
    bindings.push(query.from);
  }
  if (query.to !== undefined) {
    conditions.push('created_at <= ?');
    bindings.push(query.to);
  }

  const sql =
    SELECT_AUDIT +
    (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '') +
    SELECT_AUDIT_ORDER;
  bindings.push(query.pageSize, offset);

  const rows = db.prepare<(string | number)[], PersistedAuditRow>(sql).all(...bindings);
  return rows.map(mapRow);
}

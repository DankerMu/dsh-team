import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

const EVENT_NAMES: Record<string, string> = {
  'account.registered': '注册',
  'login.succeeded': '登录成功',
  'login.failed': '登录失败',
  'logout.succeeded': '登出',
  'password.changed': '修改密码',
  'account.disabled': '禁用账号',
  'account.enabled': '启用账号',
  'password.reset': '重置密码',
  'admin.created': '创建管理员',
  'admin.promoted': '提升管理员',
  'model-config.updated': '修改模型配置',
  'runtime-config.updated': '修改运行参数',
  'instance.restarted': '重启实例',
  'instance.config-reset': '重置实例配置',
  'instance.created': '创建实例',
  'instance.started': '启动实例',
  'instance.ready': '实例就绪',
  'instance.stopped': '停止实例',
  'instance.start-failed': '实例启动失败',
};
const STOP_NAMES: Record<string, string> = {
  idle: '空闲',
  admin: '管理员',
  disabled: '禁用',
  error: '出错',
};
interface AuditItem {
  id: number;
  createdAt: number;
  type: string;
  actorEmail: string | null;
  targetEmail: string | null;
  target: string | null;
  sourceAddress: string | null;
  details: { reason?: string };
}
interface Filters {
  eventType: string;
  email: string;
  from: string;
  to: string;
}
interface ReadAttempt {
  controller: AbortController;
  finished: boolean;
}
const EMPTY_FILTERS: Filters = { eventType: '', email: '', from: '', to: '' };
const TIME_ERROR = '时间范围无效，请输入有效的本地时间，且开始时间不晚于结束时间。';

function localTime(value: string): number | undefined {
  if (value === '') return undefined;
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (match === null) throw new Error(TIME_ERROR);
  const parts: [number, number, number, number, number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? '0'),
    Number((match[7] ?? '').padEnd(3, '0')),
  ];
  const [year, month, day, hours, minutes, seconds, ms] = parts;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, ms);
  const epoch = date.getTime();
  const actual = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
  if (
    year < 1 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !actual.every((part, index) => part === parts[index])
  )
    throw new Error(TIME_ERROR);
  return epoch;
}
function parameters(filters: Filters, page: number): string {
  const from = localTime(filters.from);
  const to = localTime(filters.to);
  if (from !== undefined && to !== undefined && from > to) throw new Error(TIME_ERROR);
  const result = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (filters.eventType !== '') result.set('eventType', filters.eventType);
  if (filters.email !== '') result.set('email', filters.email);
  if (from !== undefined) result.set('from', String(from));
  if (to !== undefined) result.set('to', String(to));
  return result.toString();
}
function validTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000
  );
}
function validDetails(value: unknown): value is AuditItem['details'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (!('reason' in value) ||
      (typeof value.reason === 'string' && Object.hasOwn(STOP_NAMES, value.reason)))
  );
}
function validItem(value: unknown): value is AuditItem {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('id' in value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  )
    return false;
  if (!('createdAt' in value) || !validTime(value.createdAt)) return false;
  if (!('type' in value) || typeof value.type !== 'string') return false;
  const metadata = ['actorEmail', 'targetEmail', 'target', 'sourceAddress'];
  if (
    !metadata.every(
      (key) =>
        key in value &&
        (Reflect.get(value, key) === null || typeof Reflect.get(value, key) === 'string'),
    )
  )
    return false;
  return 'details' in value && validDetails(value.details);
}
function readItems(value: unknown, page: number): AuditItem[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !('page' in value) ||
    !('pageSize' in value)
  )
    throw new Error('Invalid audit list');
  if (
    value.page !== page ||
    value.pageSize !== 20 ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !value.items.every(validItem)
  )
    throw new Error('Invalid audit list');
  return value.items;
}
function presentation(names: Record<string, string>, value: string): string {
  return Object.hasOwn(names, value) ? (names[value] ?? value) : value;
}

export function AuditPage() {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [query, setQuery] = useState({ filters: EMPTY_FILTERS, page: 1, revision: 0 });
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failure' | 'denied'>('loading');
  const [validation, setValidation] = useState('');
  const owner = useRef<ReadAttempt | null>(null);
  useEffect(() => {
    const attempt: ReadAttempt = { controller: new AbortController(), finished: false };
    owner.current = attempt;
    setItems(null);
    setState('loading');
    const current = () => owner.current === attempt && !attempt.controller.signal.aborted;
    function denied(status: number): boolean {
      if (status !== 401 && status !== 403) return false;
      setItems(null);
      setValidation('');
      setState('denied');
      if (status === 401) window.location.assign('/_platform/login');
      return true;
    }
    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `/_platform/api/admin/audit-events?${parameters(query.filters, query.page)}`,
          {
            credentials: 'same-origin',
            redirect: 'error',
            signal: attempt.controller.signal,
          },
        );
        if (!current()) return;
        if (response.status !== 200) {
          try {
            await response.arrayBuffer();
          } catch {
            // A broken rejection body must not mask current authority.
            if (!current() || denied(response.status)) return;
            throw new Error('Audit response failed');
          }
          if (!current() || denied(response.status)) return;
          throw new Error('Audit query failed');
        }
        const body: unknown = await response.json();
        if (!current()) return;
        setItems(readItems(body, query.page));
        setState('ready');
      } catch {
        if (current()) setState('failure');
      } finally {
        attempt.finished = true;
      }
    }
    void load();
    return () => {
      if (owner.current === attempt) owner.current = null;
      // Answered resources have been consumed; departure cancels only unfinished reads.
      if (!attempt.finished) attempt.controller.abort();
    };
  }, [query]);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const filters = { ...draft, email: draft.email.trim() };
    try {
      parameters(filters, 1);
      setValidation('');
      setQuery((previous) => ({ filters, page: 1, revision: previous.revision + 1 }));
    } catch {
      setValidation(TIME_ERROR);
    }
  }
  const filtered = Object.values(query.filters).some((value) => value !== '');
  const empty =
    query.page > 1 ? '本页没有审计记录' : filtered ? '没有匹配的审计记录' : '暂无审计记录';
  return (
    <main className="admin" aria-busy={state === 'loading'}>
      <AdminNavigation page="audit" />
      <div className="admin-content">
        <h1>审计日志</h1>
        {state === 'denied' ? (
          <p role="alert">无权限</p>
        ) : (
          <>
            <AuditFilters draft={draft} setDraft={setDraft} submit={submit} />
            {validation !== '' && <p role="alert">{validation}</p>}
            {state === 'loading' && <p role="status">加载中…</p>}
            {state === 'failure' && (
              <>
                <p role="alert">加载失败</p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery((previous) => ({ ...previous, revision: previous.revision + 1 }));
                  }}
                >
                  重试
                </button>
              </>
            )}
            {items !== null && (
              <>
                {items.length === 0 ? <p role="status">{empty}</p> : <AuditRows items={items} />}
                <div className="admin-pages" aria-label="审计分页">
                  <button
                    type="button"
                    disabled={query.page === 1}
                    onClick={() => {
                      setQuery((previous) => ({ ...previous, page: previous.page - 1 }));
                    }}
                  >
                    上一页
                  </button>
                  <p>第 {query.page} 页</p>
                  <button
                    type="button"
                    disabled={items.length < 20}
                    onClick={() => {
                      setQuery((previous) => ({ ...previous, page: previous.page + 1 }));
                    }}
                  >
                    下一页
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function AuditFilters({
  draft,
  setDraft,
  submit,
}: {
  draft: Filters;
  setDraft: (value: Filters) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="admin-filters" aria-label="筛选审计" onSubmit={submit}>
      <div className="field">
        <label htmlFor="audit-type">事件类型</label>
        <select
          id="audit-type"
          value={draft.eventType}
          onChange={(event) => {
            setDraft({ ...draft, eventType: event.currentTarget.value });
          }}
        >
          <option value="">全部</option>
          {Object.entries(EVENT_NAMES).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="audit-email">邮箱</label>
        <input
          id="audit-email"
          maxLength={254}
          value={draft.email}
          onChange={(event) => {
            setDraft({ ...draft, email: event.currentTarget.value });
          }}
        />
      </div>
      <span className="field-hint">本地时间（包含起止时间）</span>
      {(['from', 'to'] as const).map((key) => (
        <label key={key} className="field">
          {key === 'from' ? '开始时间' : '结束时间'}
          <input
            type="datetime-local"
            step="0.001"
            value={draft[key]}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.currentTarget.value });
            }}
          />
        </label>
      ))}
      <button type="submit">筛选</button>
    </form>
  );
}

function AuditRows({ items }: { items: AuditItem[] }) {
  return (
    <div className="admin-table">
      <table aria-label="审计记录">
        <thead>
          <tr>
            {['时间', '事件', '操作者邮箱', '对象邮箱', '对象', '来源地址', '停止原因'].map(
              (name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const date = new Date(item.createdAt);
            return (
              <tr key={item.id} data-audit-id={item.id}>
                <td>
                  <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
                </td>
                <td>{presentation(EVENT_NAMES, item.type)}</td>
                <td>{item.actorEmail ?? '—'}</td>
                <td>{item.targetEmail ?? '—'}</td>
                <td>{item.target ?? '—'}</td>
                <td>{item.sourceAddress ?? '—'}</td>
                <td>
                  {item.details.reason === undefined
                    ? '—'
                    : presentation(STOP_NAMES, item.details.reason)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

const STATUS_NAMES = {
  'not-created': '未创建',
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  error: '出错',
};
interface InstanceRow {
  userId: string;
  email: string;
  status: keyof typeof STATUS_NAMES;
  lastStartedAt: number | null;
  lastActivityAt: number | null;
  lastError: string | null;
}
interface ReadAttempt {
  controller: AbortController;
  finished: boolean;
}
interface Selection {
  row: InstanceRow;
  action: 'restart' | 'reset-config';
}
const ACTION_FAILURE = '操作失败，状态可能已变更；请查看刷新后的实例状态，再决定是否重试。';
const RESTART_NAMES: Record<string, string> = {
  ...STATUS_NAMES,
  full: '人数已满',
  unconfigured: '模型未配置',
};
function restartFeedback(value: unknown, userId: string): { text: string; error: boolean } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('userId' in value) ||
    value.userId !== userId ||
    !('status' in value) ||
    typeof value.status !== 'string' ||
    value.status === 'not-created' ||
    !Object.hasOwn(RESTART_NAMES, value.status) ||
    !('reason' in value) ||
    value.reason !== (value.status === 'running' ? null : value.status)
  )
    throw new Error('Invalid restart receipt');
  const accepted = value.status === 'starting' || value.status === 'running';
  return {
    text: `${accepted ? '重启已提交（不代表已就绪）' : '重启未完成'}：${RESTART_NAMES[value.status] ?? ''}。`,
    error: !accepted,
  };
}
function actionFeedback(
  status: number,
  selected: Selection,
  body: unknown,
): { text: string; error: boolean } {
  if (selected.action === 'reset-config' && status === 204) {
    return { text: '配置已重置；实例保持停止，下次需显式启动。', error: false };
  }
  if (selected.action === 'restart' && status === 200) {
    return restartFeedback(body, selected.row.userId);
  }
  return {
    text:
      status === 409 ? '操作冲突，实例可能正在启动或账号已禁用；请查看最新状态。' : ACTION_FAILURE,
    error: true,
  };
}
function validTimes(value: object): boolean {
  for (const field of ['lastStartedAt', 'lastActivityAt']) {
    if (!(field in value)) return false;
    const time: unknown = Reflect.get(value, field);
    if (
      time !== null &&
      (typeof time !== 'number' ||
        !Number.isSafeInteger(time) ||
        Math.abs(time) > 8_640_000_000_000_000)
    )
      return false;
  }
  return true;
}
function validRow(value: unknown): value is InstanceRow {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('userId' in value) ||
    typeof value.userId !== 'string' ||
    !/^[a-z0-9]{12}$/.test(value.userId)
  )
    return false;
  if (!('email' in value) || typeof value.email !== 'string') return false;
  if (
    !('status' in value) ||
    typeof value.status !== 'string' ||
    !Object.hasOwn(STATUS_NAMES, value.status)
  )
    return false;
  if (!validTimes(value)) return false;
  return 'lastError' in value && (value.lastError === null || typeof value.lastError === 'string');
}
function readRows(value: unknown): InstanceRow[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items.every(validRow)
  )
    throw new Error('Invalid instance list');
  return value.items;
}

export function InstancePage() {
  const [rows, setRows] = useState<InstanceRow[] | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failure' | 'denied'>('loading');
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState({ text: '', error: false });
  const inFlight = useRef(false);
  const alive = useRef(true);
  const owner = useRef<ReadAttempt | null>(null);
  const rejectAuthority = useCallback((status: number): boolean => {
    if (status !== 401 && status !== 403) return false;
    owner.current = null;
    setRows(null);
    setSelection(null);
    setFeedback({ text: '', error: false });
    setPhase('denied');
    if (status === 401) window.location.assign('/_platform/login');
    return true;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const attempt: ReadAttempt = { controller: new AbortController(), finished: false };
    owner.current = attempt;
    setRows(null);
    setPhase('loading');
    const current = () => owner.current === attempt && !attempt.controller.signal.aborted;
    async function load(): Promise<void> {
      try {
        const response = await fetch('/_platform/api/admin/instances', {
          credentials: 'same-origin',
          redirect: 'error',
          signal: attempt.controller.signal,
        });
        if (response.status !== 200) {
          try {
            await response.arrayBuffer();
          } catch {
            /* Current authority still applies to an unreadable rejection. */
          }
          if (!current() || rejectAuthority(response.status)) return;
          throw new Error('Instance list failed');
        }
        const body: unknown = await response.json();
        if (!current()) return;
        setRows(readRows(body));
        setPhase('ready');
      } catch {
        if (current()) setPhase('failure');
      } finally {
        attempt.finished = true;
      }
    }
    void load();
    return () => {
      if (owner.current === attempt) owner.current = null;
      if (!attempt.finished) attempt.controller.abort();
    };
  }, [revision, rejectAuthority]);
  function refresh(): void {
    if (inFlight.current) return;
    owner.current = null;
    setRevision((value) => value + 1);
  }
  function choose(row: InstanceRow, action: Selection['action']): void {
    if (!inFlight.current) setSelection({ row, action });
  }
  function cancel(): void {
    if (!inFlight.current) setSelection(null);
  }
  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current || selection === null) return;
    inFlight.current = true;
    owner.current = null;
    setPending(true);
    setFeedback({ text: '', error: false });
    const selected = selection;
    let reload = true;
    try {
      const response = await fetch(
        `/_platform/api/admin/instances/${selected.row.userId}/${selected.action}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      let body: unknown;
      try {
        body =
          response.status === 200 && selected.action === 'restart'
            ? await response.json()
            : await response.arrayBuffer();
      } catch {
        if (alive.current && rejectAuthority(response.status)) {
          reload = false;
          return;
        }
        throw new Error('Instance action response failed');
      }
      if (!alive.current) return;
      if (rejectAuthority(response.status)) {
        reload = false;
        return;
      }
      setFeedback(actionFeedback(response.status, selected, body));
    } catch {
      if (alive.current) setFeedback({ text: ACTION_FAILURE, error: true });
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setPending(false);
        setSelection(null);
        if (reload) refresh();
      }
    }
  }
  return (
    <InstanceView
      rows={rows}
      phase={phase}
      search={search}
      setSearch={setSearch}
      selection={selection}
      pending={pending}
      feedback={feedback}
      refresh={refresh}
      choose={choose}
      cancel={cancel}
      confirm={(event) => {
        void confirm(event);
      }}
    />
  );
}

interface InstanceViewProps {
  rows: InstanceRow[] | null;
  phase: 'loading' | 'ready' | 'failure' | 'denied';
  search: string;
  setSearch: (value: string) => void;
  selection: Selection | null;
  pending: boolean;
  feedback: { text: string; error: boolean };
  refresh: () => void;
  choose: (row: InstanceRow, action: Selection['action']) => void;
  cancel: () => void;
  confirm: (event: FormEvent<HTMLFormElement>) => void;
}
function InstanceView({
  rows,
  phase,
  search,
  setSearch,
  selection,
  pending,
  feedback,
  refresh,
  choose,
  cancel,
  confirm,
}: InstanceViewProps) {
  const visible = rows?.filter((row) => row.email.includes(search.trim())) ?? [];
  return (
    <main className="admin">
      <h1>实例管理</h1>
      <AdminNavigation page="instances" />
      {phase === 'denied' ? (
        <p role="alert">无权限</p>
      ) : (
        <>
          {feedback.text !== '' && (
            <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>
          )}
          <label htmlFor="instance-search">搜索邮箱</label>
          <input
            id="instance-search"
            value={search}
            disabled={pending}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
          />
          <button type="button" disabled={pending} onClick={refresh}>
            刷新
          </button>
          {phase === 'loading' && <p role="status">加载中…</p>}
          {phase === 'failure' && (
            <>
              <p role="alert">加载失败，请重试。</p>
              <button type="button" disabled={pending} onClick={refresh}>
                重试
              </button>
            </>
          )}
          {phase === 'ready' &&
            (rows?.length === 0 ? (
              <p role="status">暂无实例</p>
            ) : visible.length === 0 ? (
              <p role="status">没有匹配的实例</p>
            ) : (
              <table>
                <caption>实例状态</caption>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>状态</th>
                    <th>最近启动时间</th>
                    <th>最近活动时间</th>
                    <th>最近一次错误</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.userId}>
                      <td>{row.email}</td>
                      <td>{STATUS_NAMES[row.status]}</td>
                      <td>
                        {row.lastStartedAt === null
                          ? '暂无'
                          : new Date(row.lastStartedAt).toLocaleString('zh-CN')}
                      </td>
                      <td>
                        {row.lastActivityAt === null
                          ? '暂无'
                          : new Date(row.lastActivityAt).toLocaleString('zh-CN')}
                      </td>
                      <td>
                        {row.lastError === null ? (
                          '暂无'
                        ) : (
                          <details>
                            <summary>查看错误日志</summary>
                            <pre>{row.lastError}</pre>
                          </details>
                        )}
                      </td>
                      <td>
                        {(['restart', 'reset-config'] as const).map((action) => (
                          <button
                            key={action}
                            type="button"
                            disabled={
                              pending || row.status === 'not-created' || row.status === 'starting'
                            }
                            onClick={() => {
                              choose(row, action);
                            }}
                          >
                            {action === 'restart' ? '重启' : '重置配置'}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          {selection !== null && (
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="instance-confirmation"
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancel();
              }}
            >
              <h2 id="instance-confirmation">确认实例操作</h2>
              <p>{selection.row.email}</p>
              <p>
                {selection.action === 'reset-config'
                  ? '会恢复该用户的 DSH 设置，文件和对话保留'
                  : '将断开该用户连接并重启实例，文件和对话保留。'}
              </p>
              <form aria-label="确认实例操作" onSubmit={confirm}>
                <button type="submit" disabled={pending}>
                  {pending ? '正在提交…' : '确认'}
                </button>
                <button type="button" disabled={pending} onClick={cancel}>
                  取消
                </button>
              </form>
            </section>
          )}
        </>
      )}
    </main>
  );
}

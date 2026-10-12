import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

interface Account {
  id: string;
  email: string;
  role: 'admin' | 'employee';
  status: 'active' | 'disabled';
  createdAt: number;
}
interface AccountList {
  items: Account[];
  page: number;
  pageSize: number;
  total: number;
}
interface Selection {
  account: Account;
  action: 'disabled' | 'active' | 'password';
}
interface ReadAttempt {
  controller: AbortController;
}
const ACTION_FAILURE = '操作失败，状态可能已变更；请查看刷新后的账号状态，再决定是否重试。';

function isRegistrationTime(value: unknown): value is number {
  // Integer milliseconds must also fit the browser Date domain before rendering.
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000
  );
}

function isAccount(value: unknown): value is Account {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || !('email' in value) || !('role' in value)) return false;
  if (!('status' in value) || !('createdAt' in value)) return false;
  if (typeof value.id !== 'string' || !/^[a-z0-9]{12}$/.test(value.id)) return false;
  if (typeof value.email !== 'string') return false;
  if (value.role !== 'admin' && value.role !== 'employee') return false;
  if (value.status !== 'active' && value.status !== 'disabled') return false;
  return isRegistrationTime(value.createdAt);
}

function readList(value: unknown, page: number): AccountList {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !('page' in value) ||
    !('pageSize' in value) ||
    !('total' in value)
  )
    throw new Error('Invalid account list');
  if (
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !value.items.every(isAccount) ||
    value.page !== page ||
    value.pageSize !== 20 ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.items.length
  )
    throw new Error('Invalid account list');
  return { items: value.items, page, pageSize: 20, total: value.total };
}

function mutationFailure(status: number, action: Selection['action']): string {
  if (status === 400 && action === 'password') return '密码须为 6–256 个字符，请重新设置。';
  if (status === 409)
    return '无法完成操作：不能禁用自己或最后一位可用管理员，也可能有操作正在进行。';
  return ACTION_FAILURE;
}

export function AdminPage() {
  const [query, setQuery] = useState({ search: '', page: 1, revision: 0 });
  const [search, setSearch] = useState('');
  const [list, setList] = useState<AccountList | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failure' | 'denied'>('loading');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef<ReadAttempt | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);

  function closeSelection(): void {
    if (inFlight.current) return;
    setSelection(null);
    setPassword('');
  }
  const rejectAuthority = useCallback((status: number): boolean => {
    if (status !== 401 && status !== 403) return false;
    owner.current = null;
    setList(null);
    setSelection(null);
    setPassword('');
    setError('');
    setState('denied');
    if (status === 401) window.location.assign('/_platform/login');
    return true;
  }, []);
  function refresh(): void {
    setQuery((current) => ({ ...current, revision: current.revision + 1 }));
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const attempt: ReadAttempt = { controller: new AbortController() };
    owner.current = attempt;
    setList(null);
    setState('loading');
    const current = () => owner.current === attempt && !attempt.controller.signal.aborted;
    async function load(): Promise<void> {
      try {
        const parameters = new URLSearchParams({ page: String(query.page), pageSize: '20' });
        if (query.search !== '') parameters.set('search', query.search);
        const response = await fetch(`/_platform/api/admin/users?${parameters.toString()}`, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: attempt.controller.signal,
        });
        if (!current()) return;
        if (response.status !== 200) {
          try {
            await response.arrayBuffer();
          } catch {
            // An unreadable rejection body cannot mask current authority or become success.
            if (!current() || rejectAuthority(response.status)) return;
            throw new Error('Account list response failed');
          }
          if (!current() || rejectAuthority(response.status)) return;
          throw new Error('Account list failed');
        }
        const body: unknown = await response.json();
        if (!current()) return;
        setList(readList(body, query.page));
        setState('ready');
      } catch {
        // Obsolete network/JSON failures cannot replace a newer query or authorization result.
        if (current()) setState('failure');
      }
    }
    void load();
    return () => {
      if (owner.current === attempt) owner.current = null;
      attempt.controller.abort();
    };
  }, [query, rejectAuthority]);

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current || selection === null) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    const target = selection;
    const newPassword = password;
    setPassword('');
    try {
      const response = await fetch(
        `/_platform/api/admin/users/${target.account.id}/${target.action === 'password' ? 'password' : 'status'}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            target.action === 'password' ? { newPassword } : { status: target.action },
          ),
        },
      );
      try {
        // Complete even an empty 204 resource before releasing the mutation fence.
        await response.arrayBuffer();
      } catch {
        if (!alive.current || rejectAuthority(response.status)) return;
        throw new Error('Account mutation response failed');
      }
      if (!alive.current || rejectAuthority(response.status)) return;
      if (response.status !== 204) setError(mutationFailure(response.status, target.action));
      // Both success and failure observe durable server state; cleanup/transport may fail after commit.
      refresh();
    } catch {
      if (alive.current) {
        setError(ACTION_FAILURE);
        refresh();
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setPending(false);
        setSelection(null);
        setPassword('');
      }
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlight.current) return;
    closeSelection();
    setQuery((current) => ({ search: search.trim(), page: 1, revision: current.revision + 1 }));
  }
  function changePage(page: number): void {
    if (inFlight.current) return;
    closeSelection();
    setQuery((current) => ({ ...current, page }));
  }
  function choose(account: Account, action: Selection['action']): void {
    if (inFlight.current) return;
    setPassword('');
    setSelection({ account: { ...account }, action });
  }

  return (
    <AccountView
      query={query}
      search={search}
      setSearch={setSearch}
      list={list}
      state={state}
      selection={selection}
      password={password}
      setPassword={setPassword}
      pending={pending}
      error={error}
      submitSearch={submitSearch}
      changePage={changePage}
      choose={choose}
      closeSelection={closeSelection}
      confirm={(event) => {
        void confirm(event);
      }}
      retry={() => {
        if (!inFlight.current) refresh();
      }}
    />
  );
}

function AccountView({
  query,
  search,
  setSearch,
  list,
  state,
  selection,
  password,
  setPassword,
  pending,
  error,
  submitSearch,
  changePage,
  choose,
  closeSelection,
  confirm,
  retry,
}: {
  query: { search: string; page: number };
  search: string;
  setSearch: (value: string) => void;
  list: AccountList | null;
  state: 'loading' | 'ready' | 'failure' | 'denied';
  selection: Selection | null;
  password: string;
  setPassword: (value: string) => void;
  pending: boolean;
  error: string;
  submitSearch: (event: FormEvent<HTMLFormElement>) => void;
  changePage: (page: number) => void;
  choose: (account: Account, action: Selection['action']) => void;
  closeSelection: () => void;
  confirm: (event: FormEvent<HTMLFormElement>) => void;
  retry: () => void;
}) {
  return (
    <main className="admin" aria-busy={state === 'loading' || pending}>
      <h1>账号管理</h1>
      <AdminNavigation page="accounts" />
      {state === 'denied' ? (
        <p role="alert">无权限</p>
      ) : (
        <>
          <form aria-label="搜索账号" onSubmit={submitSearch}>
            <label htmlFor="account-search">搜索邮箱</label>
            <input
              id="account-search"
              value={search}
              maxLength={254}
              disabled={pending}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
              }}
            />
            <button disabled={pending} type="submit">
              搜索
            </button>
          </form>
          {error !== '' && <p role="alert">{error}</p>}
          <AccountRows
            list={list}
            state={state}
            search={query.search}
            pending={pending}
            choose={choose}
            retry={retry}
          />
          {list !== null && (
            <div className="admin-pages" aria-label="账号分页">
              <button
                type="button"
                disabled={pending || query.page === 1}
                onClick={() => {
                  changePage(query.page - 1);
                }}
              >
                上一页
              </button>
              <p>
                第 {list.page} 页，共 {list.total} 个账号
              </p>
              <button
                type="button"
                disabled={pending || query.page >= Math.ceil(list.total / 20)}
                onClick={() => {
                  changePage(query.page + 1);
                }}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
      {selection !== null && (
        <AccountConfirmation
          selection={selection}
          password={password}
          setPassword={setPassword}
          pending={pending}
          cancel={closeSelection}
          confirm={confirm}
        />
      )}
    </main>
  );
}

function AccountRows({
  list,
  state,
  search,
  pending,
  choose,
  retry,
}: {
  list: AccountList | null;
  state: 'loading' | 'ready' | 'failure';
  search: string;
  pending: boolean;
  choose: (account: Account, action: Selection['action']) => void;
  retry: () => void;
}) {
  if (state === 'loading') return <p role="status">加载中…</p>;
  if (state === 'failure')
    return (
      <div>
        <p role="alert">加载失败</p>
        <button type="button" onClick={retry} disabled={pending}>
          重试
        </button>
      </div>
    );
  if (list === null) return null;
  if (list.total === 0) return <p role="status">{search === '' ? '暂无账号' : '没有匹配的账号'}</p>;
  return (
    <div className="admin-table">
      <table>
        <caption>账号列表</caption>
        <thead>
          <tr>
            <th scope="col">邮箱</th>
            <th scope="col">角色</th>
            <th scope="col">状态</th>
            <th scope="col">注册时间</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((account) => {
            const registeredAt = new Date(account.createdAt);
            return (
              <tr key={account.id}>
                <td>{account.email}</td>
                <td>{account.role === 'admin' ? '管理员' : '员工'}</td>
                <td>{account.status === 'active' ? '已启用' : '已禁用'}</td>
                <td>
                  <time dateTime={registeredAt.toISOString()}>
                    {registeredAt.toLocaleString('zh-CN')}
                  </time>
                </td>
                <td>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      choose(account, account.status === 'active' ? 'disabled' : 'active');
                    }}
                  >
                    {account.status === 'active' ? '禁用' : '启用'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      choose(account, 'password');
                    }}
                  >
                    重置密码
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AccountConfirmation({
  selection,
  password,
  setPassword,
  pending,
  cancel,
  confirm,
}: {
  selection: Selection;
  password: string;
  setPassword: (value: string) => void;
  pending: boolean;
  cancel: () => void;
  confirm: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const title =
    selection.action === 'password'
      ? '重置密码'
      : selection.action === 'disabled'
        ? '禁用账号'
        : '启用账号';
  return (
    <dialog
      open
      aria-labelledby="admin-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <h2 id="admin-confirm-title">确认{title}</h2>
      <p>{selection.account.email}</p>
      <p>
        {selection.action === 'disabled'
          ? '将撤销该账号全部会话、断开连接并停止实例。'
          : selection.action === 'password'
            ? '该账号全部会话将失效，需使用新密码重新登录。'
            : '启用后该账号可以再次登录，不恢复旧会话。'}
      </p>
      <form aria-label="确认账号操作" onSubmit={confirm}>
        {selection.action === 'password' && (
          <>
            <label htmlFor="reset-password">新密码</label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              value={password}
              disabled={pending}
              onChange={(event) => {
                setPassword(event.currentTarget.value);
              }}
            />
          </>
        )}
        <button type="submit" autoFocus={selection.action !== 'password'} disabled={pending}>
          {pending ? '正在提交…' : '确认'}
        </button>
        <button type="button" disabled={pending} onClick={cancel}>
          取消
        </button>
      </form>
    </dialog>
  );
}

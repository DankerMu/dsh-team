import { useRef, useState, type FormEvent } from 'react';
import { clearOriginState } from './origin-state.ts';

const PASSWORD_FAILURE = '修改密码失败，请稍后重试。';
const LOGOUT_FAILURE = '退出登录失败，请稍后重试。';
const SESSION_EXPIRED = '登录状态已失效，请重新登录。';

type Action = 'password' | 'logout';

async function rejectionMessage(response: Response, action: Action): Promise<string> {
  const failure = action === 'password' ? PASSWORD_FAILURE : LOGOUT_FAILURE;
  if (response.status !== 401) return failure;
  if (action === 'logout') return SESSION_EXPIRED;
  const body: unknown = await response.json();
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    body.message === 'Current password is incorrect'
  ) {
    return '当前密码错误，请重试。';
  }
  return SESSION_EXPIRED;
}

// The logout is committed: neither a body read nor clearing failure may keep this page.
async function leaveSession(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // An unreadable empty 204 body does not undo the committed logout.
  }
  try {
    await clearOriginState();
  } catch {
    // Clearing is best effort; navigation must still happen exactly once.
  }
}

export function PasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Both mutations share this synchronous fence, including before React commits disabled controls.
  const inFlight = useRef(false);
  const pending = pendingAction !== null;

  async function mutate(action: Action): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingAction(action);
    setError('');
    setSuccess('');
    try {
      const response = await fetch(
        action === 'password' ? '/_platform/api/change-password' : '/_platform/api/logout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          redirect: 'error',
          body: JSON.stringify(action === 'password' ? { currentPassword, newPassword } : {}),
        },
      );
      if (response.status !== 204) {
        setError(await rejectionMessage(response, action));
      } else if (action === 'logout') {
        await leaveSession(response);
        window.location.assign('/_platform/login');
      } else {
        // The backend rotates the HttpOnly session; this browser remains authenticated.
        setCurrentPassword('');
        setNewPassword('');
        setSuccess('密码修改成功。');
      }
    } catch {
      setError(action === 'password' ? PASSWORD_FAILURE : LOGOUT_FAILURE);
    } finally {
      inFlight.current = false;
      setPendingAction(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void mutate('password');
  }

  return (
    <main className="login">
      <h1>修改密码</h1>
      <p id="password-status" role={error === '' ? 'status' : 'alert'}>
        {pending
          ? pendingAction === 'password'
            ? '正在修改密码…'
            : '正在退出登录…'
          : error || success}
      </p>
      <form
        aria-label="修改密码"
        aria-describedby="password-status"
        aria-busy={pending}
        onSubmit={submit}
      >
        <fieldset>
          <legend>账号设置</legend>
          <label htmlFor="current-password">当前密码</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            disabled={pending}
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.currentTarget.value);
            }}
          />
          <label htmlFor="new-password">新密码</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            disabled={pending}
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.currentTarget.value);
            }}
          />
          <button type="submit" disabled={pending}>
            {pendingAction === 'password' ? '正在修改密码…' : '修改密码'}
          </button>
        </fieldset>
      </form>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void mutate('logout');
        }}
      >
        {pendingAction === 'logout' ? '正在退出登录…' : '退出登录'}
      </button>
      <div className="card-links">
        <p>
          <a href="/">返回工作台</a>
        </p>
        <p>
          <a href="/_platform/login">登录</a>
        </p>
      </div>
    </main>
  );
}

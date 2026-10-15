import { useRef, useState, type FormEvent } from 'react';
import { PasswordPage } from './password-page.tsx';
import { WaitPage } from './wait-page.tsx';
import { AdminPage } from './admin-page.tsx';
import { AuditPage } from './audit-page.tsx';
import { ModelPage } from './model-page.tsx';
import { RuntimePage } from './runtime-page.tsx';
import { InstancePage } from './instance-page.tsx';

const LOGIN_FAILURE = '登录失败，请稍后重试。';
const REGISTRATION_FAILURE = '注册失败，请稍后重试。';

async function registrationRejectionMessage(response: Response): Promise<string> {
  if (response.status === 400 || response.status === 409) {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      if (response.status === 409 && body.message === 'Email already registered')
        return '邮箱已注册，请使用其他邮箱或登录。';
      if (
        response.status === 400 &&
        body.message === 'body/password must NOT have fewer than 6 characters'
      )
        return '密码太短，请输入至少 6 个字符。';
    }
  }
  return REGISTRATION_FAILURE;
}

async function rejectionMessage(response: Response, registration: boolean): Promise<string> {
  if (registration) return registrationRejectionMessage(response);
  if (response.status === 401) return '邮箱或密码错误。';
  if (response.status === 429) return '登录尝试过于频繁，请稍后再试。';
  if (response.status === 403) {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      body.message === 'Account is disabled'
    ) {
      return '账号已被禁用，请联系管理员。';
    }
  }
  return LOGIN_FAILURE;
}

export function AccountPage() {
  if (window.location.pathname === '/_platform/admin') return <AdminPage />;
  if (window.location.pathname === '/_platform/admin/instances') return <InstancePage />;
  if (window.location.pathname === '/_platform/admin/audit') return <AuditPage />;
  if (window.location.pathname === '/_platform/admin/models') return <ModelPage />;
  if (window.location.pathname === '/_platform/admin/runtime') return <RuntimePage />;
  if (window.location.pathname === '/_platform/wait') return <WaitPage />;
  return window.location.pathname === '/_platform/account' ? <PasswordPage /> : <CredentialForm />;
}

function CredentialForm() {
  const registration = window.location.pathname === '/_platform/register';
  const action = registration ? '注册' : '登录';
  const loading = registration ? '正在注册…' : '正在登录…';
  const statusId = registration ? 'registration-status' : 'login-status';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // State renders the controls; the ref also fences submits before React commits.
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(
        registration ? '/_platform/api/register' : '/_platform/api/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          // Neither credential API uses redirects as its successful response.
          redirect: 'error',
          body: JSON.stringify({ email, password }),
        },
      );
      if (response.status === (registration ? 201 : 200)) window.location.assign('/');
      else setError(await rejectionMessage(response, registration));
    } catch {
      // Network failures and malformed error bodies never expose raw diagnostics.
      setError(registration ? REGISTRATION_FAILURE : LOGIN_FAILURE);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <main className="login">
      <h1>{action} DSH 团队平台</h1>
      <p id={statusId} role={error === '' ? 'status' : 'alert'}>
        {pending ? loading : error}
      </p>
      <form
        aria-label={action}
        aria-describedby={statusId}
        aria-busy={pending}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset>
          <legend>账号{action}</legend>
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            disabled={pending}
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete={registration ? 'new-password' : 'current-password'}
            required
            disabled={pending}
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
          <button type="submit" disabled={pending}>
            {pending ? loading : action}
          </button>
        </fieldset>
      </form>
      <p>
        <a href={registration ? '/_platform/login' : '/_platform/register'}>
          {registration ? '已有账号？登录' : '没有账号？注册'}
        </a>
      </p>
      <p>
        <a href="/_platform/account">账号设置</a>
      </p>
    </main>
  );
}

import { useRef, useState, type FormEvent } from 'react';

const GENERIC_FAILURE = '登录失败，请稍后重试。';

async function rejectionMessage(response: Response): Promise<string> {
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
  return GENERIC_FAILURE;
}

export function LoginPage() {
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
      const response = await fetch('/_platform/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // A redirect is not the login API's successful 200 response.
        redirect: 'error',
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 200) window.location.assign('/');
      else setError(await rejectionMessage(response));
    } catch {
      // Network failures and malformed error bodies never expose raw diagnostics.
      setError(GENERIC_FAILURE);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <main className="login">
      <h1>登录 DSH 团队平台</h1>
      <p id="login-status" role={error === '' ? 'status' : 'alert'}>
        {pending ? '正在登录…' : error}
      </p>
      <form
        aria-label="登录"
        aria-describedby="login-status"
        aria-busy={pending}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset>
          <legend>账号登录</legend>
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
            autoComplete="current-password"
            required
            disabled={pending}
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
          <button type="submit" disabled={pending}>
            {pending ? '正在登录…' : '登录'}
          </button>
        </fieldset>
      </form>
    </main>
  );
}

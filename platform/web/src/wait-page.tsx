import { useCallback, useEffect, useRef, useState } from 'react';

type InstanceStatus = 'running' | 'stopped' | 'starting' | 'full' | 'error' | 'unconfigured';
const MESSAGES = {
  starting: '启动中',
  full: '当前使用人数已满，请稍后再试',
  unconfigured: '管理员尚未完成模型配置',
  error: '启动失败，请重试。',
  stopped: '实例已停止，请点击重试。',
} as const;

function readStatus(body: unknown): InstanceStatus {
  if (
    typeof body !== 'object' ||
    body === null ||
    Object.keys(body).length !== 2 ||
    !('status' in body) ||
    !('reason' in body)
  )
    throw new Error('Invalid instance state');
  const status = body.status;
  if (
    (status === 'running' && body.reason === null) ||
    ((status === 'stopped' ||
      status === 'starting' ||
      status === 'full' ||
      status === 'error' ||
      status === 'unconfigured') &&
      body.reason === status)
  )
    return status;
  throw new Error('Invalid instance state');
}

interface Attempt {
  controller: AbortController;
  timer?: number;
}

export function WaitPage() {
  const [status, setStatus] = useState<Exclude<InstanceStatus, 'running'>>('starting');
  const owner = useRef<Attempt | null>(null);
  // Fence repeated clicks before React has committed disabled controls.
  const pending = useRef(false);
  const begin = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    const attempt: Attempt = { controller: new AbortController() };
    owner.current = attempt;
    setStatus('starting');
    const current = () => owner.current === attempt && !attempt.controller.signal.aborted;

    async function request(start: boolean): Promise<void> {
      try {
        const response = await fetch(
          start ? '/_platform/api/instance/start' : '/_platform/api/instance',
          {
            method: start ? 'POST' : 'GET',
            credentials: 'same-origin',
            redirect: 'error',
            signal: attempt.controller.signal,
            ...(start ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
          },
        );
        if (!current()) return;
        if (response.status === 401) {
          window.location.assign('/_platform/login');
          return;
        }
        if (response.status !== 200) throw new Error('Instance request failed');
        const body: unknown = await response.json();
        if (!current()) return;
        const next = readStatus(body);
        if (next === 'running') {
          window.location.assign('/');
          return;
        }
        setStatus(next);
        if (next === 'starting') {
          // Measure from the completed response, never overlap observations.
          attempt.timer = window.setTimeout(() => {
            if (current()) void request(false);
          }, 1000);
        } else {
          pending.current = false;
        }
      } catch {
        // Cleanup invalidates ownership before abort; late JSON failures are silent too.
        if (!current()) return;
        pending.current = false;
        setStatus('error');
      }
    }

    void request(true);
  }, []);

  useEffect(() => {
    begin();
    return () => {
      const attempt = owner.current;
      owner.current = null;
      pending.current = false;
      if (attempt !== null) {
        clearTimeout(attempt.timer);
        attempt.controller.abort();
      }
    };
  }, [begin]);

  return (
    <main className="login" aria-busy={status === 'starting'}>
      <h1>等待工作台</h1>
      <p role={status === 'starting' ? 'status' : 'alert'}>{MESSAGES[status]}</p>
      {status === 'error' && <p>仍失败时请联系管理员</p>}
      <button type="button" disabled={status === 'starting'} onClick={begin}>
        重试
      </button>
      <p>
        <a href="/_platform/account">账号设置</a>
      </p>
    </main>
  );
}

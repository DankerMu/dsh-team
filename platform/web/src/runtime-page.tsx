import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

const NUMBERS = [
  { name: 'idleMinutes', label: '空闲分钟数', integer: true },
  { name: 'cpuCores', label: 'CPU 核数', integer: false },
  { name: 'memoryMiB', label: '内存 MiB', integer: true },
  { name: 'maxRunningInstances', label: '同时运行上限', integer: true },
] as const;
type NumericField = (typeof NUMBERS)[number]['name'];
type Draft = Record<NumericField | 'defaultPermissionTier', string>;
interface RuntimeValues extends Record<NumericField, number> {
  defaultPermissionTier: string;
}
interface View {
  phase: 'loading' | 'saving' | 'ready' | 'failure' | 'denied';
  draft: Draft | null;
  count: number | null;
  error: string;
  message: string;
}
const API = '/_platform/api/admin/runtime-config';
const TIERS = [
  ['approval', '人工批准'],
  ['auto', 'Auto 自动审查'],
  ['yolo', 'Yolo 完全放行'],
] as const;
const FIELDS = [...NUMBERS.map((field) => field.name), 'defaultPermissionTier'];
const INVALID =
  '请检查取值范围：空闲分钟数、内存 MiB、同时运行上限须为 1–9007199254740991 的整数；CPU 核数须为大于 0 的有限数，支持小数；请选择默认权限档。同时运行上限不得超过已配置子网池的容量。';
const FAILURE = '保存失败，设置可能已变更；请重新打开页面核对后再试。';
const INITIAL: View = { phase: 'loading', draft: null, count: null, error: '', message: '' };

function validNumber(value: unknown, integer: boolean): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    (!integer || Number.isSafeInteger(value))
  );
}
function readRuntime(value: unknown, saved: boolean) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid runtime response');
  // JSON envelope is an object; validate its closed projection and each domain below.
  const body = value as Record<string, unknown>;
  const allowed = saved ? [...FIELDS, 'runningInstances'] : FIELDS;
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !TIERS.some(([tier]) => tier === body.defaultPermissionTier)
  )
    throw new Error('Invalid runtime fields');
  for (const field of NUMBERS) {
    if (!validNumber(body[field.name], field.integer)) throw new Error('Invalid runtime number');
  }
  const count = saved ? body.runningInstances : null;
  if (saved && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))
    throw new Error('Invalid runtime count');
  // All five required values were checked against their wire domains above.
  const values = body as unknown as RuntimeValues;
  return {
    draft: {
      idleMinutes: String(values.idleMinutes),
      cpuCores: String(values.cpuCores),
      memoryMiB: String(values.memoryMiB),
      maxRunningInstances: String(values.maxRunningInstances),
      defaultPermissionTier: values.defaultPermissionTier,
    },
    count: typeof count === 'number' ? count : null,
  };
}
function invalidMessage(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
  ) {
    const match = /PLATFORM_SUBNET_POOL provides ([0-9]+) \/28 subnets/.exec(body.message);
    const capacity = Number(match?.[1]);
    if (Number.isSafeInteger(capacity) && capacity > 0)
      return `同时运行上限不能超过已配置子网池的容量：${String(capacity)}。`;
  }
  return INVALID;
}
async function requestRuntime(signal: AbortSignal, payload?: RuntimeValues) {
  const response = await fetch(API, {
    method: payload === undefined ? 'GET' : 'PUT',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* The status still governs authorization; a null success body fails validation. */
  }
  return { status: response.status, body };
}

export function RuntimePage() {
  const [view, setView] = useState<View>(INITIAL);
  const owner = useRef<AbortController | null>(null);
  const perform = useCallback(async (payload?: RuntimeValues) => {
    if (owner.current !== null) return;
    const controller = new AbortController();
    owner.current = controller;
    const current = () => owner.current === controller && !controller.signal.aborted;
    const saving = payload !== undefined;
    const failed = (message: string) => {
      setView((previous) => ({
        ...previous,
        phase: saving ? 'ready' : 'failure',
        error: message,
        message: '',
      }));
    };
    setView((previous) => ({
      ...previous,
      phase: saving ? 'saving' : 'loading',
      error: '',
      message: '',
    }));
    try {
      const response = await requestRuntime(controller.signal, payload);
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        setView({ ...INITIAL, phase: 'denied', error: '无权限' });
        if (response.status === 401) window.location.assign('/_platform/login');
        return;
      }
      if (response.status !== 200) {
        failed(
          saving && response.status === 400
            ? invalidMessage(response.body)
            : saving
              ? FAILURE
              : '运行参数加载失败，请重试。',
        );
        return;
      }
      setView({
        phase: 'ready',
        ...readRuntime(response.body, saving),
        error: '',
        message: saving ? '已保存运行参数。' : '',
      });
    } catch {
      if (current()) failed(saving ? FAILURE : '运行参数加载失败，请重试。');
    } finally {
      if (current()) owner.current = null;
    }
  }, []);
  useEffect(() => {
    void perform();
    return () => {
      owner.current?.abort();
      owner.current = null;
    };
  }, [perform]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner.current !== null || view.draft === null) return;
    const payload = {
      idleMinutes: Number(view.draft.idleMinutes),
      cpuCores: Number(view.draft.cpuCores),
      memoryMiB: Number(view.draft.memoryMiB),
      maxRunningInstances: Number(view.draft.maxRunningInstances),
      defaultPermissionTier: view.draft.defaultPermissionTier,
    };
    try {
      readRuntime(payload, false);
    } catch {
      setView((previous) => ({ ...previous, error: INVALID, message: '' }));
      return;
    }
    void perform(payload);
  }
  function change(name: keyof Draft, value: string) {
    setView((previous) =>
      previous.draft === null || previous.phase !== 'ready'
        ? previous
        : { ...previous, draft: { ...previous.draft, [name]: value } },
    );
  }
  return (
    <main className="admin">
      <h1>运行参数</h1>
      <AdminNavigation page="runtime" />
      <p id="runtime-status" role={view.error ? 'alert' : 'status'}>
        {view.phase === 'loading'
          ? '加载中…'
          : view.phase === 'saving'
            ? '正在保存…'
            : view.error || view.message}
      </p>
      {view.phase === 'failure' && (
        <button
          onClick={() => {
            void perform();
          }}
        >
          重试
        </button>
      )}
      {view.draft !== null && (
        <RuntimeForm
          draft={view.draft}
          busy={view.phase === 'saving'}
          submit={submit}
          change={change}
        />
      )}
      {view.count !== null && <p>保存时运行中的实例数：{view.count}（非实时统计）。</p>}
    </main>
  );
}

function RuntimeForm({
  draft,
  busy,
  submit,
  change,
}: {
  draft: Draft;
  busy: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  change: (name: keyof Draft, value: string) => void;
}) {
  return (
    <form
      aria-label="运行参数"
      aria-describedby="runtime-status"
      aria-busy={busy}
      onSubmit={submit}
    >
      <fieldset disabled={busy}>
        <legend>实例运行参数</legend>
        {NUMBERS.map((field) => (
          <div key={field.name}>
            <label htmlFor={`runtime-${field.name}`}>{field.label}</label>
            <input
              id={`runtime-${field.name}`}
              type="number"
              required
              min={field.integer ? 1 : 0}
              max={field.integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE}
              step={field.integer ? 1 : 'any'}
              value={draft[field.name]}
              aria-describedby={`runtime-${field.name}-hint`}
              onChange={(event) => {
                change(field.name, event.currentTarget.value);
              }}
            />
            <small id={`runtime-${field.name}-hint`}>
              {field.integer ? '1–9007199254740991 的整数' : '大于 0 的有限数，支持小数核数'}
            </small>
          </div>
        ))}
        <label htmlFor="runtime-tier">默认权限档</label>
        <select
          id="runtime-tier"
          value={draft.defaultPermissionTier}
          onChange={(event) => {
            change('defaultPermissionTier', event.currentTarget.value);
          }}
        >
          {TIERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <p>同时运行上限还受已配置子网池容量限制。</p>
        <p>
          CPU、内存和默认权限档在下次启动实例时应用；同时运行上限用于后续启动准入，空闲分钟数用于后续空闲检查。保存不会重启实例。
        </p>
        <button type="submit">保存运行参数</button>
      </fieldset>
    </form>
  );
}

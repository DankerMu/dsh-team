import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

interface ModelRow {
  name: string;
  contextWindow: string;
}
interface ModelDraft {
  baseURL: string;
  apiKeyConfigured: boolean;
  models: ModelRow[];
  defaultModel: string;
}
type Action = 'load' | 'save' | 'restart';
type Phase = Action | 'ready' | 'failure' | 'denied';
const API = '/_platform/api/admin/model-config';
const EMPTY: ModelDraft = { baseURL: '', apiKeyConfigured: false, models: [], defaultModel: '' };
const FAILURE = {
  load: '模型配置加载失败，请重试。',
  save: '保存失败，配置可能已变更；请重新打开页面核对后再试。',
  restart: '重启请求失败，部分实例可能已处理；请检查实例状态后再试。',
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid configuration response');
  // The runtime object/array check establishes a JSON object, but not its field domains.
  return value as Record<string, unknown>;
}
function saveCount(value: unknown, baseURL: string, defaultModel: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    baseURL.trim() === '' ||
    defaultModel.trim() === ''
  )
    throw new Error('Invalid save response');
  return value;
}
function readConfiguration(value: unknown, saved: boolean) {
  const body = object(value);
  const allowed = [
    'baseURL',
    'apiKeyConfigured',
    'models',
    'defaultModel',
    ...(saved ? ['runningInstances'] : []),
  ];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    typeof body.baseURL !== 'string' ||
    typeof body.apiKeyConfigured !== 'boolean' ||
    typeof body.defaultModel !== 'string' ||
    !Array.isArray(body.models)
  )
    throw new Error('Invalid configuration response');
  const models = body.models.map((value: unknown): ModelRow => {
    const model = object(value);
    if (
      typeof model.name !== 'string' ||
      model.name.trim() === '' ||
      Object.keys(model).some((key) => key !== 'name' && key !== 'contextWindow') ||
      (model.contextWindow !== undefined &&
        (typeof model.contextWindow !== 'number' ||
          !Number.isSafeInteger(model.contextWindow) ||
          model.contextWindow < 1))
    )
      throw new Error('Invalid model response');
    return {
      name: model.name,
      contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
    };
  });
  const count = saved ? saveCount(body.runningInstances, body.baseURL, body.defaultModel) : null;
  if (body.defaultModel !== '' && !models.some((model) => model.name === body.defaultModel))
    throw new Error('Invalid save response');
  return {
    draft: {
      baseURL: body.baseURL,
      apiKeyConfigured: body.apiKeyConfigured,
      models: models.length ? models : [{ name: '', contextWindow: '' }],
      defaultModel: body.defaultModel,
    },
    count,
  };
}
function validation(draft: ModelDraft, key: string): string {
  if (draft.baseURL.trim() === '') return '请输入模型地址。';
  if (draft.models.length === 0 || draft.models.some((model) => model.name.trim() === ''))
    return '请填写每个模型的名称。';
  if (
    draft.models.some(
      (model) =>
        model.contextWindow !== '' &&
        (!Number.isSafeInteger(Number(model.contextWindow)) || Number(model.contextWindow) < 1),
    )
  )
    return '上下文窗口须为 1–9007199254740991 的整数，或留空。';
  if (!draft.models.some((model) => model.name === draft.defaultModel))
    return '请选择清单内的默认模型。';
  if (key !== '' && key.trim() === '') return '密钥不能只包含空白字符。';
  return '';
}
function restartMessage(value: unknown): string {
  const body = object(value);
  if (!Array.isArray(body.items)) throw new Error('Invalid restart response');
  let notStarted = 0;
  for (const value of body.items) {
    const item = object(value);
    if (
      typeof item.userId !== 'string' ||
      typeof item.status !== 'string' ||
      !['running', 'starting', 'stopped', 'full', 'error', 'unconfigured'].includes(item.status) ||
      item.reason !== (item.status === 'running' ? null : item.status)
    )
      throw new Error('Invalid restart admission');
    if (item.status !== 'running' && item.status !== 'starting') notStarted++;
  }
  if (body.items.length === 0) return '当前没有运行中的实例需要重启。';
  if (notStarted > 0)
    return `已处理 ${String(body.items.length)} 个实例，其中 ${String(notStarted)} 个未能开始启动；请检查实例状态。`;
  return `已提交 ${String(body.items.length)} 个实例重启，启动可能仍在进行中。`;
}

async function requestConfiguration(
  action: Action,
  signal: AbortSignal,
  payload?: Record<string, unknown>,
) {
  const response = await fetch(
    action === 'restart' ? '/_platform/api/admin/instances/restart-running' : API,
    {
      method: action === 'load' ? 'GET' : action === 'save' ? 'PUT' : 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    },
  );
  try {
    const body: unknown =
      response.status === 200 ? await response.json() : await response.arrayBuffer();
    return { status: response.status, body, readable: true };
  } catch {
    return { status: response.status, body: undefined, readable: false };
  }
}
function useModelEditor() {
  const [draft, setDraft] = useState<ModelDraft>(EMPTY);
  const [key, setKey] = useState('');
  const [phase, setPhase] = useState<Phase>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const owner = useRef<AbortController | null>(null);
  const pending = useRef(false);

  const perform = useCallback(async (action: Action, payload?: Record<string, unknown>) => {
    if (pending.current) return;
    pending.current = true;
    owner.current?.abort();
    const controller = new AbortController();
    owner.current = controller;
    const current = () => owner.current === controller && !controller.signal.aborted;
    setPhase(action);
    setError('');
    setMessage('');
    setKey('');
    if (action === 'load') setCount(null);
    const deny = (status: number) => {
      if (status !== 401 && status !== 403) return false;
      setDraft(EMPTY);
      setKey('');
      setCount(null);
      setConfirmation(false);
      setPhase('denied');
      if (status === 401) window.location.assign('/_platform/login');
      return true;
    };
    const fail = (message: string) => {
      setError(message);
      setPhase(action === 'load' ? 'failure' : 'ready');
    };
    try {
      const response = await requestConfiguration(action, controller.signal, payload);
      if (!current() || deny(response.status)) return;
      if (!response.readable) throw new Error('Unreadable response');
      if (response.status !== 200) {
        fail(
          action === 'save' && response.status === 400
            ? '请检查模型地址、名称、默认模型和上下文窗口大小。'
            : FAILURE[action],
        );
        return;
      }
      if (action === 'restart') setMessage(restartMessage(response.body));
      else {
        const result = readConfiguration(response.body, action === 'save');
        setDraft(result.draft);
        setCount(result.count);
        if (action === 'save') setMessage('已保存，下次启动实例时生效。');
      }
      setPhase('ready');
    } catch {
      if (current()) {
        fail(FAILURE[action]);
      }
    } finally {
      if (current()) {
        pending.current = false;
        setConfirmation(false);
      }
    }
  }, []);
  useEffect(() => {
    void perform('load');
    return () => {
      owner.current?.abort();
      owner.current = null;
      pending.current = false;
    };
  }, [perform]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending.current) return;
    const problem = validation(draft, key);
    if (problem !== '') {
      setError(problem);
      return;
    }
    void perform('save', {
      baseURL: draft.baseURL,
      models: draft.models.map((model) => ({
        name: model.name,
        ...(model.contextWindow === '' ? {} : { contextWindow: Number(model.contextWindow) }),
      })),
      defaultModel: draft.defaultModel,
      ...(key === '' ? {} : { apiKey: key }),
    });
  }
  function changeModels(update: (models: ModelRow[]) => ModelRow[]): void {
    setDraft((current) => {
      const models = update(current.models);
      return {
        ...current,
        models,
        defaultModel: models.some((model) => model.name === current.defaultModel)
          ? current.defaultModel
          : '',
      };
    });
  }
  const busy = phase === 'load' || phase === 'save' || phase === 'restart';
  const visible = phase === 'ready' || phase === 'save' || phase === 'restart';
  return {
    draft,
    setDraft,
    key,
    setKey,
    phase,
    error,
    message,
    count,
    confirmation,
    setConfirmation,
    perform,
    submit,
    changeModels,
    busy,
    visible,
  };
}

export function ModelPage() {
  const editor = useModelEditor();
  const { phase, error, message, count, confirmation, setConfirmation, perform, busy, visible } =
    editor;
  return (
    <main className="admin">
      <h1>模型配置</h1>
      <AdminNavigation page="models" />
      <p id="model-status" role={error !== '' || phase === 'denied' ? 'alert' : 'status'}>
        {phase === 'denied'
          ? '无权限'
          : phase === 'load'
            ? '加载中…'
            : phase === 'save'
              ? '正在保存…'
              : phase === 'restart'
                ? '正在请求重启…'
                : error || message}
      </p>
      {phase === 'failure' && (
        <button
          onClick={() => {
            void perform('load');
          }}
        >
          重试
        </button>
      )}
      {visible && (
        <>
          <ModelForm editor={editor} />
          {count !== null && (
            <section>
              <p>保存时有 {count} 个运行中的实例保持原启动配置；此数量不是实时统计。</p>
              <button
                disabled={busy}
                onClick={() => {
                  setConfirmation(true);
                }}
              >
                重启全部运行中的实例
              </button>
            </section>
          )}
          {confirmation && (
            <dialog open aria-labelledby="model-restart-title">
              <h2 id="model-restart-title">确认重启运行中的实例</h2>
              <p>将重启操作开始时正在运行的实例，正在执行的任务可能中断。</p>
              <button
                disabled={busy}
                onClick={() => {
                  void perform('restart', {});
                }}
              >
                确认重启
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setConfirmation(false);
                }}
              >
                取消
              </button>
            </dialog>
          )}
        </>
      )}
    </main>
  );
}

function ModelForm({ editor }: { editor: ReturnType<typeof useModelEditor> }) {
  const { draft, setDraft, key, setKey, submit, changeModels, busy } = editor;
  return (
    <form aria-label="模型配置" aria-describedby="model-status" aria-busy={busy} onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>模型服务</legend>
        <label htmlFor="model-base-url">模型地址</label>
        <input
          id="model-base-url"
          value={draft.baseURL}
          required
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => ({ ...current, baseURL: value }));
          }}
        />
        <label htmlFor="model-key">密钥</label>
        <input
          id="model-key"
          type="password"
          autoComplete="new-password"
          value={key}
          onChange={(event) => {
            setKey(event.currentTarget.value);
          }}
          aria-describedby="model-key-state"
        />
        <span id="model-key-state">{draft.apiKeyConfigured ? '已设置' : '未设置'}</span>
        <small>留空保留原密钥。</small>
        {draft.models.map((model, index) => (
          <fieldset key={index}>
            <legend>模型 {index + 1}</legend>
            <label htmlFor={`model-name-${String(index)}`}>模型名称 {index + 1}</label>
            <input
              id={`model-name-${String(index)}`}
              value={model.name}
              required
              onChange={(event) => {
                const name = event.currentTarget.value;
                changeModels((models) =>
                  models.map((row, at) => (at === index ? { ...row, name } : row)),
                );
              }}
            />
            <label htmlFor={`model-context-${String(index)}`}>上下文窗口 {index + 1}</label>
            <input
              id={`model-context-${String(index)}`}
              type="number"
              min="1"
              max="9007199254740991"
              step="1"
              value={model.contextWindow}
              onChange={(event) => {
                const contextWindow = event.currentTarget.value;
                changeModels((models) =>
                  models.map((row, at) => (at === index ? { ...row, contextWindow } : row)),
                );
              }}
            />
            <button
              type="button"
              onClick={() => {
                changeModels((models) => models.filter((_row, at) => at !== index));
              }}
            >
              删除模型 {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() => {
            changeModels((models) => [...models, { name: '', contextWindow: '' }]);
          }}
        >
          添加模型
        </button>
        <label htmlFor="model-default">默认模型</label>
        <select
          id="model-default"
          value={draft.defaultModel}
          required
          onChange={(event) => {
            const defaultModel = event.currentTarget.value;
            setDraft((current) => ({ ...current, defaultModel }));
          }}
        >
          <option value="">选择默认模型</option>
          {draft.models
            .filter((model) => model.name.trim() !== '')
            .map((model, index) => (
              <option key={index} value={model.name}>
                {model.name}
              </option>
            ))}
        </select>
        <button type="submit">保存配置</button>
      </fieldset>
    </form>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';
import { adminRequest } from './admin-request.ts';
import { useRequestOwner } from './request-owner.ts';

type Section = 'connection' | 'retrieval';
type Action = 'load' | Section | 'test';
interface Connection {
  baseURL: string;
  apiKeyConfigured: boolean;
}
/** Form text exactly as typed; numbers are converted only when a save is sent. */
interface Retrieval {
  topK: string;
  threshold: string;
  weight: string;
  rerankId: string;
}
interface Drafts {
  connection: Connection;
  retrieval: Retrieval;
}
interface View {
  phase: Action | 'ready' | 'failure' | 'denied';
  drafts: Drafts | null;
  notice: { text: string; alert: boolean } | null;
}
/** A settled request either denies the page or yields the next view. */
type Outcome = 401 | 403 | ((previous: View) => View);

const API = {
  connection: '/_platform/api/admin/ragflow-config',
  retrieval: '/_platform/api/admin/retrieval-config',
  test: '/_platform/api/admin/ragflow-config/test',
} as const;
const HINT = '保存即生效：平台之后的每次知识库请求都使用新配置，不需要重启实例。';
const LOAD_FAILURE = '知识库配置加载失败，请重试。';
const SAVE_FAILURE = '保存失败，请重试。';
const TEST_FAILURE = '连接测试请求失败，请重试。';
const INVALID: Record<Section, string> = {
  connection:
    'RAGFlow 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。',
  retrieval:
    '检索参数无效：返回片段数为 1–100 的整数，相似度阈值和关键词权重为 0–1 之间的数，重排模型 ID 前后不能有空白。',
};
const STATUS: Record<View['phase'], string> = {
  load: '加载中…',
  connection: '正在保存…',
  retrieval: '正在保存…',
  test: '正在测试连接…',
  ready: '',
  failure: LOAD_FAILURE,
  denied: '无权限',
};
const TEST_RESULTS: Readonly<Record<string, string>> = {
  'not-configured': '未配置 RAGFlow 地址或密钥，或密钥被拒绝',
  unavailable: '无法连接到 RAGFlow 地址',
  timeout: '连接 RAGFlow 超时',
  'upstream-error': 'RAGFlow 返回了异常结果',
};
const VERSION = /^[\x20-\x7e]{1,64}$/u;
const CONNECTION_FIELDS = ['baseURL', 'apiKeyConfigured'];
const RETRIEVAL_FIELDS = [
  'retrievalTopK',
  'retrievalSimilarityThreshold',
  'retrievalKeywordsWeight',
  'retrievalRerankId',
];
const NUMBERS = [
  { name: 'topK', id: 'retrieval-top-k', label: '返回片段数', min: 1, max: 100, step: '1' },
  {
    name: 'threshold',
    id: 'retrieval-threshold',
    label: '相似度阈值',
    min: 0,
    max: 1,
    step: 'any',
  },
  { name: 'weight', id: 'retrieval-weight', label: '关键词权重', min: 0, max: 1, step: 'any' },
] as const;
const INITIAL: View = { phase: 'load', drafts: null, notice: null };
const DENIED: View = { phase: 'denied', drafts: null, notice: null };

/** A JSON object with exactly these keys (plus the save count when saved); values are the caller's. */
function exactly(value: unknown, keys: readonly string[], saved = false): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid knowledge-base response');
  // The runtime object/array check establishes a JSON object, but not its field domains.
  const body = value as Record<string, unknown>;
  const expected = saved ? [...keys, 'runningInstances'] : keys;
  if (
    Object.keys(body).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(body, key))
  )
    throw new Error('Invalid knowledge-base fields');
  const count = body.runningInstances;
  // The count is validated but not shown: these settings apply without restarting instances.
  if (saved && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))
    throw new Error('Invalid running count');
  return body;
}
function readConnection(value: unknown, saved: boolean): Connection {
  const body = exactly(value, CONNECTION_FIELDS, saved);
  if (typeof body.baseURL !== 'string' || typeof body.apiKeyConfigured !== 'boolean')
    throw new Error('Invalid RAGFlow connection');
  return { baseURL: body.baseURL, apiKeyConfigured: body.apiKeyConfigured };
}
function readRetrieval(value: unknown, saved: boolean): Retrieval {
  const body = exactly(value, RETRIEVAL_FIELDS, saved);
  const topK = body.retrievalTopK;
  const threshold = body.retrievalSimilarityThreshold;
  const weight = body.retrievalKeywordsWeight;
  const rerankId = body.retrievalRerankId;
  if (
    typeof topK !== 'number' ||
    typeof threshold !== 'number' ||
    typeof weight !== 'number' ||
    typeof rerankId !== 'string'
  )
    throw new Error('Invalid retrieval parameters');
  return { topK: String(topK), threshold: String(threshold), weight: String(weight), rerankId };
}
/** Validates a connection-test 200 body and returns its fixed Chinese explanation. */
function testMessage(value: unknown): { ok: boolean; text: string } {
  const result =
    typeof value === 'object' && value !== null && 'result' in value ? value.result : undefined;
  if (result === 'ok') {
    const { version } = exactly(value, ['result', 'version']);
    if (typeof version !== 'string' || !VERSION.test(version))
      throw new Error('Invalid RAGFlow version');
    return { ok: true, text: `连接成功，RAGFlow 版本：${version}` };
  }
  exactly(value, ['result']);
  // Own keys only: inherited names such as __proto__ or constructor are not results.
  if (typeof result !== 'string' || !Object.hasOwn(TEST_RESULTS, result))
    throw new Error('Invalid connection test result');
  return { ok: false, text: TEST_RESULTS[result] ?? '' };
}
/** A typed number, or null for an empty or non-finite input. */
function numeric(value: string): number | null {
  const number = Number(value);
  return value.trim() === '' || !Number.isFinite(number) ? null : number;
}

function denial(status: number): 401 | 403 | null {
  return status === 401 || status === 403 ? status : null;
}
function settled(notice: View['notice']) {
  return (previous: View): View => ({ ...previous, phase: 'ready', notice });
}
async function load(signal: AbortSignal): Promise<Outcome> {
  // Both reads settle, bodies included, before any decision or navigation.
  const [connection, retrieval] = await Promise.all([
    adminRequest(API.connection, signal, 'GET'),
    adminRequest(API.retrieval, signal, 'GET'),
  ]);
  const statuses = [connection.status, retrieval.status];
  if (statuses.includes(401)) return 401;
  if (statuses.includes(403)) return 403;
  try {
    if (statuses.some((status) => status !== 200)) throw new Error('Unexpected status');
    const drafts: Drafts = {
      connection: readConnection(connection.body, false),
      retrieval: readRetrieval(retrieval.body, false),
    };
    return () => ({ phase: 'ready', drafts, notice: null });
  } catch {
    return () => ({ ...INITIAL, phase: 'failure' });
  }
}
async function save(section: Section, payload: unknown, signal: AbortSignal): Promise<Outcome> {
  const result = await adminRequest(API[section], signal, 'PUT', payload);
  const denied = denial(result.status);
  if (denied !== null) return denied;
  if (result.status === 400) return settled({ text: INVALID[section], alert: true });
  try {
    if (result.status !== 200) throw new Error('Unexpected status');
    // Only this section's draft takes the saved answer; the other keeps unsaved edits.
    const patch =
      section === 'connection'
        ? { connection: readConnection(result.body, true) }
        : { retrieval: readRetrieval(result.body, true) };
    return (previous) =>
      previous.drafts === null
        ? previous
        : {
            phase: 'ready',
            drafts: { ...previous.drafts, ...patch },
            notice: { text: '已保存，立即生效。', alert: false },
          };
  } catch {
    return settled({ text: SAVE_FAILURE, alert: true });
  }
}
async function test(signal: AbortSignal): Promise<Outcome> {
  const result = await adminRequest(API.test, signal, 'POST', {});
  const denied = denial(result.status);
  if (denied !== null) return denied;
  try {
    if (result.status !== 200) throw new Error('Unexpected status');
    const { ok, text } = testMessage(result.body);
    return settled({ text, alert: !ok });
  } catch {
    return settled({ text: TEST_FAILURE, alert: true });
  }
}

function useKnowledgeBase() {
  const [view, setView] = useState<View>(INITIAL);
  const [key, setKey] = useState('');
  const owner = useRequestOwner();
  const perform = useCallback(async (action: Action, payload?: unknown) => {
    // One page-level owner: no load, save or test starts while another is in flight.
    const claim = owner.claim();
    if (claim === null) return;
    // A connection test uses saved values only; every load and save clears the typed key.
    if (action !== 'test') setKey('');
    setView((previous) =>
      action === 'load' ? INITIAL : { ...previous, phase: action, notice: null },
    );
    try {
      const outcome =
        action === 'load'
          ? await load(claim.signal)
          : action === 'test'
            ? await test(claim.signal)
            : await save(action, payload, claim.signal);
      if (!claim.current()) return;
      if (typeof outcome === 'function') setView(outcome);
      else {
        setKey('');
        setView(DENIED);
        if (outcome === 401) window.location.assign('/_platform/login');
      }
    } finally {
      claim.release();
    }
  }, []);
  useEffect(() => {
    void perform('load');
  }, [perform]);
  const reject = (text: string) => {
    setView((previous) => ({ ...previous, notice: { text, alert: true } }));
  };
  function saveConnection(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (owner.busy() || view.drafts === null) return;
    const { baseURL } = view.drafts.connection;
    if (baseURL === '') reject('请输入 RAGFlow 地址。');
    else if (key !== '' && key.trim() === '') reject('密钥不能只包含空白字符。');
    // The address is sent verbatim: the server's address rule is the only implementation.
    else void perform('connection', key === '' ? { baseURL } : { baseURL, apiKey: key });
  }
  function saveRetrieval(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (owner.busy() || view.drafts === null) return;
    const { topK, threshold, weight, rerankId } = view.drafts.retrieval;
    const [retrievalTopK, retrievalSimilarityThreshold, retrievalKeywordsWeight] = [
      topK,
      threshold,
      weight,
    ].map(numeric);
    if (
      retrievalTopK == null ||
      retrievalSimilarityThreshold == null ||
      retrievalKeywordsWeight == null
    )
      reject(INVALID.retrieval);
    // Range checks and the rerank ID's whitespace rule belong to the server's 400.
    else
      void perform('retrieval', {
        retrievalTopK,
        retrievalSimilarityThreshold,
        retrievalKeywordsWeight,
        retrievalRerankId: rerankId,
      });
  }
  function edit(update: (drafts: Drafts) => Drafts): void {
    setView((previous) =>
      previous.drafts === null ? previous : { ...previous, drafts: update(previous.drafts) },
    );
  }
  return { view, key, setKey, perform, saveConnection, saveRetrieval, edit };
}
type Editor = ReturnType<typeof useKnowledgeBase>;

export function KnowledgeBasePage() {
  const editor = useKnowledgeBase();
  const { view, perform } = editor;
  const alert = view.phase === 'failure' || view.phase === 'denied' || view.notice?.alert === true;
  return (
    <main className="admin">
      <AdminNavigation page="knowledge-base" />
      <div className="admin-content">
        <h1>知识库</h1>
        <p id="knowledge-base-status" role={alert ? 'alert' : 'status'}>
          {view.phase === 'ready' ? (view.notice?.text ?? '') : STATUS[view.phase]}
        </p>
        {view.phase === 'failure' && (
          <button
            onClick={() => {
              void perform('load');
            }}
          >
            重试
          </button>
        )}
        {view.drafts !== null && <KnowledgeBaseForms editor={editor} drafts={view.drafts} />}
      </div>
    </main>
  );
}

function KnowledgeBaseForms({ editor, drafts }: { editor: Editor; drafts: Drafts }) {
  const { view, perform, saveRetrieval, edit } = editor;
  const busy = view.phase !== 'ready';
  return (
    <>
      <p>{HINT}</p>
      <ConnectionForm editor={editor} connection={drafts.connection} busy={busy} />
      <div className="model-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void perform('test');
          }}
        >
          测试连接
        </button>
        <small>测试使用上次保存的配置，未保存的修改不参与</small>
      </div>
      <form
        className="plugins-form"
        aria-label="检索参数"
        aria-describedby="knowledge-base-status"
        aria-busy={busy}
        noValidate
        onSubmit={saveRetrieval}
      >
        <fieldset disabled={busy}>
          <legend>检索参数</legend>
          {NUMBERS.map((number) => (
            <div key={number.name} className="field">
              <label htmlFor={number.id}>{number.label}</label>
              <input
                id={number.id}
                type="number"
                min={number.min}
                max={number.max}
                step={number.step}
                value={drafts.retrieval[number.name]}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  edit((current) => ({
                    ...current,
                    retrieval: { ...current.retrieval, [number.name]: value },
                  }));
                }}
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="retrieval-rerank-id">重排模型 ID</label>
            <input
              id="retrieval-rerank-id"
              value={drafts.retrieval.rerankId}
              aria-describedby="retrieval-rerank-id-help"
              onChange={(event) => {
                const rerankId = event.currentTarget.value;
                edit((current) => ({ ...current, retrieval: { ...current.retrieval, rerankId } }));
              }}
            />
            <small id="retrieval-rerank-id-help">留空即不启用重排序</small>
          </div>
          <button type="submit">保存检索参数</button>
        </fieldset>
      </form>
    </>
  );
}

function ConnectionForm({
  editor,
  connection,
  busy,
}: {
  editor: Editor;
  connection: Connection;
  busy: boolean;
}) {
  const { key, setKey, saveConnection, edit } = editor;
  return (
    <form
      className="plugins-form"
      aria-label="RAGFlow 连接"
      aria-describedby="knowledge-base-status"
      aria-busy={busy}
      onSubmit={saveConnection}
    >
      <fieldset disabled={busy}>
        <legend>连接配置</legend>
        <div className="field">
          <label htmlFor="ragflow-base-url">RAGFlow 地址</label>
          <input
            id="ragflow-base-url"
            value={connection.baseURL}
            aria-describedby="ragflow-base-url-help"
            onChange={(event) => {
              const baseURL = event.currentTarget.value;
              edit((current) => ({ ...current, connection: { ...current.connection, baseURL } }));
            }}
          />
          <small id="ragflow-base-url-help">
            RAGFlow 服务的根地址，例如 http://ragflow.intranet:9380；平台会在其后拼接 /api/v1/…
          </small>
        </div>
        <div className="field">
          <label htmlFor="ragflow-key">密钥</label>
          <input
            id="ragflow-key"
            type="password"
            autoComplete="new-password"
            value={key}
            aria-describedby="ragflow-key-state"
            onChange={(event) => {
              setKey(event.currentTarget.value);
            }}
          />
          <span id="ragflow-key-state" className="key-state">
            {connection.apiKeyConfigured ? '已配置' : '未配置'}
          </span>
          <small>留空保留原密钥。</small>
        </div>
        <button type="submit">保存连接配置</button>
      </fieldset>
    </form>
  );
}

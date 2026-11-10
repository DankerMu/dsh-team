import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';
import { adminRequest } from './admin-request.ts';
import { useRequestOwner } from './request-owner.ts';

/** The administrator Document Server answer; the bundled container name and JWT never appear. */
interface Office {
  mode: 'bundled' | 'external';
  bundledConfigured: boolean;
  url: string;
  jwtConfigured: boolean;
}
interface View {
  phase: 'load' | 'save' | 'ready' | 'failure' | 'denied';
  office: Office | null;
  /** The address box exactly as typed; it is sent verbatim. */
  address: string;
  notice: { text: string; alert: boolean } | null;
  /** Running instances when the last successful save committed. */
  count: number | null;
}
/** A settled request either leaves the page or yields its next view. */
type Settled = 'login' | 'denied' | ((previous: View) => View);

const API = '/_platform/api/admin/document-server';
const FIELDS = ['mode', 'bundledConfigured', 'url', 'jwtConfigured'];
const PAIRING = 'External Document Server requires jwtSecret';
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const SAVED = '已保存，实例下次启动时生效。';
const SAVE_FAILED = '保存失败，请重试。';
const FIRST_SWITCH = '首次切换到外部 Document Server 时必须填写 JWT。';
const ADDRESS_INVALID =
  'Document Server 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。';
const RESET_NOTE = '切回自带会清除已保存的外部地址和 JWT。';
const PHASE_TEXT: Record<Exclude<View['phase'], 'ready'>, string> = {
  load: '加载中…',
  save: '正在保存…',
  failure: 'Office 配置加载失败，请重试。',
  denied: '无权限',
};
const INITIAL: View = { phase: 'load', office: null, address: '', notice: null, count: null };
const DENIED: View = { ...INITIAL, phase: 'denied' };

function savedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid running count');
  return value;
}
/** Exactly the four answer fields, plus the save count on a PUT answer; anything else fails. */
function readOffice(value: unknown, saved: boolean): { office: Office; count: number | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Document Server answer');
  // The runtime object/array check establishes a JSON object, but not its field domains.
  const body = value as Record<string, unknown>;
  const keys = saved ? [...FIELDS, 'runningInstances'] : FIELDS;
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key)))
    throw new Error('Invalid Document Server fields');
  const { mode, bundledConfigured, url, jwtConfigured } = body;
  if (
    (mode !== 'bundled' && mode !== 'external') ||
    typeof bundledConfigured !== 'boolean' ||
    typeof url !== 'string' ||
    typeof jwtConfigured !== 'boolean'
  )
    throw new Error('Invalid Document Server values');
  const count = saved ? savedCount(body.runningInstances) : null;
  return { office: { mode, bundledConfigured, url, jwtConfigured }, count };
}
/** A 400 names the stale first-switch pairing rule only by its exact message; all else is the address. */
function rejectionText(body: unknown): string {
  try {
    // adminRequest reads a non-200 body as an ArrayBuffer, or leaves it undefined when unreadable;
    // both decode (to '' at worst), and anything that is not exactly the pairing message is the address.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body as ArrayBuffer | undefined));
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed)
      return parsed.message === PAIRING ? FIRST_SWITCH : ADDRESS_INVALID;
  } catch {
    // An empty, non-JSON or non-buffer body is an ordinary address rejection.
  }
  return ADDRESS_INVALID;
}
function alerting(text: string) {
  return (previous: View): View => ({ ...previous, phase: 'ready', notice: { text, alert: true } });
}
/** One GET (no payload) or PUT; every body is read before the page decides anything. */
async function exchange(payload: unknown, signal: AbortSignal): Promise<Settled> {
  const saving = payload !== undefined;
  const result = await adminRequest(API, signal, saving ? 'PUT' : 'GET', payload);
  if (result.status === 401) return 'login';
  if (result.status === 403) return 'denied';
  if (saving && result.status === 400) return alerting(rejectionText(result.body));
  try {
    if (result.status !== 200) throw new Error('Unexpected status');
    const { office, count } = readOffice(result.body, saving);
    const notice = saving ? { text: SAVED, alert: false } : null;
    // The whole view, address box included, follows the answer.
    return () => ({ phase: 'ready', office, address: office.url, notice, count });
  } catch {
    return saving ? alerting(SAVE_FAILED) : () => ({ ...INITIAL, phase: 'failure' });
  }
}

function useOffice() {
  const [view, setView] = useState<View>(INITIAL);
  const [jwt, setJwt] = useState('');
  const owner = useRequestOwner();
  const run = useCallback(async (payload?: unknown) => {
    // One page-level owner: no load or save starts while another is in flight.
    const claim = owner.claim();
    if (claim === null) return;
    // Every load and save clears the typed JWT.
    setJwt('');
    setView((previous) =>
      payload === undefined ? INITIAL : { ...previous, phase: 'save', notice: null, count: null },
    );
    try {
      const settled = await exchange(payload, claim.signal);
      // A response for an aborted (departed) owner never touches the page.
      if (!claim.current()) return;
      if (typeof settled === 'function') setView(settled);
      else {
        setJwt('');
        setView(DENIED);
        if (settled === 'login') window.location.assign('/_platform/login');
      }
    } finally {
      claim.release();
    }
  }, []);
  useEffect(() => {
    void run();
  }, [run]);
  function saveExternal(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (owner.busy() || view.office === null) return;
    const url = view.address;
    const reject = (text: string) => {
      setView((previous) => ({ ...previous, notice: { text, alert: true } }));
    };
    if (url === '') reject('请输入 Document Server 地址。');
    else if (jwt !== '' && jwt.trim() === '') reject('JWT 不能只包含空白字符。');
    else if (jwt === '' && !view.office.jwtConfigured) reject(FIRST_SWITCH);
    // The address rule belongs to the server; the address is sent exactly as typed.
    else
      void run(jwt === '' ? { mode: 'external', url } : { mode: 'external', url, jwtSecret: jwt });
  }
  function editAddress(address: string): void {
    setView((previous) => ({ ...previous, address }));
  }
  return { view, jwt, setJwt, run, saveExternal, editAddress };
}
type Controls = ReturnType<typeof useOffice>;

export function OfficePage() {
  const controls = useOffice();
  const { view, run } = controls;
  const alert = view.phase === 'failure' || view.phase === 'denied' || view.notice?.alert === true;
  return (
    <main className="admin">
      <AdminNavigation page="office" />
      <div className="admin-content">
        <h1>Office</h1>
        <p id="office-status" role={alert ? 'alert' : 'status'}>
          {view.phase === 'ready' ? (view.notice?.text ?? '') : PHASE_TEXT[view.phase]}
        </p>
        {view.count !== null && <p>保存时运行中的实例数：{view.count}（非实时统计）。</p>}
        {view.phase === 'failure' && (
          <button
            onClick={() => {
              void run();
            }}
          >
            重试
          </button>
        )}
        {view.office !== null && <OfficeSettings controls={controls} office={view.office} />}
      </div>
    </main>
  );
}

function OfficeSettings({ controls, office }: { controls: Controls; office: Office }) {
  const { view, jwt, setJwt, run, saveExternal, editAddress } = controls;
  const busy = view.phase !== 'ready';
  const external = office.mode === 'external';
  return (
    <>
      <p>{HINT}</p>
      <section aria-label="当前 Office 配置">
        <p>{external ? '当前使用：外部 Document Server' : '当前使用：自带 Document Server'}</p>
        {external ? (
          <>
            <p>{office.url}</p>
            <p>{office.jwtConfigured ? 'JWT：已配置' : 'JWT：未配置'}</p>
          </>
        ) : office.bundledConfigured ? (
          <p>自带 Document Server：已配置</p>
        ) : (
          <p role="alert">自带 Document Server：未配置，Office 不可用</p>
        )}
      </section>
      <form
        className="plugins-form"
        aria-label="外部 Document Server"
        aria-describedby="office-status"
        aria-busy={busy}
        onSubmit={saveExternal}
      >
        <fieldset disabled={busy}>
          <legend>外部 Document Server</legend>
          <div className="field">
            <label htmlFor="office-url">Document Server 地址</label>
            <input
              id="office-url"
              value={view.address}
              aria-describedby="office-url-help"
              onChange={(event) => {
                editAddress(event.currentTarget.value);
              }}
            />
            <small id="office-url-help">
              外部 Document Server 的根地址，例如 https://office.intranet
            </small>
          </div>
          <div className="field">
            <label htmlFor="office-jwt">JWT</label>
            <input
              id="office-jwt"
              type="password"
              autoComplete="new-password"
              value={jwt}
              aria-describedby="office-jwt-state"
              onChange={(event) => {
                setJwt(event.currentTarget.value);
              }}
            />
            <span id="office-jwt-state" className="key-state">
              {office.jwtConfigured ? '已配置' : '未配置'}
            </span>
            {office.jwtConfigured && <small>留空保留原 JWT。</small>}
          </div>
          <button type="submit">{external ? '保存外部配置' : '切换到外部'}</button>
        </fieldset>
      </form>
      {external && (
        <div className="model-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void run({ mode: 'bundled' });
            }}
          >
            切回自带
          </button>
          <small>{RESET_NOTE}</small>
        </div>
      )}
    </>
  );
}

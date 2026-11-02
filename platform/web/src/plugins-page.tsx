import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AdminNavigation } from './admin-navigation.tsx';

type Section = 'catalog' | 'sources' | 'web';
type CatalogState = 'employee' | 'forced-on' | 'forced-off';
interface CatalogEntry {
  id: string;
  package: string;
  name: string;
  category: 'required' | 'manageable';
  imageDefaultEnabled: boolean;
  state: CatalogState;
}
interface Drafts {
  catalog: CatalogEntry[];
  registries: string;
  probe: boolean;
  web: boolean;
}
interface View {
  phase: 'loading' | 'saving' | 'ready' | 'failure' | 'denied';
  drafts: Drafts | null;
  error: { section: Section; text: string } | null;
  counts: Partial<Record<Section, number>>;
}
/** A settled request either denies the page or yields the next view. */
type Outcome = 401 | 403 | ((previous: View) => View);

const API: Record<Section, string> = {
  catalog: '/_platform/api/admin/plugin-catalog',
  sources: '/_platform/api/admin/plugin-sources',
  web: '/_platform/api/admin/web-tools',
};
const STATES = [
  ['employee', '员工自选'],
  ['forced-on', '强制开'],
  ['forced-off', '强制关'],
] as const;
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const LOAD_FAILURE = '插件目录加载失败，请重试。';
const SAVE_FAILURE = '保存失败，请重试。';
const INVALID: Record<Section, string> = {
  catalog: '插件目录状态无效，请刷新后重试。',
  sources: '至少填写一个安装源。',
  web: '联网工具设置无效，请刷新后重试。',
};
const INITIAL: View = { phase: 'loading', drafts: null, error: null, counts: {} };
const DENIED: View = { ...INITIAL, phase: 'denied' };

function record(value: unknown, keys: readonly string[], saved: boolean) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid plugin response');
  // A JSON object envelope: its closed key set is checked here and each value by the caller.
  const body = value as Record<string, unknown>;
  const allowed = saved ? [...keys, 'runningInstances'] : keys;
  if (Object.keys(body).sort().join() !== [...allowed].sort().join())
    throw new Error('Invalid plugin fields');
  return body;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid plugin flag');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid plugin text');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid plugin list');
  return value;
}
function readEntry(value: unknown): CatalogEntry {
  const item = record(
    value,
    ['id', 'package', 'name', 'category', 'imageDefaultEnabled', 'state'],
    false,
  );
  const category = item.category;
  const state = STATES.find(([candidate]) => candidate === item.state)?.[0];
  if ((category !== 'required' && category !== 'manageable') || state === undefined)
    throw new Error('Invalid catalog entry');
  return {
    id: text(item.id),
    package: text(item.package),
    name: text(item.name),
    category,
    imageDefaultEnabled: flag(item.imageDefaultEnabled),
    state,
  };
}
const READ: Record<Section, (value: unknown, saved: boolean) => Partial<Drafts>> = {
  catalog: (value, saved) => ({
    catalog: list(record(value, ['entries'], saved).entries).map(readEntry),
  }),
  sources: (value, saved) => {
    const body = record(value, ['pluginRegistries', 'registryProbeEnabled'], saved);
    return {
      registries: list(body.pluginRegistries).map(text).join('\n'),
      probe: flag(body.registryProbeEnabled),
    };
  },
  web: (value, saved) => ({ web: flag(record(value, ['webToolsEnabled'], saved).webToolsEnabled) }),
};
function runningCount(value: unknown): number {
  const count =
    typeof value === 'object' && value !== null && 'runningInstances' in value
      ? value.runningInstances
      : undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw new Error('Invalid running count');
  return count;
}

/** Text lines verbatim: only a trailing `\r` per line and one final empty line are dropped. */
function registryList(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
function payload(section: Section, drafts: Drafts): unknown {
  if (section === 'catalog')
    return {
      entries: drafts.catalog.map(({ id, category, state }) => ({
        id,
        state: category === 'required' ? 'forced-on' : state,
      })),
    };
  if (section === 'sources')
    return {
      pluginRegistries: registryList(drafts.registries),
      registryProbeEnabled: drafts.probe,
    };
  return { webToolsEnabled: drafts.web };
}
function rejection(section: Section, body: unknown): string {
  if (section !== 'sources') return INVALID[section];
  const message =
    typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined;
  const index = typeof message === 'string' ? /^pluginRegistries\[(\d+)\]/.exec(message) : null;
  const line = Number(index?.[1]) + 1;
  return Number.isSafeInteger(line)
    ? `第 ${String(line)} 行的安装源地址无效：须以 http:// 或 https:// 开头且不含空白。`
    : INVALID.sources;
}

async function request(url: string, signal: AbortSignal, body?: unknown) {
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'PUT',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let parsed: unknown;
    try {
      // Reading the body to its end settles the response even when it is not JSON.
      parsed = await response.json();
    } catch {
      /* The status still governs; an unreadable success body fails validation. */
    }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: undefined };
  }
}
async function load(signal: AbortSignal): Promise<Outcome> {
  // All three reads settle (bodies included) before any decision or navigation.
  const results = await Promise.all([
    request(API.catalog, signal),
    request(API.sources, signal),
    request(API.web, signal),
  ]);
  const statuses = results.map((result) => result.status);
  if (statuses.includes(401)) return 401;
  if (statuses.includes(403)) return 403;
  try {
    if (statuses.some((status) => status !== 200)) throw new Error('Unexpected status');
    const [catalog, sources, web] = results;
    const drafts: Drafts = {
      catalog: [],
      registries: '',
      probe: false,
      web: false,
      ...READ.catalog(catalog.body, false),
      ...READ.sources(sources.body, false),
      ...READ.web(web.body, false),
    };
    return () => ({ phase: 'ready', drafts, error: null, counts: {} });
  } catch {
    return () => ({ ...INITIAL, phase: 'failure' });
  }
}
async function save(section: Section, body: unknown, signal: AbortSignal): Promise<Outcome> {
  const result = await request(API[section], signal, body);
  if (result.status === 401 || result.status === 403) return result.status === 401 ? 401 : 403;
  const fail =
    (message: string) =>
    (previous: View): View => ({ ...previous, phase: 'ready', error: { section, text: message } });
  if (result.status === 400) return fail(rejection(section, result.body));
  try {
    if (result.status !== 200) throw new Error('Unexpected status');
    const patch = READ[section](result.body, true);
    const count = runningCount(result.body);
    return (previous) =>
      previous.drafts === null
        ? previous
        : {
            ...previous,
            phase: 'ready',
            drafts: { ...previous.drafts, ...patch },
            counts: { ...previous.counts, [section]: count },
          };
  } catch {
    return fail(SAVE_FAILURE);
  }
}

export function PluginsPage() {
  const [view, setView] = useState<View>(INITIAL);
  const owner = useRef<AbortController | null>(null);
  const perform = useCallback(async (section?: Section, body?: unknown) => {
    // One page-level owner: no request starts while another load or save is in flight.
    if (owner.current !== null) return;
    const controller = new AbortController();
    owner.current = controller;
    const current = () => owner.current === controller && !controller.signal.aborted;
    setView((previous) =>
      section === undefined ? INITIAL : { ...previous, phase: 'saving', error: null },
    );
    try {
      const outcome =
        section === undefined
          ? await load(controller.signal)
          : await save(section, body, controller.signal);
      if (!current()) return;
      if (typeof outcome === 'function') setView(outcome);
      else {
        setView(DENIED);
        if (outcome === 401) window.location.assign('/_platform/login');
      }
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
  function submit(section: Section) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (owner.current !== null || view.drafts === null) return;
      void perform(section, payload(section, view.drafts));
    };
  }
  function change(patch: Partial<Drafts>) {
    setView((previous) =>
      previous.drafts === null || previous.phase !== 'ready'
        ? previous
        : { ...previous, drafts: { ...previous.drafts, ...patch } },
    );
  }
  const status = {
    loading: '加载中…',
    saving: '正在保存…',
    ready: '',
    failure: LOAD_FAILURE,
    denied: '无权限',
  }[view.phase];
  return (
    <main className="admin">
      <AdminNavigation page="plugins" />
      <div className="admin-content">
        <h1>插件目录</h1>
        <p
          id="plugins-status"
          role={view.phase === 'failure' || view.phase === 'denied' ? 'alert' : 'status'}
        >
          {status}
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
        {view.drafts !== null && (
          <PluginForms view={{ ...view, drafts: view.drafts }} submit={submit} change={change} />
        )}
      </div>
    </main>
  );
}

interface FormsProps {
  view: View & { drafts: Drafts };
  submit: (section: Section) => (event: FormEvent<HTMLFormElement>) => void;
  change: (patch: Partial<Drafts>) => void;
}

function PluginForms({ view, submit, change }: FormsProps) {
  const { drafts } = view;
  const section = (name: Section, label: string, action: string | null, body: ReactNode) => (
    <form
      className="plugins-form"
      aria-label={label}
      aria-busy={view.phase === 'saving'}
      onSubmit={submit(name)}
    >
      <fieldset disabled={view.phase === 'saving'}>
        <legend>{label}</legend>
        {body}
        {view.error?.section === name && <p role="alert">{view.error.text}</p>}
        {view.counts[name] !== undefined && (
          <p>保存时运行中的实例数：{view.counts[name]}（非实时统计）。</p>
        )}
        {action !== null && <button type="submit">{action}</button>}
      </fieldset>
    </form>
  );
  return (
    <>
      <p>{HINT}</p>
      {section(
        'catalog',
        '预装插件',
        drafts.catalog.length === 0 ? null : '保存插件目录',
        <CatalogTable entries={drafts.catalog} change={change} />,
      )}
      {section(
        'sources',
        '插件安装源',
        '保存安装源',
        <>
          <div className="field">
            <label htmlFor="plugin-registries">安装源地址（每行一个，第一行为主安装源）</label>
            <textarea
              id="plugin-registries"
              rows={4}
              spellCheck={false}
              value={drafts.registries}
              aria-describedby="plugin-registries-hint"
              onChange={(event) => {
                change({ registries: event.currentTarget.value });
              }}
            />
            <small id="plugin-registries-hint">
              第一行是安装源，其余各行是备用源。地址中的凭据会对每个员工实例可见；内网部署应填写内网源并关闭仓库探测。
            </small>
          </div>
          <Toggle
            checked={drafts.probe}
            label="开启仓库探测"
            change={(probe) => {
              change({ probe });
            }}
          />
        </>,
      )}
      {section(
        'web',
        '联网工具',
        '保存联网工具设置',
        <Toggle
          checked={drafts.web}
          label="允许联网搜索与抓取工具"
          change={(web) => {
            change({ web });
          }}
        />,
      )}
    </>
  );
}

function CatalogTable({
  entries,
  change,
}: {
  entries: CatalogEntry[];
  change: (patch: Partial<Drafts>) => void;
}) {
  if (entries.length === 0) return <p>镜像未随附预装插件。</p>;
  return (
    <div className="admin-table">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>包名</th>
            <th>镜像默认</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.name}</td>
              <td>{entry.package}</td>
              <td>{entry.imageDefaultEnabled ? '默认开启' : '默认关闭'}</td>
              <td>
                {entry.category === 'required' ? (
                  '强制开（必启，不可修改）'
                ) : (
                  <select
                    aria-label={`${entry.name} 的管理状态`}
                    value={entry.state}
                    onChange={(event) => {
                      const state = STATES.find(
                        ([value]) => value === event.currentTarget.value,
                      )?.[0];
                      if (state === undefined) return;
                      change({
                        catalog: entries.map((item) =>
                          item.id === entry.id ? { ...item, state } : item,
                        ),
                      });
                    }}
                  >
                    {STATES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Toggle({
  checked,
  label,
  change,
}: {
  checked: boolean;
  label: string;
  change: (checked: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          change(event.currentTarget.checked);
        }}
      />
      {label}
    </label>
  );
}

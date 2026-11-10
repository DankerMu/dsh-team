// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
import { PluginsPage } from './plugins-page.tsx';
import { button, click, element, renderAccountPage, settle } from '../test/account-dom-fixture.tsx';

const PATH = '/_platform/admin/plugins';
const CATALOG_API = '/_platform/api/admin/plugin-catalog';
const SOURCES_API = '/_platform/api/admin/plugin-sources';
const WEB_API = '/_platform/api/admin/web-tools';
const OFFICE = {
  id: 'office-agents',
  package: '@dsh-team/office-agents',
  name: '办公 Agent',
  category: 'manageable',
  imageDefaultEnabled: true,
  state: 'employee',
  unavailableReason: null,
};
const LOCALE = {
  id: 'zh-locale',
  package: '@dsh-team/zh-locale',
  name: '中文界面',
  category: 'required',
  imageDefaultEnabled: false,
  state: 'forced-on',
  unavailableReason: null,
};
const CATALOG = { entries: [OFFICE, LOCALE] };
const SOURCES = {
  pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  registryProbeEnabled: true,
};
const WEB = { webToolsEnabled: false };
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const SAVE = ['保存插件目录', '保存安装源', '保存联网工具设置'] as const;
const FORMS = ['预装插件', '插件安装源', '联网工具'] as const;
const COUNT = '保存时运行中的实例数';
type Reply = Response | Promise<Response> | (() => Promise<Response>);
const offline = () => Promise.reject(new Error('private-data'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fetch stub keyed by `<method> <url>`; each key replays its queued replies in order. */
function serve(replies: Record<string, Reply[]>) {
  const queues = new Map(Object.entries(replies));
  return vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const next = queues.get(key)?.shift();
    if (next === undefined) return Promise.reject(new Error(`Unexpected ${key}`));
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
}
const loads = (
  catalog: Reply = json(CATALOG),
  sources: Reply = json(SOURCES),
  web: Reply = json(WEB),
) => ({
  [`GET ${CATALOG_API}`]: [catalog],
  [`GET ${SOURCES_API}`]: [sources],
  [`GET ${WEB_API}`]: [web],
});
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round++) await settle();
}
async function render(replies: Record<string, Reply[]> = loads()) {
  const rendered = renderAccountPage(<PluginsPage />, PATH, serve(replies));
  await flush();
  return rendered;
}
function textarea(view: HTMLDivElement): HTMLTextAreaElement {
  return element(view, 'textarea', HTMLTextAreaElement);
}
async function type(view: HTMLDivElement, value: string): Promise<void> {
  await settle(() => {
    // The native setter bypasses React's value tracker so the real input event updates state.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (typeof descriptor?.set !== 'function') throw new Error('Missing native textarea setter');
    descriptor.set.call(textarea(view), value);
    textarea(view).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function checkbox(view: HTMLDivElement, form: string): HTMLInputElement {
  return element(view, `form[aria-label="${form}"] input[type="checkbox"]`, HTMLInputElement);
}
async function choose(view: HTMLDivElement, value: string): Promise<void> {
  await settle(() => {
    const select = element(view, 'select', HTMLSelectElement);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function sent(request: ReturnType<typeof serve>, index: number): unknown {
  const body = request.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Missing JSON payload');
  return JSON.parse(body);
}
function alerts(view: HTMLDivElement): string[] {
  return [...view.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
}
function formText(view: HTMLDivElement, name: string): string {
  return element(view, `form[aria-label="${name}"]`, HTMLFormElement).textContent;
}
/** The running count appears under exactly the saved form and no other. */
function expectCountOnlyUnder(view: HTMLDivElement, saved: string, count: number): void {
  for (const name of FORMS)
    if (name === saved)
      expect(formText(view, name)).toContain(`${COUNT}：${String(count)}（非实时统计）。`);
    else expect(formText(view, name)).not.toContain(COUNT);
}
/** The single alert sits inside the form whose save button was used; the other forms carry none. */
function expectAlertOnlyUnder(view: HTMLDivElement, label: (typeof SAVE)[number]): void {
  const saved = FORMS[SAVE.indexOf(label)];
  expect(
    element(view, '[role="alert"]', HTMLElement).closest('form')?.getAttribute('aria-label'),
  ).toBe(saved);
  for (const name of FORMS)
    if (name !== saved)
      expect(view.querySelector(`form[aria-label="${name}"] [role="alert"]`)).toBeNull();
}
function expectNoConfiguration(view: HTMLDivElement): void {
  expect(view.querySelector('form')).toBeNull();
  expect(view.querySelector('select, textarea, input, table')).toBeNull();
  expect(view.textContent).not.toContain('办公 Agent');
  expect(view.textContent).not.toContain('registry.npmjs.org');
  expect(view.textContent).not.toContain(HINT);
}

it('shows only the loading status until all three reads settle', async () => {
  const held = Promise.withResolvers<Response>();
  const { view, request } = await render(loads(held.promise));
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('加载中…');
  expectNoConfiguration(view);
  expect(request.mock.calls.map(([url]) => url)).toEqual([CATALOG_API, SOURCES_API, WEB_API]);
  expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  await settle(() => {
    held.resolve(json(CATALOG));
  });
  await flush();
  expect(view.querySelectorAll('form')).toHaveLength(3);
});

it('dispatches the routed page and renders the catalog, sources and web-tools forms', async () => {
  const request = serve(loads());
  const { view } = renderAccountPage(<AccountPage />, PATH, request);
  await flush();
  expect(element(view, 'h1', HTMLHeadingElement).textContent).toBe('插件目录');
  expect(element(view, 'a[aria-current="page"]', HTMLAnchorElement).pathname).toBe(PATH);
  expect([...view.querySelectorAll('p')].some((p) => p.textContent === HINT)).toBe(true);
  expect([...view.querySelectorAll('form')].map((form) => form.getAttribute('aria-label'))).toEqual(
    ['预装插件', '插件安装源', '联网工具'],
  );
  const rows = [...view.querySelectorAll('tbody tr')];
  expect(
    rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)),
  ).toEqual([
    ['办公 Agent', '@dsh-team/office-agents', '默认开启', '员工自选强制开强制关'],
    ['中文界面', '@dsh-team/zh-locale', '默认关闭', '强制开（必启，不可修改）'],
  ]);
  expect(rows[1]?.querySelector('select')).toBeNull();
  const select = element(view, 'select', HTMLSelectElement);
  expect(select.getAttribute('aria-label')).toBe('办公 Agent 的管理状态');
  expect(select.value).toBe('employee');
  expect([...select.options].map((option) => [option.value, option.text])).toEqual([
    ['employee', '员工自选'],
    ['forced-on', '强制开'],
    ['forced-off', '强制关'],
  ]);
  expect(element(view, 'label[for="plugin-registries"]', HTMLLabelElement).textContent).toBe(
    '安装源地址（每行一个，第一行为主安装源）',
  );
  expect(textarea(view).value).toBe(SOURCES.pluginRegistries.join('\n'));
  expect(checkbox(view, '插件安装源').checked).toBe(true);
  expect(checkbox(view, '插件安装源').labels?.[0]?.textContent).toBe('开启仓库探测');
  expect(checkbox(view, '联网工具').checked).toBe(false);
  expect(checkbox(view, '联网工具').labels?.[0]?.textContent).toBe('允许联网搜索与抓取工具');
  expect(view.textContent).toContain('凭据');
  expect(view.textContent).toContain('内网');
  for (const label of SAVE) expect(button(view, label).matches(':disabled')).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

it('navigates to login exactly once only after every read has settled', async () => {
  const sources = Promise.withResolvers<Response>();
  const web = Promise.withResolvers<Response>();
  const { view, navigate } = await render(
    loads(json({ message: 'private-data' }, 401), sources.promise, web.promise),
  );
  expect(navigate).not.toHaveBeenCalled();
  await settle(() => {
    sources.resolve(json(SOURCES));
  });
  await flush();
  expect(navigate).not.toHaveBeenCalled();
  await settle(() => {
    web.resolve(json({}, 403));
  });
  await flush();
  expect(navigate.mock.calls).toEqual([['/_platform/login']]);
  expectNoConfiguration(view);
  expect(view.innerHTML).not.toContain('private-data');
});

it('shows only the denial when any read is forbidden', async () => {
  const { view, navigate } = await render(loads(json(CATALOG), json({}, 403), json(WEB)));
  expect(alerts(view)).toEqual(['无权限']);
  expectNoConfiguration(view);
  expect(view.querySelector('button')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  ['server error', loads(json(CATALOG), json(SOURCES), json({ message: 'private-data' }, 500))],
  ['network failure', loads(offline)],
  ['unreadable body', loads(json(CATALOG), new Response('private-data', { status: 200 }))],
  ['extra field', loads(json({ ...CATALOG, secret: 'private-data' }))],
  ['unknown state', loads(json({ entries: [{ ...OFFICE, state: 'private-data' }] }))],
  ['unknown category', loads(json({ entries: [{ ...OFFICE, category: 'private-data' }] }))],
  ['entry field type', loads(json({ entries: [{ ...OFFICE, imageDefaultEnabled: 'yes' }] }))],
  ['unknown reason', loads(json({ entries: [{ ...OFFICE, unavailableReason: 'private-data' }] }))],
  ['missing reason', loads(json({ entries: [{ ...OFFICE, unavailableReason: undefined }] }))],
  ['entries type', loads(json({ entries: 'private-data' }))],
  ['entry shape', loads(json({ entries: [null] }))],
  ['registry type', loads(json(CATALOG), json({ ...SOURCES, pluginRegistries: [1] }))],
  ['probe type', loads(json(CATALOG), json({ ...SOURCES, registryProbeEnabled: 'on' }))],
  ['web type', loads(json(CATALOG), json(SOURCES), json({ webToolsEnabled: 1 }))],
  ['array body', loads(json(CATALOG), json(SOURCES), json([]))],
])('fails the whole page on a %s and retries all three reads', async (_name, replies) => {
  const retry: Record<string, Reply[]> = loads();
  const merged = Object.fromEntries(
    Object.entries(replies).map(([key, queue]) => [key, [...queue, ...(retry[key] ?? [])]]),
  );
  const { view, request } = await render(merged);
  expect(alerts(view)).toEqual(['插件目录加载失败，请重试。']);
  expectNoConfiguration(view);
  expect(view.innerHTML).not.toContain('private-data');
  await click(view, '重试');
  await flush();
  expect(request).toHaveBeenCalledTimes(6);
  expect(view.querySelectorAll('form')).toHaveLength(3);
  expect(alerts(view)).toEqual([]);
});

it('shows the empty-catalog text without a catalog save button', async () => {
  const { view } = await render(loads(json({ entries: [] })));
  expect(element(view, 'form[aria-label="预装插件"]', HTMLFormElement).textContent).toContain(
    '镜像未随附预装插件。',
  );
  expect(view.querySelector('table')).toBeNull();
  expect(() => button(view, '保存插件目录')).toThrow();
  expect(button(view, '保存安装源').matches(':disabled')).toBe(false);
});

it('saves the full catalog with required entries forced on and shows the running count', async () => {
  const saved = { entries: [{ ...OFFICE, state: 'forced-off' }, LOCALE], runningInstances: 2 };
  const request = serve({ ...loads(), [`PUT ${CATALOG_API}`]: [json(saved)] });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await choose(view, 'forced-off');
  await click(view, '保存插件目录');
  await flush();
  expect(request.mock.calls[3]?.[0]).toBe(CATALOG_API);
  expect(request.mock.calls[3]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(sent(request, 3)).toEqual({
    entries: [
      { id: 'office-agents', state: 'forced-off' },
      { id: 'zh-locale', state: 'forced-on' },
    ],
  });
  expect(element(view, 'select', HTMLSelectElement).value).toBe('forced-off');
  expect(element(view, 'form[aria-label="预装插件"]', HTMLFormElement).textContent).toContain(
    '保存时运行中的实例数：2（非实时统计）。',
  );
  expectCountOnlyUnder(view, '预装插件', 2);
});

const REASONS = [
  [
    'published-loopback',
    'Office 不可用：上游模式为 published-loopback，实例连不到 Document Server，ONLYOFFICE 在实例中停用。',
  ],
  [
    'external-jwt-missing',
    'Office 不可用：已填写外部 Document Server 地址，但没有填写 JWT 密钥，ONLYOFFICE 在实例中停用。',
  ],
  [
    'bundled-unconfigured',
    'Office 不可用：部署没有配置自带 Document Server，ONLYOFFICE 在实例中停用。',
  ],
] as const;
const REASON = '[data-testid="office-unavailable-reason"]';
const withReason = (unavailableReason: string, state = 'employee') =>
  json({ entries: [{ ...OFFICE, state, unavailableReason }, LOCALE] });

it.each(REASONS)(
  'shows the fixed %s text under the state control of that row',
  async (reason, expected) => {
    const { view } = await render(loads(withReason(reason)));

    const shown = [...view.querySelectorAll(REASON)];

    expect(shown.map((node) => node.textContent)).toEqual([expected]);
    expect(shown[0]?.closest('td')?.querySelector('select')).not.toBeNull();
    expect(shown[0]?.previousElementSibling?.tagName).toBe('SELECT');
  },
);

it('shows no reason when every entry reports null', async () => {
  const { view } = await render();

  expect(view.querySelector(REASON)).toBeNull();
  expect(view.textContent).not.toContain('Office 不可用');
});

it('hides the reason while the draft is forced-off and shows it again when switched back', async () => {
  const { view } = await render(loads(withReason('bundled-unconfigured')));

  await choose(view, 'forced-off');
  const hidden = view.querySelector(REASON);
  await choose(view, 'forced-on');
  const restored = view.querySelector(REASON)?.textContent;

  expect(hidden).toBeNull();
  expect(restored).toBe(REASONS[2][1]);
});

it('shows no reason for an entry loaded as forced-off', async () => {
  const { view } = await render(loads(withReason('published-loopback', 'forced-off')));

  expect(element(view, 'select', HTMLSelectElement).value).toBe('forced-off');
  expect(view.querySelector(REASON)).toBeNull();
});

it.each([
  ['', []],
  ['a\r\nb\n', ['a', 'b']],
  ['a\n\nb', ['a', '', 'b']],
  ['a\n\n', ['a', '']],
  [' a \n\tb', [' a ', '\tb']],
  ['a\nA\na', ['a', 'A', 'a']],
  ['\n', ['']],
])('sends registry text %j verbatim as %j', async (text, pluginRegistries) => {
  const request = serve({
    ...loads(),
    [`PUT ${SOURCES_API}`]: [json({ ...SOURCES, runningInstances: 0 })],
  });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await type(view, text);
  await settle(() => {
    checkbox(view, '插件安装源').click();
  });
  await click(view, '保存安装源');
  expect(sent(request, 3)).toEqual({ pluginRegistries, registryProbeEnabled: false });
});

it('saves web tools alone and keeps the other unsaved drafts', async () => {
  const request = serve({
    ...loads(),
    [`PUT ${WEB_API}`]: [json({ webToolsEnabled: true, runningInstances: 3 })],
  });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await type(view, 'http://draft.invalid/');
  await choose(view, 'forced-on');
  await settle(() => {
    checkbox(view, '联网工具').click();
  });
  await click(view, '保存联网工具设置');
  await flush();
  expect(sent(request, 3)).toEqual({ webToolsEnabled: true });
  expect(checkbox(view, '联网工具').checked).toBe(true);
  expect(textarea(view).value).toBe('http://draft.invalid/');
  expect(element(view, 'select', HTMLSelectElement).value).toBe('forced-on');
  expect(element(view, 'form[aria-label="联网工具"]', HTMLFormElement).textContent).toContain(
    '保存时运行中的实例数：3（非实时统计）。',
  );
  expectCountOnlyUnder(view, '联网工具', 3);
});

it('replaces the sources draft only from its own saved response', async () => {
  const request = serve({
    ...loads(),
    [`PUT ${SOURCES_API}`]: [
      json({
        pluginRegistries: ['http://saved.invalid/'],
        registryProbeEnabled: true,
        runningInstances: 4,
      }),
    ],
  });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await type(view, 'http://draft.invalid/\n');
  await click(view, '保存安装源');
  await flush();
  expect(sent(request, 3)).toEqual({
    pluginRegistries: ['http://draft.invalid/'],
    registryProbeEnabled: true,
  });
  expect(textarea(view).value).toBe('http://saved.invalid/');
  expect(checkbox(view, '插件安装源').checked).toBe(true);
  expect(view.textContent).toContain('保存时运行中的实例数：4（非实时统计）。');
  expectCountOnlyUnder(view, '插件安装源', 4);
});

it.each([
  [SAVE[0], CATALOG_API, { message: 'private-data' }, '插件目录状态无效，请刷新后重试。'],
  [
    SAVE[1],
    SOURCES_API,
    { message: 'pluginRegistries[2] must be an http(s) URL without whitespace' },
    '第 3 行的安装源地址无效：须以 http:// 或 https:// 开头且不含空白。',
  ],
  [
    SAVE[1],
    SOURCES_API,
    { message: 'Invalid plugin sources; private-data' },
    '至少填写一个安装源。',
  ],
  [SAVE[1], SOURCES_API, 'private-data', '至少填写一个安装源。'],
  [SAVE[2], WEB_API, { message: 'private-data' }, '联网工具设置无效，请刷新后重试。'],
])('maps a rejected %s to fixed guidance %#', async (label, api, body, expected) => {
  const request = serve({
    ...loads(),
    [`PUT ${api}`]: [
      typeof body === 'string' ? new Response(body, { status: 400 }) : json(body, 400),
    ],
  });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await click(view, label);
  await flush();
  expect(alerts(view)).toEqual([expected]);
  expectAlertOnlyUnder(view, label);
  expect(view.innerHTML).not.toContain('private-data');
  expect(view.textContent).not.toContain('pluginRegistries');
  for (const name of SAVE) expect(button(view, name).matches(':disabled')).toBe(false);
});

it('sends an empty registry list for empty text and shows the envelope guidance', async () => {
  const request = serve({
    ...loads(),
    [`PUT ${SOURCES_API}`]: [json({ message: 'Invalid plugin sources' }, 400)],
  });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await type(view, '');
  await click(view, '保存安装源');
  await flush();
  expect(sent(request, 3)).toEqual({ pluginRegistries: [], registryProbeEnabled: true });
  expect(alerts(view)).toEqual(['至少填写一个安装源。']);
  expectAlertOnlyUnder(view, SAVE[1]);
  expect(textarea(view).value).toBe('');
});

it.each([
  [SAVE[0], CATALOG_API, json({ message: 'private-data' }, 500)],
  [SAVE[1], SOURCES_API, offline],
  [SAVE[2], WEB_API, json({ webToolsEnabled: true })],
  [SAVE[2], WEB_API, json({ webToolsEnabled: true, runningInstances: -1 })],
  [SAVE[1], SOURCES_API, json({ ...SOURCES, runningInstances: 0.5 })],
  [SAVE[0], CATALOG_API, json({ entries: [], runningInstances: 0 }, 409)],
  [
    SAVE[0],
    CATALOG_API,
    json({ entries: [{ ...OFFICE, unavailableReason: 'private-data' }], runningInstances: 0 }),
  ],
])('reports a failed or malformed %s save without false success %#', async (label, api, reply) => {
  const request = serve({ ...loads(), [`PUT ${api}`]: [reply] });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await click(view, label);
  await flush();
  expect(alerts(view)).toEqual(['保存失败，请重试。']);
  expectAlertOnlyUnder(view, label);
  expect(view.innerHTML).not.toContain('private-data');
  expect(view.textContent).not.toContain('保存时运行中的实例数');
  expect(checkbox(view, '联网工具').checked).toBe(false);
});

it.each([401, 403])(
  'a %i save denial removes every form and obeys redirect policy',
  async (status) => {
    const request = serve({
      ...loads(),
      [`PUT ${WEB_API}`]: [new Response('private-data', { status })],
    });
    const { view, navigate } = renderAccountPage(<PluginsPage />, PATH, request);
    await flush();
    await click(view, SAVE[2]);
    await flush();
    expect(alerts(view)).toEqual(['无权限']);
    expectNoConfiguration(view);
    expect(view.innerHTML).not.toContain('private-data');
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
    expect(request).toHaveBeenCalledTimes(4);
  },
);

it('fences every form while one save is pending and ignores further submits', async () => {
  const held = Promise.withResolvers<Response>();
  const request = serve({ ...loads(), [`PUT ${SOURCES_API}`]: [held.promise] });
  const { view } = renderAccountPage(<PluginsPage />, PATH, request);
  await flush();
  await settle(() => {
    button(view, '保存安装源').click();
    button(view, '保存安装源').click();
  });
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在保存…');
  for (const label of SAVE) expect(button(view, label).matches(':disabled')).toBe(true);
  expect([...view.querySelectorAll('fieldset')].every((node) => node.disabled)).toBe(true);
  await settle(() => {
    for (const form of view.querySelectorAll('form'))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(request).toHaveBeenCalledTimes(4);
  await settle(() => {
    held.resolve(json({ ...SOURCES, runningInstances: 1 }));
  });
  await flush();
  for (const label of SAVE) expect(button(view, label).matches(':disabled')).toBe(false);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each(['load', 'save'] as const)(
  'unmounting aborts the in-flight %s and its late completion changes nothing',
  async (stage) => {
    const pending = Promise.withResolvers<Response>();
    const request = serve(
      stage === 'load'
        ? loads(pending.promise)
        : { ...loads(), [`PUT ${WEB_API}`]: [pending.promise] },
    );
    const { view, unmount, navigate } = renderAccountPage(<PluginsPage />, PATH, request);
    await flush();
    if (stage === 'save') await click(view, SAVE[2]);
    const signal = request.mock.calls.at(-1)?.[1]?.signal;
    unmount();
    await settle(() => {
      pending.resolve(json({}, 401));
    });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(view.innerHTML).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  },
);

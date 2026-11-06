// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
import { OfficePage } from './office-page.tsx';
import {
  button,
  change,
  click,
  element,
  holdResponseBody,
  renderAccountPage,
  settle,
  settleSubmit,
} from '../test/account-dom-fixture.tsx';

const PATH = '/_platform/admin/office';
const API = '/_platform/api/admin/document-server';
const BUNDLED = { mode: 'bundled', bundledConfigured: true, url: '', jwtConfigured: false };
const UNCONFIGURED = { ...BUNDLED, bundledConfigured: false };
const EXTERNAL = {
  mode: 'external',
  bundledConfigured: false,
  url: 'https://office.intranet',
  jwtConfigured: true,
};
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const SAVED = '已保存，实例下次启动时生效。';
const LOAD_FAILED = 'Office 配置加载失败，请重试。';
const SAVE_FAILED = '保存失败，请重试。';
const FIRST_SWITCH = '首次切换到外部 Document Server 时必须填写 JWT。';
const ADDRESS_INVALID =
  'Document Server 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。';
const PAIRING = 'External Document Server requires jwtSecret';
const SECRET = 'typed-office-jwt-never-rendered';
const RESET_NOTE = '切回自带会清除已保存的外部地址和 JWT。';
type Reply = Response | Promise<Response> | (() => Promise<Response>);
const offline = () => Promise.reject(new Error('private-data'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const saved = (body: object, runningInstances: unknown = 0) => json({ ...body, runningInstances });

function offline400(): Promise<Response> {
  const response = new Response('x', { status: 400 });
  vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('private-data'));
  return Promise.resolve(response);
}

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
const replies = (load: Reply, ...puts: Reply[]) => ({
  [`GET ${API}`]: [load],
  [`PUT ${API}`]: puts,
});
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round++) await settle();
}
async function render(load: Reply = json(BUNDLED), ...puts: Reply[]) {
  const request = serve(replies(load, ...puts));
  const rendered = renderAccountPage(<OfficePage />, PATH, request);
  await flush();
  return { ...rendered, request };
}
function input(view: HTMLDivElement, id: string): HTMLInputElement {
  return element(view, `#${id}`, HTMLInputElement);
}
async function type(view: HTMLDivElement, id: string, value: string): Promise<void> {
  await settle(() => {
    change(input(view, id), value);
  });
}
async function press(view: HTMLDivElement, label: string): Promise<void> {
  await click(view, label);
  await flush();
}
function status(view: HTMLDivElement): { role: string | null; text: string } {
  const line = element(view, '#office-status', HTMLElement);
  return { role: line.getAttribute('role'), text: line.textContent };
}
function area(view: HTMLDivElement): string[] {
  const region = element(view, 'section[aria-label="当前 Office 配置"]', HTMLElement);
  return [...region.querySelectorAll('p')].map((line) => line.textContent);
}
function sent(request: ReturnType<typeof serve>, index: number): unknown {
  const init = request.mock.calls[index]?.[1];
  expect(init?.method).toBe('PUT');
  if (typeof init?.body !== 'string') throw new Error('Missing JSON payload');
  return JSON.parse(init.body);
}
function expectNoConfiguration(view: HTMLDivElement, controls: string[] = []): void {
  expect(view.querySelector('form, input, fieldset, section')).toBeNull();
  expect(buttons(view)).toEqual(controls);
  expect(view.textContent).not.toContain('office.intranet');
  expect(view.textContent).not.toContain('当前使用');
  expect(view.textContent).not.toContain('已配置');
  expect(view.textContent).not.toContain(HINT);
}
function buttons(view: HTMLDivElement): string[] {
  return [...view.querySelectorAll('button')].map((entry) => entry.textContent);
}

it('shows only the loading status, without forms, until the read settles', async () => {
  const held = Promise.withResolvers<Response>();
  const { view, request } = await render(held.promise);

  expect(status(view)).toEqual({ role: 'status', text: '加载中…' });
  expect(view.querySelector('form, section')).toBeNull();
  expect(view.textContent).not.toContain(HINT);
  expect(request.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([[API, 'GET']]);
  await settle(() => {
    held.resolve(json(BUNDLED));
  });
  await flush();
  expect(view.querySelectorAll('form')).toHaveLength(1);
});

it('dispatches the routed page and renders a configured bundled server', async () => {
  const request = serve(replies(json(BUNDLED)));
  const { view } = renderAccountPage(<AccountPage />, PATH, request);
  await flush();

  expect(view.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(PATH);
  expect(element(view, 'h1', HTMLElement).textContent).toBe('Office');
  expect([...view.querySelectorAll('p')].some((line) => line.textContent === HINT)).toBe(true);
  expect(area(view)).toEqual(['当前使用：自带 Document Server', '自带 Document Server：已配置']);
  expect(view.querySelector('section [role="alert"]')).toBeNull();
  expect(element(view, 'form', HTMLFormElement).getAttribute('aria-label')).toBe(
    '外部 Document Server',
  );
  expect(input(view, 'office-url').value).toBe('');
  expect(view.textContent).toContain('外部 Document Server 的根地址，例如 https://office.intranet');
  const jwt = input(view, 'office-jwt');
  expect([jwt.type, jwt.autocomplete, jwt.value]).toEqual(['password', 'new-password', '']);
  expect(element(view, '#office-jwt-state', HTMLElement).textContent).toBe('未配置');
  expect(view.textContent).not.toContain('留空保留原 JWT。');
  expect(buttons(view)).toEqual(['切换到外部']);
  expect(view.textContent).not.toContain(RESET_NOTE);
  expect(status(view)).toEqual({ role: 'status', text: '' });
});

it('marks an unconfigured bundled server as Office unavailable and keeps the form usable', async () => {
  const { view } = await render(json(UNCONFIGURED));

  expect(area(view)).toEqual([
    '当前使用：自带 Document Server',
    '自带 Document Server：未配置，Office 不可用',
  ]);
  expect(element(view, 'section [role="alert"]', HTMLElement).textContent).toBe(
    '自带 Document Server：未配置，Office 不可用',
  );
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(false);
  expect(button(view, '切换到外部').disabled).toBe(false);
});

it('renders a saved external server with its address, JWT state and reset action', async () => {
  const { view } = await render(json(EXTERNAL));

  expect(area(view)).toEqual([
    '当前使用：外部 Document Server',
    'https://office.intranet',
    'JWT：已配置',
  ]);
  expect(input(view, 'office-url').value).toBe('https://office.intranet');
  expect(input(view, 'office-jwt').value).toBe('');
  expect(element(view, '#office-jwt-state', HTMLElement).textContent).toBe('已配置');
  expect(view.textContent).toContain('留空保留原 JWT。');
  expect(buttons(view)).toEqual(['保存外部配置', '切回自带']);
  expect(view.textContent).toContain(RESET_NOTE);
});

it('shows JWT：未配置 for an external answer without a stored JWT', async () => {
  const { view } = await render(json({ ...EXTERNAL, jwtConfigured: false }));

  expect(area(view)).toContain('JWT：未配置');
});

it('renders the saved address as text, never as markup', async () => {
  const { view } = await render(json({ ...EXTERNAL, url: 'https://<b>x</b>' }));

  expect(area(view)).toContain('https://<b>x</b>');
  expect(view.querySelector('section b')).toBeNull();
});

it('navigates to login exactly once only after the rejected body has been read', async () => {
  const rejected = new Response('private-data', { status: 401 });
  const body = holdResponseBody(rejected);
  const { view, navigate } = await render(rejected);

  expect(navigate).not.toHaveBeenCalled();
  await settle(() => {
    body.resolve(new ArrayBuffer(0));
  });
  await flush();

  expect(navigate.mock.calls).toEqual([['/_platform/login']]);
  expect(view.innerHTML).not.toContain('private-data');
});

it('shows only 无权限 when the read is forbidden', async () => {
  const { view, navigate } = await render(new Response('private-data', { status: 403 }));

  expect(status(view)).toEqual({ role: 'alert', text: '无权限' });
  expectNoConfiguration(view);
  expect(view.innerHTML).not.toContain('private-data');
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  ['500', json({ message: 'private-data' }, 500)],
  ['network', offline],
  ['extra field', json({ ...EXTERNAL, jwtSecret: 'private-data' })],
  ['saved count on read', json({ ...EXTERNAL, runningInstances: 0 })],
  ['invalid mode', json({ ...EXTERNAL, mode: 'private-data' })],
  ['missing field', json({ mode: 'bundled', bundledConfigured: true, url: '' })],
  ['string flag', json({ ...BUNDLED, jwtConfigured: 'false' })],
  ['numeric bundled flag', json({ ...BUNDLED, bundledConfigured: 1 })],
  ['numeric address', json({ ...EXTERNAL, url: 1 })],
  ['array body', json([])],
  ['null body', json(null)],
  ['unreadable', new Response('private-data')],
])('fails the whole page on a %s read and retries the read', async (_name, first) => {
  const request = serve({ [`GET ${API}`]: [first, json(EXTERNAL)] });
  const { view } = renderAccountPage(<OfficePage />, PATH, request);
  await flush();

  expect(status(view)).toEqual({ role: 'alert', text: LOAD_FAILED });
  expectNoConfiguration(view, ['重试']);
  expect(view.innerHTML).not.toContain('private-data');
  await press(view, '重试');

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]?.method).toBe('GET');
  expect(input(view, 'office-url').value).toBe('https://office.intranet');
});

it.each([
  ['an empty JWT box keeps the stored JWT', '', { mode: 'external', url: ' https://o2.intranet ' }],
  [
    'a typed JWT is sent',
    SECRET,
    { mode: 'external', url: ' https://o2.intranet ', jwtSecret: SECRET },
  ],
])('saves the external form verbatim: %s', async (_name, jwt, body) => {
  const answer = { ...EXTERNAL, url: ' https://o2.intranet ' };
  const { view, request } = await render(json(EXTERNAL), saved(answer, 0));
  await type(view, 'office-url', ' https://o2.intranet ');
  await type(view, 'office-jwt', jwt);

  await press(view, '保存外部配置');

  expect(request.mock.calls[1]?.[0]).toBe(API);
  expect(sent(request, 1)).toEqual(body);
  expect(input(view, 'office-jwt').value).toBe('');
  expect(input(view, 'office-url').value).toBe(' https://o2.intranet ');
  expect(area(view)).toEqual([
    '当前使用：外部 Document Server',
    ' https://o2.intranet ',
    'JWT：已配置',
  ]);
  expect(status(view)).toEqual({ role: 'status', text: SAVED });
  expect(view.textContent).toContain('保存时运行中的实例数：0（非实时统计）。');
  expect(view.innerHTML).not.toContain(SECRET);
});

it('switches a bundled page to external and refreshes the whole view from the answer', async () => {
  const answer = { ...EXTERNAL, bundledConfigured: false, url: 'https://answered.intranet' };
  const { view, request } = await render(json(UNCONFIGURED), saved(answer, 3));
  await type(view, 'office-url', 'https://typed.intranet');
  await type(view, 'office-jwt', SECRET);

  await press(view, '切换到外部');

  expect(sent(request, 1)).toEqual({
    mode: 'external',
    url: 'https://typed.intranet',
    jwtSecret: SECRET,
  });
  expect(area(view)).toEqual([
    '当前使用：外部 Document Server',
    'https://answered.intranet',
    'JWT：已配置',
  ]);
  expect(input(view, 'office-url').value).toBe('https://answered.intranet');
  expect(input(view, 'office-jwt').value).toBe('');
  expect(buttons(view)).toEqual(['保存外部配置', '切回自带']);
  expect(view.textContent).toContain('保存时运行中的实例数：3（非实时统计）。');
});

it.each([
  ['an empty address', BUNDLED, '', SECRET, '请输入 Document Server 地址。'],
  ['an empty address before a missing JWT', BUNDLED, '', '', '请输入 Document Server 地址。'],
  ['a blank JWT', EXTERNAL, 'https://o.intranet', ' \t ', 'JWT 不能只包含空白字符。'],
  ['a first switch without JWT', BUNDLED, 'https://o.intranet', '', FIRST_SWITCH],
  [
    'an external answer without a stored JWT',
    { ...EXTERNAL, jwtConfigured: false },
    'https://o.intranet',
    '',
    FIRST_SWITCH,
  ],
])('rejects %s without a request', async (_name, loaded, address, jwt, message) => {
  const { view, request } = await render(json(loaded));
  await type(view, 'office-url', address);
  await type(view, 'office-jwt', jwt);

  await settleSubmit(view);
  await flush();

  expect(request).toHaveBeenCalledTimes(1);
  expect(status(view)).toEqual({ role: 'alert', text: message });
  expect(input(view, 'office-jwt').value).toBe(jwt);
});

it('leaves a blank but non-empty address to the server rule', async () => {
  const { view, request } = await render(
    json(EXTERNAL),
    json({ message: 'Invalid Document Server configuration' }, 400),
  );
  await type(view, 'office-url', '   ');

  await press(view, '保存外部配置');

  expect(sent(request, 1)).toEqual({ mode: 'external', url: '   ' });
  expect(status(view)).toEqual({ role: 'alert', text: ADDRESS_INVALID });
});

it.each([
  ['the pairing message', json({ message: PAIRING }, 400), FIRST_SWITCH],
  ['another message', json({ message: 'private-data' }, 400), ADDRESS_INVALID],
  ['a pairing text without JSON', new Response(PAIRING, { status: 400 }), ADDRESS_INVALID],
  ['a non-object JSON body', json(PAIRING, 400), ADDRESS_INVALID],
  ['a body without message', json({ error: PAIRING }, 400), ADDRESS_INVALID],
  ['an unreadable body', offline400, ADDRESS_INVALID],
  ['a 500', json({ message: PAIRING }, 500), SAVE_FAILED],
  ['a network failure', offline, SAVE_FAILED],
  ['a missing count', json(EXTERNAL), SAVE_FAILED],
  ['a negative count', saved(EXTERNAL, -1), SAVE_FAILED],
  ['a fractional count', saved(EXTERNAL, 0.5), SAVE_FAILED],
  ['a string count', saved(EXTERNAL, '2'), SAVE_FAILED],
  ['an invalid saved shape', saved({ ...EXTERNAL, mode: 'other' }), SAVE_FAILED],
])('maps a save answered with %s to its fixed text', async (_name, reply, message) => {
  const { view } = await render(json(EXTERNAL), reply);
  await type(view, 'office-url', 'https://typed.intranet');
  await type(view, 'office-jwt', SECRET);

  await press(view, '保存外部配置');

  expect(status(view)).toEqual({ role: 'alert', text: message });
  expect(input(view, 'office-jwt').value).toBe('');
  expect(input(view, 'office-url').value).toBe('https://typed.intranet');
  expect(area(view)).toContain('https://office.intranet');
  expect(view.innerHTML).not.toContain('private-data');
  expect(view.textContent).not.toContain('保存时运行中的实例数');
  for (const control of view.querySelectorAll('button')) expect(control.disabled).toBe(false);
});

it('switches back to the bundled server with the fixed envelope', async () => {
  const { view, request } = await render(json(EXTERNAL), saved(UNCONFIGURED, 1));
  await type(view, 'office-jwt', SECRET);

  await press(view, '切回自带');

  expect(sent(request, 1)).toEqual({ mode: 'bundled' });
  expect(area(view)).toEqual([
    '当前使用：自带 Document Server',
    '自带 Document Server：未配置，Office 不可用',
  ]);
  expect(buttons(view)).toEqual(['切换到外部']);
  expect(view.textContent).not.toContain(RESET_NOTE);
  expect(input(view, 'office-url').value).toBe('');
  expect(input(view, 'office-jwt').value).toBe('');
  expect(status(view)).toEqual({ role: 'status', text: SAVED });
  expect(view.textContent).toContain('保存时运行中的实例数：1（非实时统计）。');
});

it.each([
  ['保存外部配置', 401],
  ['保存外部配置', 403],
  ['切回自带', 401],
  ['切回自带', 403],
])('a %s denial %i removes all configuration and obeys redirect policy', async (label, code) => {
  const { view, request, navigate } = await render(
    json(EXTERNAL),
    new Response('private-data', { status: code }),
  );
  await type(view, 'office-url', 'https://draft.intranet');
  await type(view, 'office-jwt', SECRET);

  await press(view, label);

  expect(status(view)).toEqual({ role: 'alert', text: '无权限' });
  expectNoConfiguration(view);
  expect(view.innerHTML).not.toContain(SECRET);
  expect(view.innerHTML).not.toContain('draft.intranet');
  expect(view.innerHTML).not.toContain('private-data');
  expect(navigate.mock.calls).toEqual(code === 401 ? [['/_platform/login']] : []);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(['保存外部配置', '切回自带'])('fences every control while %s is pending', async (label) => {
  const held = Promise.withResolvers<Response>();
  const { view, request } = await render(json(EXTERNAL), held.promise);
  await type(view, 'office-jwt', SECRET);
  await settle(() => {
    button(view, label).click();
    button(view, label).click();
  });

  expect(status(view)).toEqual({ role: 'status', text: '正在保存…' });
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(true);
  for (const control of view.querySelectorAll('button'))
    expect(control.matches(':disabled')).toBe(true);
  await settle(() => {
    element(view, 'form', HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    button(view, '切回自带').click();
  });
  expect(request).toHaveBeenCalledTimes(2);
  await settle(() => {
    held.resolve(json({}, 500));
  });
  await flush();

  expect(status(view)).toEqual({ role: 'alert', text: SAVE_FAILED });
  for (const control of view.querySelectorAll('button')) expect(control.disabled).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps the fence until the save response body has been read', async () => {
  const response = saved(EXTERNAL);
  const body = Promise.withResolvers<unknown>();
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const { view } = await render(json(EXTERNAL), response);

  await press(view, '保存外部配置');
  expect(status(view).text).toBe('正在保存…');
  expect(button(view, '切回自带').disabled).toBe(true);
  await settle(() => {
    body.resolve({ ...EXTERNAL, runningInstances: 0 });
  });
  await flush();

  expect(status(view).text).toBe(SAVED);
});

it('clears an earlier save count when a later save fails', async () => {
  const { view } = await render(json(EXTERNAL), saved(EXTERNAL, 2), json({}, 500));
  await press(view, '保存外部配置');
  expect(view.textContent).toContain('保存时运行中的实例数：2（非实时统计）。');

  await press(view, '保存外部配置');

  expect(status(view)).toEqual({ role: 'alert', text: SAVE_FAILED });
  expect(view.textContent).not.toContain('保存时运行中的实例数');
});

it.each([
  ['load', undefined],
  ['external save', '保存外部配置'],
  ['bundled switch', '切回自带'],
] as const)(
  'unmounting aborts the in-flight %s and its stale completion changes nothing',
  async (_stage, label) => {
    const pending = Promise.withResolvers<Response>();
    const request = serve(
      label === undefined ? replies(pending.promise) : replies(json(EXTERNAL), pending.promise),
    );
    const { view, unmount, navigate } = renderAccountPage(<OfficePage />, PATH, request);
    await flush();
    if (label !== undefined) await click(view, label);
    const signal = request.mock.calls.at(-1)?.[1]?.signal;

    unmount();
    await settle(() => {
      pending.resolve(new Response('private-data', { status: 401 }));
    });
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(view.innerHTML).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  },
);

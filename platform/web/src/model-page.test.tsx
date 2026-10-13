// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
import { ModelPage } from './model-page.tsx';
import {
  button,
  click,
  createJsonReceipt,
  draft,
  element,
  holdResponseBody,
  renderAccountPage,
  renderSettledAccountPage,
  settle,
  settleSubmit,
  submit,
} from '../test/account-dom-fixture.tsx';

const CONFIG = {
  baseURL: 'http://models.invalid/v1',
  apiKeyConfigured: true,
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};
const receipt = createJsonReceipt(CONFIG);
const PATH = '/_platform/admin/models';
const SECRET = 'browser-owned-not-a-provider-key';
function requestBody(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected JSON request body');
  return value;
}
async function render(request = vi.fn<typeof fetch>().mockResolvedValue(receipt())) {
  return renderSettledAccountPage(<ModelPage />, PATH, request);
}
async function selectDefault(view: HTMLDivElement, value: string) {
  await settle(() => {
    const select = element(view, '#model-default', HTMLSelectElement);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function savedPage(items: unknown = []) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(receipt({ ...CONFIG, runningInstances: 3 }))
    .mockResolvedValueOnce(receipt({ items }));
  const context = await render(request);
  await settleSubmit(context.view);
  await click(context.view, '重启全部运行中的实例');
  return context;
}

it('loads the exact routed editor without ever populating its configured key', async () => {
  const { view, request } = await renderSettledAccountPage(
    <AccountPage />,
    PATH,
    vi.fn<typeof fetch>().mockResolvedValue(receipt()),
  );
  expect(element(view, '#model-key', HTMLInputElement).value).toBe('');
  expect(element(view, '#model-key-state', HTMLElement).textContent).toBe('已设置');
  expect(element(view, '#model-context-0', HTMLInputElement).value).toBe('500000');
  expect(element(view, '#model-context-1', HTMLInputElement).value).toBe('');
  expect(view.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(PATH);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps the mutation fence through JSON completion, clears entered keys and omits an untouched key', async () => {
  const body = Promise.withResolvers<unknown>();
  const response = receipt();
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce(receipt({ ...CONFIG, runningInstances: 1 }));
  const { view } = await render(request);
  await draft(view, '#model-key', SECRET);
  await settle(() => {
    submit(view);
    submit(view);
  });

  expect(request).toHaveBeenCalledTimes(2);
  expect(element(view, '#model-key', HTMLInputElement).value).toBe('');
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(true);
  expect(requestBody(request.mock.calls[1]?.[1]?.body).includes(SECRET)).toBe(true);
  await settle(() => {
    body.resolve({ ...CONFIG, runningInstances: 3 });
  });
  expect(view.textContent).toContain('下次启动实例时生效');
  expect(view.textContent).toContain('保存时有 3');
  expect(view.innerHTML.includes(SECRET)).toBe(false);
  await settleSubmit(view);
  const payload: unknown = JSON.parse(requestBody(request.mock.calls[2]?.[1]?.body));
  expect(payload).toEqual({ baseURL: CONFIG.baseURL, models: CONFIG.models, defaultModel: 'beta' });
});

it('supports fresh configuration, model row edits/removal and explicit default reselection', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      receipt({ baseURL: '', apiKeyConfigured: false, models: [], defaultModel: '' }),
    )
    .mockResolvedValueOnce(receipt({ ...CONFIG, runningInstances: 0 }));
  const { view } = await render(request);
  expect(view.textContent).toContain('未设置');
  await draft(view, '#model-base-url', CONFIG.baseURL);
  await draft(view, '#model-name-0', 'discard');
  await selectDefault(view, 'discard');
  await draft(view, '#model-name-0', 'alpha');
  expect(element(view, '#model-default', HTMLSelectElement).value).toBe('');
  await draft(view, '#model-context-0', '500000');
  await click(view, '添加模型');
  await draft(view, '#model-name-1', 'beta');
  await click(view, '添加模型');
  await draft(view, '#model-name-2', 'discard');
  await click(view, '删除模型 3');
  await selectDefault(view, 'beta');
  await settleSubmit(view);
  expect(JSON.parse(requestBody(request.mock.calls[1]?.[1]?.body))).toEqual({
    baseURL: CONFIG.baseURL,
    models: CONFIG.models,
    defaultModel: 'beta',
  });
  expect(view.textContent).toContain('下次启动实例时生效');
});

it.each([
  ['#model-base-url', ' ', '模型地址'],
  ['#model-name-0', ' ', '模型的名称'],
  ['#model-context-0', '0', '上下文窗口'],
  ['#model-context-0', '1.5', '上下文窗口'],
  ['#model-context-0', '9007199254740992', '上下文窗口'],
  ['#model-key', ' ', '密钥'],
])('rejects invalid input at %s without a mutation', async (selector, value, message) => {
  const { view, request } = await render();
  await draft(view, selector, value);
  await settleSubmit(view);
  expect(request).toHaveBeenCalledTimes(1);
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toContain(message);
});

it('rejects a missing default and an empty model list without saving', async () => {
  const { view, request } = await render();
  await selectDefault(view, '');
  await settleSubmit(view);
  expect(view.textContent).toContain('默认模型');
  await click(view, '删除模型 2');
  await click(view, '删除模型 1');
  await settleSubmit(view);
  expect(request).toHaveBeenCalledTimes(1);
  expect(view.textContent).toContain('请填写每个模型的名称');
});

it.each([
  null,
  [],
  { ...CONFIG, apiKey: SECRET },
  { ...CONFIG, baseURL: 2 },
  { ...CONFIG, apiKeyConfigured: SECRET },
  { ...CONFIG, models: null },
  { ...CONFIG, models: [null] },
  { ...CONFIG, models: [{ name: '' }] },
  { ...CONFIG, models: [{ name: 'beta', contextWindow: 0 }] },
  { ...CONFIG, models: [{ name: 'beta', contextWindow: '500' }] },
  { ...CONFIG, models: [{ name: 'beta', secret: SECRET }] },
  { ...CONFIG, defaultModel: 'absent' },
])(
  'refuses malformed or secret-bearing configuration projections %# and permits explicit retry',
  async (body) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt(body))
      .mockResolvedValueOnce(receipt());
    const { view } = await render(request);
    expect(view.querySelector('form')).toBeNull();
    expect(view.textContent).toContain('加载失败');
    expect(view.innerHTML.includes(SECRET)).toBe(false);
    await click(view, '重试');
    expect(element(view, '#model-default', HTMLSelectElement).value).toBe('beta');
  },
);

it.each(['network', 'json', 'http'] as const)(
  'reports %s load failure without raw diagnostics',
  async (failure) => {
    const request = vi.fn<typeof fetch>();
    if (failure === 'network') request.mockRejectedValue(new Error(SECRET));
    else
      request.mockResolvedValue(new Response(SECRET, { status: failure === 'json' ? 200 : 500 }));
    const { view } = await render(request);
    expect(view.textContent).toContain('加载失败');
    expect(view.innerHTML.includes(SECRET)).toBe(false);
  },
);

it.each([401, 403])('hides the editor after current load denial %i', async (status) => {
  const { view, navigate } = await render(
    vi.fn<typeof fetch>().mockResolvedValue(receipt({ message: SECRET }, status)),
  );
  expect(view.querySelector('form')).toBeNull();
  expect(view.textContent).toContain('无权限');
  expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
});

it.each([400, 500])(
  'does not expose rejected save content or falsely report success for %i',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(receipt({ message: SECRET }, status));
    const { view } = await render(request);
    await draft(view, '#model-key', SECRET);
    await settleSubmit(view);
    expect(element(view, '#model-key', HTMLInputElement).value).toBe('');
    expect(view.innerHTML.includes(SECRET)).toBe(false);
    expect(view.textContent).not.toContain('已保存');
    expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(false);
  },
);

it.each([undefined, -1, 0.5, '2'])(
  'rejects invalid successful save count %j',
  async (runningInstances) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(receipt({ ...CONFIG, runningInstances }));
    const { view } = await render(request);
    await settleSubmit(view);
    expect(view.textContent).toContain('保存失败');
    expect(view.textContent).not.toContain('已保存');
  },
);

it.each([401, 403])(
  'current unreadable denial %i still removes model and key state',
  async (status) => {
    const denied = receipt({}, status);
    vi.spyOn(denied, 'arrayBuffer').mockRejectedValue(new Error(SECRET));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(denied);
    const { view, navigate } = await render(request);
    await draft(view, '#model-key', SECRET);
    await settleSubmit(view);
    expect(view.querySelector('form')).toBeNull();
    expect(view.innerHTML.includes(SECRET)).toBe(false);
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
  },
);

it('keeps unreadable ordinary rejections failures and completes the mutation fence', async () => {
  const response = receipt({}, 500);
  vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error(SECRET));
  const { view } = await render(
    vi.fn<typeof fetch>().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(response),
  );
  await settleSubmit(view);
  expect(view.textContent).toContain('保存失败');
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(false);
});

it.each(['json', 'denial', 'network'] as const)(
  'ignores obsolete %s completion after unmount',
  async (kind) => {
    const pending = Promise.withResolvers<Response>();
    const response = receipt({}, kind === 'denial' ? 401 : 200);
    const held = kind === 'denial' ? holdResponseBody(response) : undefined;
    const json = Promise.withResolvers<unknown>();
    if (kind === 'json') vi.spyOn(response, 'json').mockReturnValue(json.promise);
    const request = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const { view, unmount, navigate } = renderAccountPage(<ModelPage />, PATH, request);
    if (kind !== 'network')
      await settle(() => {
        pending.resolve(response);
      });
    const signal = request.mock.calls[0]?.[1]?.signal;
    unmount();
    await settle(() => {
      if (kind === 'json') json.resolve(CONFIG);
      else if (kind === 'denial') held?.reject(new Error(SECRET));
      else pending.reject(new Error(SECRET));
    });
    expect(signal?.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(view.innerHTML).toBe('');
  },
);

it('canceling restart sends no mutation and repeated confirmation dispatches only once', async () => {
  const { view, request } = await savedPage();
  await click(view, '取消');
  expect(request).toHaveBeenCalledTimes(2);
  await click(view, '重启全部运行中的实例');
  act(() => {
    button(view, '确认重启').click();
    button(view, '确认重启').click();
    submit(view);
  });
  await settle();
  expect(request).toHaveBeenCalledTimes(3);
  expect(view.textContent).toContain('没有运行中的实例');
  expect(view.querySelector('dialog')).toBeNull();
});

it.each([
  [
    [
      { userId: 'abcdefghijkl', status: 'starting', reason: 'starting' },
      { userId: 'mnopqrstuvwx', status: 'running', reason: null },
    ],
    '启动可能仍在进行中',
  ],
  [[{ userId: 'abcdefghijkl', status: 'full', reason: 'full' }], '未能开始启动'],
  [[{ userId: 'abcdefghijkl', status: 'unconfigured', reason: 'unconfigured' }], '未能开始启动'],
  [[{ userId: 'abcdefghijkl', status: 'error', reason: 'error' }], '未能开始启动'],
  [[{ userId: 'abcdefghijkl', status: 'stopped', reason: 'stopped' }], '未能开始启动'],
  [[{ userId: 'abcdefghijkl', status: 'ready', reason: null }], '部分实例可能已处理'],
  [[{ userId: 'abcdefghijkl', status: 'starting', reason: null }], '部分实例可能已处理'],
  [[{ status: 'starting', reason: 'starting' }], '部分实例可能已处理'],
  [null, '部分实例可能已处理'],
] as const)(
  'reports restart admission semantics rather than readiness %#',
  async (items, message) => {
    const { view } = await savedPage(items);
    await click(view, '确认重启');
    expect(view.textContent).toContain(message);
    expect(view.textContent).not.toContain('全部已就绪');
  },
);

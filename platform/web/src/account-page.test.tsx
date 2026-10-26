// @vitest-environment jsdom

import { act } from 'react';
import { expect, it } from 'vitest';
import {
  change,
  element,
  renderAccountPage,
  settleSubmit,
  submit,
  type RenderedAccount,
} from '../test/account-dom-fixture.tsx';
import { AccountPage } from './account-page.tsx';

function renderAccount(pathname = '/_platform/login'): RenderedAccount {
  const { view, request, navigate } = renderAccountPage(<AccountPage />, pathname);
  act(() => {
    change(element(view, '#email', HTMLInputElement), 'person@example.com');
    change(element(view, '#password', HTMLInputElement), ' 密码 unchanged ');
  });
  return { view, request, navigate };
}

function submitRepeatedly(view: HTMLDivElement): void {
  act(() => {
    expect(submit(view).defaultPrevented).toBe(true);
    submit(view);
  });
  act(() => {
    submit(view);
  });
}

function expectCredentialControls(view: HTMLDivElement, pending: boolean): void {
  expect(element(view, '#email', HTMLInputElement).disabled).toBe(pending);
  expect(element(view, '#password', HTMLInputElement).disabled).toBe(pending);
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(pending);
  expect(element(view, 'form', HTMLFormElement).getAttribute('aria-busy')).toBe(String(pending));
}

function expectPending(view: HTMLDivElement, message: string): void {
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe(message);
  expectCredentialControls(view, true);
}

function expectRecoverableError(view: HTMLDivElement, message: string): void {
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
  expectCredentialControls(view, false);
}

async function resolveCredentialResponse(
  response: PromiseWithResolvers<Response>,
  status: number,
): Promise<void> {
  await act(async () => {
    response.resolve(new Response('{}', { status }));
    await response.promise;
  });
}

async function expectNetworkRecovery(
  { view, request, navigate }: RenderedAccount,
  message: string,
): Promise<void> {
  await settleSubmit(view);

  expectRecoverableError(view, message);
  expect(navigate).not.toHaveBeenCalled();

  await settleSubmit(view);

  expect(request).toHaveBeenCalledTimes(2);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
}

it('shows pending and sends only one credential request before navigating to the fixed root', async () => {
  const { view, request, navigate } = renderAccount();
  const response = Promise.withResolvers<Response>();
  request.mockReturnValue(response.promise);

  submitRepeatedly(view);

  expect(request).toHaveBeenCalledExactlyOnceWith('/_platform/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{"email":"person@example.com","password":" 密码 unchanged "}',
  });
  expectPending(view, '正在登录…');
  expect(navigate).not.toHaveBeenCalled();

  await resolveCredentialResponse(response, 200);

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it('recovers from a pending rejection and clears the previous error while retrying successfully', async () => {
  const { view, request, navigate } = renderAccount();
  const first = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  request.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);

  act(() => {
    submit(view);
  });
  await act(async () => {
    first.resolve(new Response('{}', { status: 401 }));
    await first.promise;
  });

  expectRecoverableError(view, '邮箱或密码错误。');
  expect(navigate).not.toHaveBeenCalled();

  act(() => {
    change(element(view, '#password', HTMLInputElement), 'corrected-password');
  });
  act(() => {
    submit(view);
  });

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]?.body).toBe(
    '{"email":"person@example.com","password":"corrected-password"}',
  );
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在登录…');

  await act(async () => {
    retry.resolve(new Response('{}', { status: 200 }));
    await retry.promise;
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it.each<[number, string, string]>([
  [401, '{"message":"unknown email"}', '邮箱或密码错误。'],
  [429, '{"message":"Too many login attempts"}', '登录尝试过于频繁，请稍后再试。'],
  [403, '{"message":"Account is disabled"}', '账号已被禁用，请联系管理员。'],
  [403, '{"message":"Invalid Origin private detail"}', '登录失败，请稍后重试。'],
  [403, 'null', '登录失败，请稍后重试。'],
  [403, '{}', '登录失败，请稍后重试。'],
  [403, '{"message":123}', '登录失败，请稍后重试。'],
  [403, 'not JSON: private detail', '登录失败，请稍后重试。'],
  [400, '{"message":"private validation detail"}', '登录失败，请稍后重试。'],
  [500, '{"message":"private database detail"}', '登录失败，请稍后重试。'],
  [201, '{"message":"not a successful login"}', '登录失败，请稍后重试。'],
  [302, '{"message":"not a successful login"}', '登录失败，请稍后重试。'],
])(
  'keeps rejection %i (%s) on the form with safe Chinese feedback',
  async (status, body, message) => {
    const { view, request, navigate } = renderAccount();
    request.mockResolvedValue(new Response(body, { status }));

    await settleSubmit(view);

    expectRecoverableError(view, message);
    expect(element(view, '#password', HTMLInputElement).value).toBe(' 密码 unchanged ');
    expect(navigate).not.toHaveBeenCalled();
  },
);

it('recovers from network failure without rendering private transport diagnostics', async () => {
  const { view, request, navigate } = renderAccount();
  request.mockRejectedValueOnce(new Error('private transport and password detail'));
  request.mockResolvedValueOnce(new Response('{}', { status: 200 }));

  await expectNetworkRecovery({ view, request, navigate }, '登录失败，请稍后重试。');
});

it('registers once while pending with unchanged password bytes and enters the fixed root only on 201', async () => {
  const { view, request, navigate } = renderAccount('/_platform/register');
  const response = Promise.withResolvers<Response>();
  request.mockReturnValue(response.promise);
  act(() => {
    change(element(view, '#password', HTMLInputElement), ' 😀密码 unchanged ');
  });

  submitRepeatedly(view);

  expect(request).toHaveBeenCalledExactlyOnceWith('/_platform/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{"email":"person@example.com","password":" 😀密码 unchanged "}',
  });
  expectPending(view, '正在注册…');
  expect(navigate).not.toHaveBeenCalled();

  await resolveCredentialResponse(response, 201);

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each<[number, string, string, string]>([
  [
    409,
    '{"message":"Email already registered"}',
    'existing-password',
    '邮箱已注册，请使用其他邮箱或登录。',
  ],
  [
    400,
    '{"message":"body/password must NOT have fewer than 6 characters"}',
    '😀😀😀😀😀',
    '密码太短，请输入至少 6 个字符。',
  ],
])(
  'recovers from registration rejection %i with specific guidance and editable credentials',
  async (status, body, password, message) => {
    const { view, request, navigate } = renderAccount('/_platform/register');
    request.mockResolvedValueOnce(new Response(body, { status }));
    const retry = Promise.withResolvers<Response>();
    request.mockReturnValueOnce(retry.promise);
    act(() => {
      change(element(view, '#password', HTMLInputElement), password);
    });

    await settleSubmit(view);

    expect(request.mock.calls[0]?.[1]?.body).toBe(
      `{"email":"person@example.com","password":"${password}"}`,
    );
    expectRecoverableError(view, message);
    expect(element(view, '#password', HTMLInputElement).value).toBe(password);
    expect(navigate).not.toHaveBeenCalled();

    act(() => {
      change(element(view, '#email', HTMLInputElement), 'unused@example.com');
      change(element(view, '#password', HTMLInputElement), ' corrected 😀 password ');
    });
    act(() => {
      submit(view);
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      '{"email":"unused@example.com","password":" corrected 😀 password "}',
    );
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在注册…');
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      retry.resolve(new Response('{}', { status: 201 }));
      await retry.promise;
    });

    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  },
);

it.each<[number, string]>([
  [400, '{"message":"private validation detail"}'],
  [400, '{"message":"Email already registered"}'],
  [400, 'null'],
  [400, '{"message":123}'],
  [400, 'not JSON: private detail'],
  [409, '{"message":"private conflict detail"}'],
  [409, '{}'],
  [409, 'not JSON: private detail'],
  [403, '{"message":"Account is disabled"}'],
  [401, '{"message":"private auth detail"}'],
  [429, '{"message":"private limit detail"}'],
  [500, '{"message":"private database detail"}'],
  [302, '{"message":"not a successful registration"}'],
])('keeps registration rejection %i (%s) private and recoverable', async (status, body) => {
  const { view, request, navigate } = renderAccount('/_platform/register');
  request.mockResolvedValue(new Response(body, { status }));

  await settleSubmit(view);

  expectRecoverableError(view, '注册失败，请稍后重试。');
  expect(element(view, '#password', HTMLInputElement).value).toBe(' 密码 unchanged ');
  expect(navigate).not.toHaveBeenCalled();
});

it('does not treat the login success status 200 as a successful registration', async () => {
  const { view, request, navigate } = renderAccount('/_platform/register');
  request.mockResolvedValue(new Response('{"id":"wrong-success"}', { status: 200 }));

  await settleSubmit(view);

  expectRecoverableError(view, '注册失败，请稍后重试。');
  expect(navigate).not.toHaveBeenCalled();
});

it('recovers from registration network failure without revealing transport or password details', async () => {
  const { view, request, navigate } = renderAccount('/_platform/register');
  request.mockRejectedValueOnce(new Error('private transport and password detail'));
  request.mockResolvedValueOnce(new Response('{}', { status: 201 }));

  await expectNetworkRecovery({ view, request, navigate }, '注册失败，请稍后重试。');
});

it.each([
  ['/_platform/login', '登录', '/_platform/register', '没有账号？注册', 'current-password'],
  ['/_platform/register', '注册', '/_platform/login', '已有账号？登录', 'new-password'],
  ['/_platform/register/', '登录', '/_platform/register', '没有账号？注册', 'current-password'],
])(
  'selects the credential variant by exact pathname %s with an accessible same-origin alternative',
  (pathname, action, href, linkText, autocomplete) => {
    const { view } = renderAccount(pathname);

    expect(element(view, 'h1', HTMLHeadingElement).textContent).toBe(`${action} DSH 团队平台`);
    expect(element(view, 'form', HTMLFormElement).getAttribute('aria-label')).toBe(action);
    expect(element(view, 'a', HTMLAnchorElement).getAttribute('href')).toBe(href);
    expect(element(view, 'a', HTMLAnchorElement).textContent).toBe(linkText);
    expect(element(view, '#password', HTMLInputElement).getAttribute('autocomplete')).toBe(
      autocomplete,
    );
  },
);

it.each(['/_platform/login', '/_platform/register'])(
  'offers same-origin account settings from %s without sending credentials on entry',
  (pathname) => {
    const { view, request, navigate } = renderAccount(pathname);

    expect(element(view, 'a[href="/_platform/account"]', HTMLAnchorElement).textContent).toBe(
      '账号设置',
    );
    expect(request).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  },
);

it('dispatches the exact account page to its password and logout controls without an auth probe', () => {
  const { view, request, navigate } = renderAccountPage(<AccountPage />, '/_platform/account');

  expect(element(view, 'h1', HTMLHeadingElement).textContent).toBe('修改密码');
  expect(element(view, '#current-password', HTMLInputElement).value).toBe('');
  expect(element(view, '#new-password', HTMLInputElement).value).toBe('');
  expect(element(view, 'button[type="button"]', HTMLButtonElement).textContent).toBe('退出登录');
  expect(view.querySelector('#email')).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

const MODEL_CONFIG_REQUEST = [
  '/_platform/api/admin/model-config',
  { method: 'GET', credentials: 'same-origin', redirect: 'error' },
] as const;
const COMPLETE_MODEL_CONFIG = {
  baseURL: 'http://models.invalid/v1',
  apiKeyConfigured: true,
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};
const ADMIN_LOGIN = '{"id":"admin0000001","email":"person@example.com","role":"admin"}';

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function consumption(response: Response): () => boolean {
  if (response.body !== null) return () => response.bodyUsed;
  // A null-body status such as 204 never reports bodyUsed (Fetch spec); observe the settled read.
  let read = false;
  const original = response.arrayBuffer.bind(response);
  response.arrayBuffer = async () => {
    const bytes = await original();
    read = true;
    return bytes;
  };
  return () => read;
}

async function loginAdmin(
  configuration: Response | Error,
): Promise<RenderedAccount & { consumed: boolean[] }> {
  const rendered = renderAccount();
  const consumed: boolean[] = [];
  const login = json(ADMIN_LOGIN);
  rendered.request.mockResolvedValueOnce(login);
  if (configuration instanceof Error) rendered.request.mockRejectedValueOnce(configuration);
  else rendered.request.mockResolvedValueOnce(configuration);
  const settingsConsumed = configuration instanceof Response ? consumption(configuration) : null;
  rendered.navigate.mockImplementation(() => {
    consumed.push(login.bodyUsed);
    if (settingsConsumed) consumed.push(settingsConsumed());
  });
  await act(async () => {
    submit(rendered.view);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { ...rendered, consumed };
}

it.each<[string, Record<string, unknown>]>([
  ['absent settings', { baseURL: '', apiKeyConfigured: false, models: [], defaultModel: '' }],
  ['a blank address', { ...COMPLETE_MODEL_CONFIG, baseURL: '  ' }],
  ['no configured key', { ...COMPLETE_MODEL_CONFIG, apiKeyConfigured: false }],
  ['an empty model list', { ...COMPLETE_MODEL_CONFIG, models: [], defaultModel: '' }],
  ['no default model', { ...COMPLETE_MODEL_CONFIG, defaultModel: '' }],
])(
  'lands an administrator with %s on the model configuration page after one settings read',
  async (_name, configuration) => {
    const { view, request, navigate } = await loginAdmin(json(configuration));

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(MODEL_CONFIG_REQUEST);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/admin/models');
    expect(view.querySelector('[role="alert"]')).toBeNull();
  },
);

it('lands an administrator with complete settings on the console', async () => {
  const { view, request, navigate } = await loginAdmin(json(COMPLETE_MODEL_CONFIG));

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual(MODEL_CONFIG_REQUEST);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/admin');
  expect(view.querySelector('[role="alert"]')).toBeNull();
});

it.each<[string, Response | Error]>([
  ['500', json({ message: 'private storage detail' }, 500)],
  ['401', json({ message: 'Unauthorized' }, 401)],
  ['403', json({ message: 'Forbidden' }, 403)],
  ['204', new Response(null, { status: 204 })],
  ['a network failure', new Error('private transport detail')],
  ['an unparseable body', json('not JSON: private detail')],
  ['a non-object body', json('[]')],
  ['a mistyped field', json({ ...COMPLETE_MODEL_CONFIG, apiKeyConfigured: 'no' })],
  ['an unknown field', json({ ...COMPLETE_MODEL_CONFIG, apiKey: 'leaked' })],
  ['an unlisted default model', json({ ...COMPLETE_MODEL_CONFIG, defaultModel: 'gamma' })],
])(
  'lands an administrator on the console without error text when the settings read returns %s',
  async (_name, configuration) => {
    const { view, request, navigate, consumed } = await loginAdmin(configuration);

    expect(request).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/admin');
    if (configuration instanceof Response) expect(consumed).toEqual([true, true]);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(element(view, '[role="status"]', HTMLElement).textContent).not.toContain('失败');
  },
);

it('keeps the login pending until the settings read is consumed, then navigates once', async () => {
  const { view, request, navigate } = renderAccount();
  const configuration = Promise.withResolvers<Response>();
  const consumed: boolean[] = [];
  const settings = json(COMPLETE_MODEL_CONFIG);
  const login = json(ADMIN_LOGIN);
  request.mockResolvedValueOnce(login).mockReturnValueOnce(configuration.promise);
  navigate.mockImplementation(() => consumed.push(login.bodyUsed, settings.bodyUsed));

  submitRepeatedly(view);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(request).toHaveBeenCalledTimes(2);
  expectPending(view, '正在登录…');
  expect(navigate).not.toHaveBeenCalled();

  await act(async () => {
    configuration.resolve(settings);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/admin');
  expect(consumed).toEqual([true, true]);
  expect(request).toHaveBeenCalledTimes(2);
});

async function submitSingle(pathname: string, response: Response) {
  const rendered = renderAccount(pathname);
  const consumed: boolean[] = [];
  rendered.request.mockResolvedValueOnce(response);
  rendered.navigate.mockImplementation(() => consumed.push(response.bodyUsed));

  await act(async () => {
    submit(rendered.view);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(rendered.request).toHaveBeenCalledTimes(1);
  expect(rendered.navigate).toHaveBeenCalledExactlyOnceWith('/');
  expect(consumed).toEqual([true]);
  expect(rendered.view.querySelector('[role="alert"]')).toBeNull();
}

it.each<[string, string]>([
  ['an employee role', '{"id":"person000001","email":"person@example.com","role":"employee"}'],
  ['an unknown role', '{"role":"Admin"}'],
  ['a non-string role', '{"role":["admin"]}'],
  ['a missing role', '{"id":"person000001"}'],
  ['a null body', 'null'],
  ['an unparseable body', 'not JSON: private detail'],
])('navigates a login with %s to the fixed root without a settings read', async (_name, body) => {
  await submitSingle('/_platform/login', json(body));
});

it('navigates a registration to the fixed root even when its body names an administrator', async () => {
  await submitSingle('/_platform/register', json(ADMIN_LOGIN, 201));
});

it('renders the brand panel without another heading, link, button or live region', () => {
  const { view } = renderAccount();

  expect(view.querySelectorAll('h1, h2, h3, [role="heading"]')).toHaveLength(1);
  expect(view.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(1);
  expect(view.querySelector('fieldset, legend')).toBeNull();
  expect(element(view, '.auth-brand', HTMLElement).textContent).not.toMatch(/登录|注册/);
  expect(element(view, '.auth-brand', HTMLElement).querySelector('a, button')).toBeNull();
});

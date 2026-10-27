// @vitest-environment jsdom

import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  change,
  element,
  renderAccountPage,
  settleSubmit,
  submit,
  type RenderedAccount,
} from '../test/account-dom-fixture.tsx';
import { clearOriginState } from './origin-state.ts';
import { PasswordPage } from './password-page.tsx';

vi.mock('./origin-state.ts', () => ({ clearOriginState: vi.fn() }));
const clear = vi.mocked(clearOriginState);
beforeEach(() => {
  clear.mockReset();
});

function renderPassword(): RenderedAccount {
  const rendered = renderAccountPage(<PasswordPage />, '/_platform/account');
  act(() => {
    change(element(rendered.view, '#current-password', HTMLInputElement), ' 当前 😀 password ');
    change(element(rendered.view, '#new-password', HTMLInputElement), ' 新 😀 password ');
  });
  return rendered;
}

function expectControls(view: HTMLDivElement, pending: boolean): void {
  expect(element(view, '#current-password', HTMLInputElement).disabled).toBe(pending);
  expect(element(view, '#new-password', HTMLInputElement).disabled).toBe(pending);
  expect(element(view, 'button[type="submit"]', HTMLButtonElement).disabled).toBe(pending);
  expect(element(view, 'button[type="button"]', HTMLButtonElement).disabled).toBe(pending);
  expect(element(view, 'form', HTMLFormElement).getAttribute('aria-busy')).toBe(String(pending));
}

async function logout(view: HTMLDivElement): Promise<void> {
  await act(async () => {
    element(view, 'button[type="button"]', HTMLButtonElement).click();
    await Promise.resolve();
  });
}

it('sends unchanged password bytes once and only an empty 204 clears the fields without navigating', async () => {
  const { view, request, navigate } = renderPassword();
  const response = Promise.withResolvers<Response>();
  request.mockReturnValue(response.promise);

  act(() => {
    expect(submit(view).defaultPrevented).toBe(true);
    element(view, 'button[type="button"]', HTMLButtonElement).click();
    submit(view);
  });
  act(() => {
    submit(view);
  });

  expect(request).toHaveBeenCalledExactlyOnceWith('/_platform/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{"currentPassword":" 当前 😀 password ","newPassword":" 新 😀 password "}',
  });
  expectControls(view, true);
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在修改密码…');
  expect(element(view, '#current-password', HTMLInputElement).value).toBe(' 当前 😀 password ');
  expect(element(view, '#new-password', HTMLInputElement).value).toBe(' 新 😀 password ');
  expect(navigate).not.toHaveBeenCalled();

  await act(async () => {
    response.resolve(new Response(null, { status: 204 }));
    await response.promise;
  });

  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('密码修改成功。');
  expect(element(view, '#current-password', HTMLInputElement).value).toBe('');
  expect(element(view, '#new-password', HTMLInputElement).value).toBe('');
  expectControls(view, false);
  expect(navigate).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it('logout fences password submissions and repeated logout before commit and redirects only on empty 204', async () => {
  const { view, request, navigate } = renderPassword();
  const response = Promise.withResolvers<Response>();
  request.mockReturnValue(response.promise);
  act(() => {
    element(view, 'button[type="button"]', HTMLButtonElement).click();
    submit(view);
    element(view, 'button[type="button"]', HTMLButtonElement).click();
  });
  act(() => {
    submit(view);
  });

  expect(request).toHaveBeenCalledExactlyOnceWith('/_platform/api/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{}',
  });
  expectControls(view, true);
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在退出登录…');
  expect(navigate).not.toHaveBeenCalled();

  await act(async () => {
    response.resolve(new Response(null, { status: 204 }));
    await response.promise;
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each<[number, string, string]>([
  [401, '{"message":"Current password is incorrect"}', '当前密码错误，请重试。'],
  [401, '{"message":"Unauthorized private detail"}', '登录状态已失效，请重新登录。'],
  [
    401,
    '{"message":"Current password is incorrect private suffix"}',
    '登录状态已失效，请重新登录。',
  ],
  [401, '{}', '登录状态已失效，请重新登录。'],
  [401, 'null', '登录状态已失效，请重新登录。'],
  [401, '{"message":123}', '登录状态已失效，请重新登录。'],
  [401, 'private malformed JSON', '修改密码失败，请稍后重试。'],
  [400, '{"message":"private policy detail"}', '修改密码失败，请稍后重试。'],
  [403, '{"message":"private Origin detail"}', '修改密码失败，请稍后重试。'],
  [429, 'private detail', '修改密码失败，请稍后重试。'],
  [500, 'private database detail', '修改密码失败，请稍后重试。'],
  [200, '{"message":"not committed"}', '修改密码失败，请稍后重试。'],
  [201, '{}', '修改密码失败，请稍后重试。'],
  [302, '{}', '修改密码失败，请稍后重试。'],
])(
  'keeps password rejection %i (%s) actionable without clearing fields or navigating',
  async (status, body, message) => {
    const { view, request, navigate } = renderPassword();
    request.mockResolvedValue(new Response(body, { status }));

    await settleSubmit(view);

    expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
    expectControls(view, false);
    expect(element(view, '#current-password', HTMLInputElement).value).toBe(' 当前 😀 password ');
    expect(element(view, '#new-password', HTMLInputElement).value).toBe(' 新 😀 password ');
    expect(element(view, 'a[href="/_platform/login"]', HTMLAnchorElement).textContent).toBe('登录');
    expect(navigate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each<[number, string, string]>([
  [401, '{"message":"Unauthorized"}', '登录状态已失效，请重新登录。'],
  [401, 'private malformed JSON', '登录状态已失效，请重新登录。'],
  [400, 'private detail', '退出登录失败，请稍后重试。'],
  [403, '{}', '退出登录失败，请稍后重试。'],
  [500, '{"message":"private database detail"}', '退出登录失败，请稍后重试。'],
  [200, '{}', '退出登录失败，请稍后重试。'],
  [201, '{}', '退出登录失败，请稍后重试。'],
  [302, '{}', '退出登录失败，请稍后重试。'],
])('does not claim logout or navigate after rejection %i (%s)', async (status, body, message) => {
  const { view, request, navigate } = renderPassword();
  request.mockResolvedValue(new Response(body, { status }));

  await logout(view);

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
  expectControls(view, false);
  expect(element(view, '#current-password', HTMLInputElement).value).toBe(' 当前 😀 password ');
  expect(element(view, '#new-password', HTMLInputElement).value).toBe(' 新 😀 password ');
  expect(navigate).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it('recovers from private password transport failure into a corrected change then logout', async () => {
  const { view, request, navigate } = renderPassword();
  request.mockRejectedValueOnce(new Error('private password transport detail'));
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));

  await settleSubmit(view);

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(
    '修改密码失败，请稍后重试。',
  );
  expectControls(view, false);
  expect(navigate).not.toHaveBeenCalled();
  act(() => {
    change(element(view, '#current-password', HTMLInputElement), 'corrected-current');
    change(element(view, '#new-password', HTMLInputElement), 'corrected-new');
  });
  await settleSubmit(view);

  expect(request.mock.calls[1]?.[1]?.body).toBe(
    '{"currentPassword":"corrected-current","newPassword":"corrected-new"}',
  );
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('密码修改成功。');
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
  await logout(view);

  expect(request.mock.calls.map(([url]) => url)).toEqual([
    '/_platform/api/change-password',
    '/_platform/api/change-password',
    '/_platform/api/logout',
  ]);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
});

it('releases a failed logout fence for password change and clears stale feedback while pending', async () => {
  const { view, request, navigate } = renderPassword();
  request.mockRejectedValueOnce(new Error('private logout transport detail'));
  const retry = Promise.withResolvers<Response>();
  request.mockReturnValueOnce(retry.promise);

  await logout(view);

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(
    '退出登录失败，请稍后重试。',
  );
  expectControls(view, false);
  expect(navigate).not.toHaveBeenCalled();
  act(() => {
    submit(view);
  });

  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在修改密码…');
  expectControls(view, true);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    '/_platform/api/logout',
    '/_platform/api/change-password',
  ]);
  await act(async () => {
    retry.resolve(new Response(null, { status: 204 }));
    await retry.promise;
  });

  expectControls(view, false);
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('密码修改成功。');
  expect(navigate).not.toHaveBeenCalled();
});

it('releases a rejected pending change and allows a corrected password to succeed without stale error', async () => {
  const { view, request, navigate } = renderPassword();
  const first = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  request.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  act(() => {
    submit(view);
  });
  await act(async () => {
    first.resolve(new Response('{"message":"Current password is incorrect"}', { status: 401 }));
    await first.promise;
  });

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('当前密码错误，请重试。');
  expectControls(view, false);
  expect(navigate).not.toHaveBeenCalled();
  act(() => {
    change(element(view, '#current-password', HTMLInputElement), 'corrected-current');
  });
  act(() => {
    submit(view);
    element(view, 'button[type="button"]', HTMLButtonElement).click();
  });

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]?.body).toBe(
    '{"currentPassword":"corrected-current","newPassword":" 新 😀 password "}',
  );
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在修改密码…');
  expectControls(view, true);
  await act(async () => {
    retry.resolve(new Response(null, { status: 204 }));
    await retry.promise;
  });

  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('密码修改成功。');
  expect(element(view, '#current-password', HTMLInputElement).value).toBe('');
  expect(element(view, '#new-password', HTMLInputElement).value).toBe('');
  expectControls(view, false);
  expect(navigate).not.toHaveBeenCalled();
});

it('retains backend Unicode password policy and password semantics without an automatic request', () => {
  const { view, request, navigate } = renderPassword();
  for (const [selector, autocomplete] of [
    ['#current-password', 'current-password'],
    ['#new-password', 'new-password'],
  ] satisfies [string, string][]) {
    const input = element(view, selector, HTMLInputElement);
    expect(input.type).toBe('password');
    expect(input.required).toBe(true);
    expect(input.getAttribute('autocomplete')).toBe(autocomplete);
    expect(input.hasAttribute('minlength')).toBe(false);
    expect(input.hasAttribute('maxlength')).toBe(false);
  }
  expect(element(view, 'a[href="/"]', HTMLAnchorElement).textContent).toBe('返回工作台');
  expect(request).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

async function traceMutation(
  run: (view: HTMLDivElement) => void,
  status: number,
  clearing: () => Promise<void>,
  bodyFails = false,
): Promise<{ trail: string[]; navigate: RenderedAccount['navigate'] }> {
  const { view, request, navigate } = renderPassword();
  const trail: string[] = [];
  const response = new Response(null, { status });
  vi.spyOn(response, 'arrayBuffer').mockImplementation(() => {
    trail.push('body');
    return bodyFails
      ? Promise.reject(new Error('body interrupted'))
      : Promise.resolve(new ArrayBuffer(0));
  });
  clear.mockImplementation(() => {
    trail.push('clear');
    return clearing();
  });
  navigate.mockImplementation(() => {
    trail.push('navigate');
  });
  request.mockResolvedValue(response);

  await act(async () => {
    run(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { trail, navigate };
}

function clickLogout(view: HTMLDivElement): void {
  element(view, 'button[type="button"]', HTMLButtonElement).click();
}

it('consumes the logout body, clears origin state, then navigates to login once', async () => {
  const { trail, navigate } = await traceMutation(clickLogout, 204, () => Promise.resolve());

  expect(trail).toEqual(['body', 'clear', 'navigate']);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
});

it('still navigates to login once when clearing origin state rejects', async () => {
  const { trail, navigate } = await traceMutation(clickLogout, 204, () =>
    Promise.reject(new Error('clearing failed')),
  );

  expect(trail).toEqual(['body', 'clear', 'navigate']);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
});

it('still clears and navigates to login once when the logout body read fails', async () => {
  const { trail, navigate } = await traceMutation(clickLogout, 204, () => Promise.resolve(), true);

  expect(trail).toEqual(['body', 'clear', 'navigate']);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
});

it.each<[string, (view: HTMLDivElement) => void, number]>([
  ['a password change', submit, 204],
  ['a rejected logout', clickLogout, 401],
])('never clears origin state after %s', async (_name, run, status) => {
  const { trail, navigate } = await traceMutation(run, status, () => Promise.resolve());

  expect(trail).not.toContain('clear');
  expect(navigate).not.toHaveBeenCalled();
});

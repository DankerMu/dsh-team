// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginPage } from './login-page.tsx';

const mounted: { root: Root; container: HTMLDivElement }[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  try {
    for (const { root, container } of mounted.splice(0)) {
      try {
        act(() => {
          root.unmount();
        });
      } finally {
        container.remove();
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

function renderLogin() {
  const request = vi.fn<typeof fetch>();
  const navigate = vi.fn<(path: string) => void>();
  vi.stubGlobal('fetch', request);
  // jsdom location is nonconfigurable; delegate every other property to the real DOM window.
  vi.stubGlobal(
    'window',
    new Proxy(window, {
      get(target, property): unknown {
        if (property === 'location') return { assign: navigate };
        const value: unknown = Reflect.get(target, property, target);
        return value;
      },
    }),
  );
  const view = document.createElement('div');
  document.body.append(view);
  const root = createRoot(view);
  mounted.push({ root, container: view });
  act(() => {
    root.render(<LoginPage />);
  });
  act(() => {
    change(element(view, '#email', HTMLInputElement), 'person@example.com');
    change(element(view, '#password', HTMLInputElement), ' 密码 unchanged ');
  });
  return { view, request, navigate };
}

function element<T extends Element>(view: HTMLDivElement, selector: string, ctor: new () => T): T {
  const found = view.querySelector(selector);
  if (found === null) throw new Error(`Missing login element: ${selector}`);
  if (!(found instanceof ctor)) throw new Error(`Unexpected login element type: ${selector}`);
  return found;
}

function change(input: HTMLInputElement, value: string) {
  // The native setter bypasses React's value tracker so the real input event updates state.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (typeof descriptor?.set !== 'function') throw new Error('Missing native input value setter');
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(view: HTMLDivElement) {
  // Dispatch through the real DOM/React event system; browser validation is covered by UI.
  const event = new Event('submit', { bubbles: true, cancelable: true });
  element(view, 'form', HTMLFormElement).dispatchEvent(event);
  return event;
}

async function settleSubmit(view: HTMLDivElement): Promise<void> {
  await act(async () => {
    submit(view);
    // Async act drains the fetch/JSON continuations and their resulting React state.
    await Promise.resolve();
  });
}

it('shows pending and sends only one credential request before navigating to the fixed root', async () => {
  const { view, request, navigate } = renderLogin();
  const response = Promise.withResolvers<Response>();
  request.mockReturnValue(response.promise);

  act(() => {
    expect(submit(view).defaultPrevented).toBe(true);
    submit(view);
  });
  act(() => {
    submit(view);
  });

  expect(request).toHaveBeenCalledExactlyOnceWith('/_platform/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{"email":"person@example.com","password":" 密码 unchanged "}',
  });
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('正在登录…');
  expect(element(view, '#email', HTMLInputElement).disabled).toBe(true);
  expect(element(view, '#password', HTMLInputElement).disabled).toBe(true);
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(true);
  expect(element(view, 'form', HTMLFormElement).getAttribute('aria-busy')).toBe('true');
  expect(navigate).not.toHaveBeenCalled();

  await act(async () => {
    response.resolve(new Response('{}', { status: 200 }));
    await response.promise;
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it('recovers from a pending rejection and clears the previous error while retrying successfully', async () => {
  const { view, request, navigate } = renderLogin();
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

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('邮箱或密码错误。');
  expect(element(view, '#email', HTMLInputElement).disabled).toBe(false);
  expect(element(view, '#password', HTMLInputElement).disabled).toBe(false);
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
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
    const { view, request, navigate } = renderLogin();
    request.mockResolvedValue(new Response(body, { status }));

    await settleSubmit(view);

    expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
    expect(element(view, 'form', HTMLFormElement).getAttribute('aria-busy')).toBe('false');
    expect(element(view, '#password', HTMLInputElement).value).toBe(' 密码 unchanged ');
    expect(element(view, '#password', HTMLInputElement).disabled).toBe(false);
    expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it('recovers from network failure without rendering private transport diagnostics', async () => {
  const { view, request, navigate } = renderLogin();
  request.mockRejectedValueOnce(new Error('private transport and password detail'));
  request.mockResolvedValueOnce(new Response('{}', { status: 200 }));

  await settleSubmit(view);

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('登录失败，请稍后重试。');
  expect(element(view, '#email', HTMLInputElement).disabled).toBe(false);
  expect(element(view, '#password', HTMLInputElement).disabled).toBe(false);
  expect(navigate).not.toHaveBeenCalled();

  await settleSubmit(view);

  expect(request).toHaveBeenCalledTimes(2);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

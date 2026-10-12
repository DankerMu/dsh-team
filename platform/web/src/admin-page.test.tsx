// @vitest-environment jsdom

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { change, element, renderAccountPage } from '../test/account-dom-fixture.tsx';
import { AccountPage } from './account-page.tsx';
import { AdminPage } from './admin-page.tsx';

const ACTIVE = {
  id: 'abcdefghijkl',
  email: 'employee@example.com',
  role: 'employee',
  status: 'active',
  createdAt: 1_700_000_000_000,
};
const DISABLED = {
  id: 'mnopqrstuvwx',
  email: 'disabled@example.com',
  role: 'admin',
  status: 'disabled',
  createdAt: 1_700_000_000_001,
};
const LIST = { items: [ACTIVE, DISABLED], page: 1, pageSize: 20, total: 2 };

function receipt(body: unknown = LIST, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
function button(view: HTMLDivElement, text: string): HTMLButtonElement {
  const result = [...view.querySelectorAll('button')].find((item) => item.textContent === text);
  if (result === undefined) throw new Error(`Missing button ${text}`);
  return result;
}
async function click(view: HTMLDivElement, text: string): Promise<void> {
  await act(async () => {
    button(view, text).click();
    await Promise.resolve();
  });
}
async function searchFor(view: HTMLDivElement, value: string): Promise<void> {
  await act(async () => {
    change(element(view, '#account-search', HTMLInputElement), value);
    await Promise.resolve();
  });
  await click(view, '搜索');
}
async function confirm(view: HTMLDivElement): Promise<void> {
  await act(async () => {
    element(view, 'dialog form', HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}
async function ready(request = vi.fn<typeof fetch>().mockResolvedValue(receipt())) {
  const rendered = renderAccountPage(<AdminPage />, '/_platform/admin', request);
  await settle();
  return rendered;
}

it('opens accounts at the declared pathname with server identities, times and implemented navigation', async () => {
  const { view } = renderAccountPage(
    <AccountPage />,
    '/_platform/admin',
    vi.fn<typeof fetch>().mockResolvedValue(receipt()),
  );
  await settle();

  expect(element(view, 'h1', HTMLHeadingElement).textContent).toBe('账号管理');
  expect(
    [...view.querySelectorAll('nav a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ]),
  ).toEqual([
    ['账号管理', '/_platform/admin'],
    ['账号设置', '/_platform/account'],
    ['返回工作台', '/'],
  ]);
  expect(view.textContent).toContain(ACTIVE.email);
  expect(view.textContent).toContain('员工');
  expect(view.textContent).toContain('管理员');
  expect(view.textContent).toContain('已禁用');
  expect(element(view, 'time', HTMLTimeElement).dateTime).toBe('2023-11-14T22:13:20.000Z');
  expect(button(view, '上一页').disabled).toBe(true);
  expect(button(view, '下一页').disabled).toBe(true);
});

it('keeps loading separate from true empty accounts and a real submitted no-match search', async () => {
  const held = Promise.withResolvers<Response>();
  const empty = { items: [], page: 1, pageSize: 20, total: 0 };
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(receipt(empty));
  const { view } = renderAccountPage(<AdminPage />, '/_platform/admin', request);
  expect(view.textContent).toContain('加载中…');
  expect(view.querySelector('table')).toBeNull();
  await act(async () => {
    held.resolve(receipt(empty));
    await Promise.resolve();
  });
  expect(view.textContent).toContain('暂无账号');
  expect(view.textContent).not.toContain('没有匹配');

  await searchFor(view, 'nobody');

  expect(view.textContent).toContain('没有匹配的账号');
  expect(view.textContent).not.toContain('暂无账号');
});

it.each(['network', 'status', 'json'] as const)(
  'shows a safe list failure for %s and retries the current query',
  async (failure) => {
    const request = vi.fn<typeof fetch>();
    if (failure === 'network') request.mockRejectedValueOnce(new Error('private-network-password'));
    else
      request.mockResolvedValueOnce(
        failure === 'status' ? receipt({}, 500) : new Response('private-invalid-json'),
      );
    request.mockResolvedValueOnce(receipt());
    const { view } = renderAccountPage(<AdminPage />, '/_platform/admin', request);
    await settle();
    expect(view.textContent).toContain('加载失败');
    expect(view.textContent).not.toContain('暂无账号');
    expect(view.textContent).not.toContain('private');

    await click(view, '重试');

    expect(view.textContent).toContain(ACTIVE.email);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/_platform/api/admin/users?page=1&pageSize=20',
      '/_platform/api/admin/users?page=1&pageSize=20',
    ]);
  },
);

it.each([
  null,
  [],
  {},
  { ...LIST, items: null },
  { ...LIST, page: 2 },
  { ...LIST, pageSize: 50 },
  { ...LIST, total: -1 },
  { ...LIST, total: 1.5 },
  { ...LIST, total: '2' },
  { ...LIST, items: [null] },
  { ...LIST, items: [{}] },
  { ...LIST, items: [{ id: ACTIVE.id, email: ACTIVE.email, role: ACTIVE.role }] },
  { ...LIST, items: [{ ...ACTIVE, email: 42 }] },
  ...['id', 'role', 'status', 'createdAt'].map((key) => ({
    ...LIST,
    items: [{ ...ACTIVE, [key]: 'unsafe' }],
  })),
  { ...LIST, items: [{ ...ACTIVE, createdAt: 9_000_000_000_000_000 }] },
  { ...LIST, items: Array.from({ length: 21 }, () => ACTIVE), total: 21 },
])('does not treat malformed account data %j as authorized rows or empty results', async (body) => {
  const { view } = await ready(vi.fn<typeof fetch>().mockResolvedValue(receipt(body)));

  expect(view.textContent).toContain('加载失败');
  expect(view.querySelector('table')).toBeNull();
  expect(view.querySelector('dialog')).toBeNull();
});

it.each([401, 403])('does not expose accounts after authority status %i', async (status) => {
  const { view, navigate } = await ready(
    vi.fn<typeof fetch>().mockResolvedValue(receipt(LIST, status)),
  );

  expect(view.textContent).toContain('无权限');
  expect(view.textContent).not.toContain(ACTIVE.email);
  expect(view.querySelector('table')).toBeNull();
  expect(view.querySelector('form')).toBeNull();
  expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
});

it('pages the server list and resets a safely encoded explicit search to page one', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt({ ...LIST, total: 21 }))
    .mockResolvedValueOnce(receipt({ items: [DISABLED], page: 2, pageSize: 20, total: 21 }))
    .mockResolvedValueOnce(receipt({ items: [], page: 1, pageSize: 20, total: 0 }))
    .mockResolvedValueOnce(receipt({ items: [], page: 1, pageSize: 20, total: 0 }));
  const { view } = await ready(request);
  await click(view, '下一页');
  expect(view.textContent).toContain('第 2 页');
  expect(button(view, '上一页').disabled).toBe(false);
  await searchFor(view, '  a+b&中文  ');
  expect(view.textContent).toContain('第 1 页');
  await searchFor(view, '');

  expect(request.mock.calls.map(([url]) => url)).toEqual([
    '/_platform/api/admin/users?page=1&pageSize=20',
    '/_platform/api/admin/users?page=2&pageSize=20',
    '/_platform/api/admin/users?page=1&pageSize=20&search=a%2Bb%26%E4%B8%AD%E6%96%87',
    '/_platform/api/admin/users?page=1&pageSize=20',
  ]);
});

it('returns to the previous page through the same server query', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt({ ...LIST, total: 21 }))
    .mockResolvedValueOnce(receipt({ items: [DISABLED], page: 2, pageSize: 20, total: 21 }))
    .mockResolvedValueOnce(receipt({ ...LIST, total: 21 }));
  const { view } = await ready(request);
  await click(view, '下一页');
  await click(view, '上一页');

  expect(view.textContent).toContain('第 1 页');
  expect(request.mock.calls[2]?.[0]).toBe('/_platform/api/admin/users?page=1&pageSize=20');
});

it.each([200, 401, 403, 500])(
  'ignores obsolete response status %i after a newer search completes',
  async (status) => {
    const held = Promise.withResolvers<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(receipt({ ...LIST, items: [DISABLED], total: 1 }));
    const { view, navigate } = renderAccountPage(<AdminPage />, '/_platform/admin', request);
    const signal = request.mock.calls[0]?.[1]?.signal;
    await searchFor(view, 'disabled');
    await act(async () => {
      held.resolve(receipt(LIST, status));
      await Promise.resolve();
    });

    expect(signal?.aborted).toBe(true);
    expect(view.textContent).toContain(DISABLED.email);
    expect(view.textContent).not.toContain(ACTIVE.email);
    expect(view.textContent).not.toContain('加载失败');
    expect(navigate).not.toHaveBeenCalled();
  },
);

it.each(['resolve', 'reject'] as const)(
  'ignores obsolete JSON %s and obsolete network failure',
  async (kind) => {
    const json = Promise.withResolvers<unknown>();
    const old = receipt();
    vi.spyOn(old, 'json').mockReturnValue(json.promise);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(receipt({ ...LIST, items: [DISABLED], total: 1 }));
    const { view } = renderAccountPage(<AdminPage />, '/_platform/admin', request);
    await settle();
    await searchFor(view, 'disabled');
    await act(async () => {
      if (kind === 'resolve') json.resolve(LIST);
      else json.reject(new Error('private JSON error'));
      await Promise.resolve();
    });
    expect(view.textContent).not.toContain(ACTIVE.email);
    expect(view.textContent).toContain(DISABLED.email);

    const network = Promise.withResolvers<Response>();
    request.mockReturnValueOnce(network.promise).mockResolvedValueOnce(receipt());
    await searchFor(view, 'old');
    await searchFor(view, 'current');
    await act(async () => {
      network.reject(new Error('private old error'));
      await Promise.resolve();
    });
    expect(view.textContent).toContain(ACTIVE.email);
    expect(view.textContent).not.toContain('加载失败');
  },
);

it('aborts departure reads and cannot navigate from late authorization or JSON', async () => {
  const held = Promise.withResolvers<Response>();
  const request = vi.fn<typeof fetch>().mockReturnValueOnce(held.promise);
  const { unmount, navigate } = renderAccountPage(<AdminPage />, '/_platform/admin', request);
  const signal = request.mock.calls[0]?.[1]?.signal;
  unmount();
  await act(async () => {
    held.resolve(receipt({}, 401));
    await Promise.resolve();
  });

  expect(signal?.aborted).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['取消', 'Escape', 'cancel'] as const)(
  'clears a masked reset secret and sends no mutation on %s',
  async (cancel) => {
    const { view, request } = await ready();
    await click(view, '重置密码');
    await act(async () => {
      change(element(view, '#reset-password', HTMLInputElement), 'never-persist-secret');
      await Promise.resolve();
    });
    expect(element(view, '#reset-password', HTMLInputElement).type).toBe('password');
    await act(async () => {
      if (cancel === '取消') button(view, '取消').click();
      else
        element(view, 'dialog', HTMLDialogElement).dispatchEvent(
          cancel === 'Escape'
            ? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
            : new Event('cancel', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(view.querySelector('dialog')).toBeNull();
    await click(view, '重置密码');

    expect(element(view, '#reset-password', HTMLInputElement).value).toBe('');
    expect(request).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  },
);

it('captures the chosen target and never mutates on selection or canceled disable', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(receipt());
  const { view } = await ready(request);
  await click(view, '禁用');
  expect(element(view, 'dialog', HTMLDialogElement).textContent).toContain(ACTIVE.email);
  expect(request).toHaveBeenCalledTimes(1);
  await click(view, '取消');
  await click(view, '启用');
  expect(element(view, 'dialog', HTMLDialogElement).textContent).toContain(DISABLED.email);
  await confirm(view);

  expect(request.mock.calls[1]?.[0]).toBe('/_platform/api/admin/users/mnopqrstuvwx/status');
  expect(request.mock.calls[1]?.[1]?.body).toBe('{"status":"active"}');
  expect(view.querySelector('dialog')).toBeNull();
});

it('fences duplicate and crossing actions synchronously, then refreshes rather than optimistically enabling', async () => {
  const held = Promise.withResolvers<Response>();
  const refreshed = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockReturnValueOnce(held.promise)
    .mockReturnValueOnce(refreshed.promise);
  const { view } = await ready(request);
  await click(view, '禁用');
  await act(async () => {
    const form = element(view, 'dialog form', HTMLFormElement);
    for (let count = 0; count < 2; count++)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(button(view, '正在提交…').disabled).toBe(true);
  expect(button(view, '搜索').disabled).toBe(true);
  expect(button(view, '取消').disabled).toBe(true);
  await click(view, '启用');
  await click(view, '搜索');
  await act(async () => {
    element(view, 'dialog', HTMLDialogElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    element(view, 'form[aria-label="搜索账号"]', HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: 'PUT',
    body: '{"status":"disabled"}',
  });
  expect(view.textContent).toContain(ACTIVE.email);
  await act(async () => {
    held.resolve(new Response(null, { status: 204 }));
    await Promise.resolve();
  });
  expect(view.textContent).toContain('加载中…');
  expect(view.querySelector('table')).toBeNull();
  await act(async () => {
    refreshed.resolve(receipt({ ...LIST, items: [{ ...ACTIVE, status: 'disabled' }] }));
    await Promise.resolve();
  });

  expect(view.textContent).toContain('已禁用');
  expect(request).toHaveBeenCalledTimes(3);
});

it('resets only the confirmed password and clears it before observing refreshed server state', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(receipt());
  const { view } = await ready(request);
  await click(view, '重置密码');
  await act(async () => {
    change(element(view, '#reset-password', HTMLInputElement), ' new-中文-password ');
    await Promise.resolve();
  });
  await confirm(view);
  expect(request.mock.calls[1]?.[0]).toBe('/_platform/api/admin/users/abcdefghijkl/password');
  expect(request.mock.calls[1]?.[1]?.body).toBe('{"newPassword":" new-中文-password "}');
  await click(view, '重置密码');

  expect(element(view, '#reset-password', HTMLInputElement).value).toBe('');
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([400, 409, 500, 'network'] as const)(
  'shows safe mutation failure %s and reads possible partial effects without retrying the mutation',
  async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt());
    if (status === 'network')
      request.mockRejectedValueOnce(new Error('private password diagnostic'));
    else request.mockResolvedValueOnce(receipt({ message: 'private password diagnostic' }, status));
    request.mockResolvedValueOnce(receipt({ ...LIST, items: [{ ...ACTIVE, status: 'disabled' }] }));
    const { view } = await ready(request);
    await click(view, status === 400 ? '重置密码' : '禁用');
    if (status === 400)
      await act(async () => {
        change(element(view, '#reset-password', HTMLInputElement), '12345');
        await Promise.resolve();
      });
    await confirm(view);

    expect(view.textContent).toContain(
      status === 400 ? '6–256' : status === 409 ? '不能禁用自己' : '状态可能已变更',
    );
    expect(view.textContent).toContain('已禁用');
    expect(view.textContent).not.toContain('private');
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it.each([401, 403])(
  'clears rows and reset dialog after mutation authority status %i without a refresh',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(receipt({}, status));
    const { view, navigate } = await ready(request);
    await click(view, '重置密码');
    await act(async () => {
      change(element(view, '#reset-password', HTMLInputElement), 'cleared-secret');
      await Promise.resolve();
    });
    await confirm(view);

    expect(view.textContent).toContain('无权限');
    expect(view.textContent).not.toContain(ACTIVE.email);
    expect(view.querySelector('dialog')).toBeNull();
    expect(view.querySelector('table')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
  },
);

it.each(['success', 'unauthorized', 'network'] as const)(
  'does not claim cancellation or publish a late mutation %s after departure',
  async (outcome) => {
    const held = Promise.withResolvers<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockReturnValueOnce(held.promise);
    const { view, unmount, navigate } = await ready(request);
    await click(view, '禁用');
    await confirm(view);
    unmount();
    await act(async () => {
      if (outcome === 'network') held.reject(new Error('late failure'));
      else held.resolve(new Response(null, { status: outcome === 'success' ? 204 : 401 }));
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]?.signal).toBeUndefined();
  },
);

it.each([401, 403, 500])(
  'settles rejected list status %i only after body completion and preserves unreadable authority',
  async (status) => {
    for (const unreadable of [false, true]) {
      const body = Promise.withResolvers<ArrayBuffer>();
      const response = receipt({}, status);
      vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
      const { view, request, navigate, unmount } = await ready(
        vi.fn<typeof fetch>().mockResolvedValueOnce(response),
      );
      expect(view.textContent).toContain('加载中…');
      expect(navigate).not.toHaveBeenCalled();
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      await act(async () => {
        if (unreadable) body.reject(new Error('private body failure'));
        else body.resolve(new ArrayBuffer(0));
        await Promise.resolve();
      });

      expect(view.textContent).toContain(status === 500 ? '加载失败' : '无权限');
      expect(view.textContent).not.toContain('private');
      expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      unmount();
    }
  },
);

it.each(['resolve', 'reject'] as const)(
  'cannot apply stale authority after rejected body completion %s',
  async (outcome) => {
    const body = Promise.withResolvers<ArrayBuffer>();
    const old = receipt({}, 401);
    vi.spyOn(old, 'arrayBuffer').mockReturnValue(body.promise);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(receipt());
    const { view, navigate } = await ready(request);
    await searchFor(view, 'current');

    await act(async () => {
      if (outcome === 'resolve') body.resolve(new ArrayBuffer(0));
      else body.reject(new Error('stale body failure'));
      await Promise.resolve();
    });

    expect(view.textContent).toContain(ACTIVE.email);
    expect(view.textContent).not.toContain('无权限');
    expect(navigate).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  },
);

it('holds the mutation fence through empty response completion before reading server state', async () => {
  const body = Promise.withResolvers<ArrayBuffer>();
  const response = new Response(null, { status: 204 });
  vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce(receipt({ ...LIST, items: [{ ...ACTIVE, status: 'disabled' }] }));
  const { view } = await ready(request);
  await click(view, '禁用');
  await confirm(view);
  expect(button(view, '正在提交…').disabled).toBe(true);
  expect(view.textContent).toContain('已启用');
  await confirm(view);
  expect(request).toHaveBeenCalledTimes(2);

  await act(async () => {
    body.resolve(new ArrayBuffer(0));
    await Promise.resolve();
  });

  expect(request).toHaveBeenCalledTimes(3);
  expect(view.querySelector('dialog')).toBeNull();
  expect(view.textContent).toContain('已禁用');
  expect(view.textContent).not.toContain('已启用');
});

it.each([204, 400, 401, 403])(
  'an unreadable mutation response %i never claims success or masks authority',
  async (status) => {
    const response = status === 204 ? new Response(null, { status }) : receipt({}, status);
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('private transport body'));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(receipt());
    const { view, navigate } = await ready(request);
    await click(view, '禁用');

    await confirm(view);

    expect(view.textContent).toContain(
      status === 401 || status === 403 ? '无权限' : '状态可能已变更',
    );
    expect(view.textContent).not.toContain('private');
    expect(view.querySelector('dialog')).toBeNull();
    expect(request).toHaveBeenCalledTimes(status === 401 || status === 403 ? 2 : 3);
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
  },
);

it.each(['resolve', 'reject'] as const)(
  'suppresses mutation body completion %s after departure without canceling accepted work',
  async (outcome) => {
    const body = Promise.withResolvers<ArrayBuffer>();
    const response = receipt({}, 401);
    vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(response);
    const { view, unmount, navigate } = await ready(request);
    await click(view, '禁用');
    await confirm(view);
    unmount();

    await act(async () => {
      if (outcome === 'resolve') body.resolve(new ArrayBuffer(0));
      else body.reject(new Error('late body failure'));
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]?.signal).toBeUndefined();
  },
);

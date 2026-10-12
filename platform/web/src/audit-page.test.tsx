// @vitest-environment jsdom

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import {
  createJsonReceipt,
  click,
  draft,
  element,
  finishResponseBody,
  holdResponseBody,
  renderAccountPage,
  renderSettledAccountPage,
  settle,
  settleSubmit,
} from '../test/account-dom-fixture.tsx';
import { AccountPage } from './account-page.tsx';
import { AuditPage } from './audit-page.tsx';

const ITEM = {
  id: 7,
  createdAt: 0,
  type: 'instance.stopped',
  actorEmail: 'actor@example.com',
  targetEmail: 'target@example.com',
  target: 'owned-target',
  sourceAddress: '192.0.2.76',
  details: { reason: 'admin' },
};
const LIST = { items: [ITEM], page: 1, pageSize: 20 };
const receipt = createJsonReceipt(LIST);
async function ready(request = vi.fn<typeof fetch>().mockResolvedValue(receipt())) {
  return renderSettledAccountPage(<AuditPage />, '/_platform/admin/audit', request);
}
function localValue(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

it('dispatches the exact audit page and displays only safe metadata and local timestamps', async () => {
  const { view, request } = renderAccountPage(
    <AccountPage />,
    '/_platform/admin/audit',
    vi.fn<typeof fetch>().mockResolvedValue(
      receipt({
        ...LIST,
        items: [
          {
            ...ITEM,
            type: '<unknown-event>',
            details: { reason: 'idle', content: 'private-content' },
            password: 'private-password',
          },
        ],
      }),
    ),
  );
  await settle();

  expect(element(view, 'h1', HTMLHeadingElement).textContent).toBe('审计日志');
  expect(view.textContent).toContain('<unknown-event>');
  expect(view.textContent).toContain('空闲');
  expect(view.textContent).toContain('owned-target');
  expect(view.textContent).not.toContain('private');
  expect(element(view, 'time', HTMLTimeElement).dateTime).toBe('1970-01-01T00:00:00.000Z');
  expect(element(view, 'a[aria-current="page"]', HTMLAnchorElement).pathname).toBe(
    '/_platform/admin/audit',
  );
  expect(request.mock.calls[0]?.[0]).toBe('/_platform/api/admin/audit-events?page=1&pageSize=20');
});

it('keeps draft edits local and submits encoded filters with independent inclusive epoch-zero bounds', async () => {
  const { view, request } = await ready();
  await draft(view, '#audit-email', ' A+B&中文 ');
  await draft(view, 'input[type="datetime-local"]', localValue(0));
  expect(request).toHaveBeenCalledTimes(1);
  await settleSubmit(view);
  expect(request.mock.calls[1]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&email=A%2BB%26%E4%B8%AD%E6%96%87&from=0',
  );
  await draft(view, '#audit-email', '');
  await draft(view, 'input[type="datetime-local"]', '');
  await draft(view, 'label:last-of-type input', localValue(1001));
  await settleSubmit(view);
  expect(request.mock.calls[2]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&to=1001',
  );
  await draft(view, 'input[type="datetime-local"]', localValue(1000));
  await settleSubmit(view);
  expect(request.mock.calls[3]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&from=1000&to=1001',
  );
});

it.each([
  'invalid',
  '2024-02-30T12:00',
  '0000-01-01T12:00',
  '999999999-01-01T00:00',
  localValue(-1),
])('rejects unrepresentable or negative local time %s without another query', async (value) => {
  const { view, request } = await ready();
  // Real browser normalizes invalid controls; exercise the raw DOM boundary independently.
  element(view, 'input[type="datetime-local"]', HTMLInputElement).type = 'text';
  await draft(view, 'label input[type="text"]', value);
  await settleSubmit(view);

  expect(view.textContent).toContain('时间范围无效');
  expect(view.textContent).not.toContain('加载失败');
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects reversed time bounds without clearing the last successful rows', async () => {
  const { view, request } = await ready();
  await draft(view, 'input[type="datetime-local"]', localValue(2000));
  await draft(view, 'label:last-of-type input', localValue(1000));
  await settleSubmit(view);

  expect(view.textContent).toContain('时间范围无效');
  expect(view.textContent).toContain(ITEM.target);
  expect(request).toHaveBeenCalledTimes(1);
});

it('distinguishes loading, true empty and submitted no-match', async () => {
  const held = Promise.withResolvers<Response>();
  const empty = { items: [], page: 1, pageSize: 20 };
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(receipt(empty));
  const { view } = renderAccountPage(<AuditPage />, '/_platform/admin/audit', request);
  expect(view.textContent).toContain('加载中…');
  expect(view.querySelector('table')).toBeNull();
  await settle(() => {
    held.resolve(receipt(empty));
  });
  expect(view.textContent).toContain('暂无审计记录');
  await draft(view, '#audit-email', 'absent@example.com');
  await settleSubmit(view);
  expect(view.textContent).toContain('没有匹配的审计记录');
  expect(view.textContent).not.toContain('暂无审计记录');
});

it.each(['network', 'status', 'json'] as const)(
  'shows safe %s failure and retries submitted filters',
  async (kind) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt());
    if (kind === 'network') request.mockRejectedValueOnce(new Error('private-network'));
    else
      request.mockResolvedValueOnce(
        kind === 'status'
          ? receipt({ message: 'private-status' }, 500)
          : new Response('private-json'),
      );
    request.mockResolvedValueOnce(receipt());
    const { view } = await ready(request);
    await draft(view, '#audit-email', 'target@example.com');
    await settleSubmit(view);
    expect(view.textContent).toContain('加载失败');
    expect(view.textContent).not.toContain('private');
    await draft(view, '#audit-email', 'unsent');
    await click(view, '重试');

    expect(view.textContent).toContain(ITEM.target);
    expect(request.mock.calls[2]?.[0]).toBe(
      '/_platform/api/admin/audit-events?page=1&pageSize=20&email=target%40example.com',
    );
  },
);

it.each([
  null,
  [],
  {},
  { ...LIST, items: null },
  { ...LIST, page: 2 },
  { ...LIST, pageSize: 50 },
  { ...LIST, items: Array.from({ length: 21 }, () => ITEM) },
  ...[
    null,
    {},
    { ...ITEM, id: 0 },
    { ...ITEM, id: 1.5 },
    { ...ITEM, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...ITEM, createdAt: 8_640_000_000_000_001 },
    { ...ITEM, createdAt: 0.5 },
    { ...ITEM, createdAt: null },
    { ...ITEM, type: 42 },
    { ...ITEM, actorEmail: false },
    { ...ITEM, targetEmail: 42 },
    { ...ITEM, target: [] },
    { ...ITEM, sourceAddress: {} },
    { ...ITEM, details: null },
    { ...ITEM, details: [] },
    { ...ITEM, details: { reason: 'constructor' } },
    { ...ITEM, details: { reason: 42 } },
    { id: 7 },
    { id: 7, createdAt: 0 },
    { id: 7, createdAt: 0, type: 'login.failed' },
    { ...ITEM, details: undefined },
  ].map((item) => ({ ...LIST, items: [item] })),
])('rejects malformed used DTO %j instead of false empty or unsafe rows', async (body) => {
  const { view } = await ready(vi.fn<typeof fetch>().mockResolvedValue(receipt(body)));

  expect(view.textContent).toContain('加载失败');
  expect(view.querySelector('table')).toBeNull();
  expect(view.textContent).not.toContain('暂无审计记录');
});

it('renders nullable metadata and both representable Date-domain endpoints safely', async () => {
  const items = [-8_640_000_000_000_000, 8_640_000_000_000_000].map((createdAt, index) => ({
    ...ITEM,
    id: index + 1,
    createdAt,
    actorEmail: null,
    targetEmail: null,
    target: null,
    sourceAddress: null,
    details: {},
  }));
  const { view } = await ready(
    vi.fn<typeof fetch>().mockResolvedValue(receipt({ ...LIST, items })),
  );

  expect([...view.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
    '-271821-04-20T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',
  ]);
  expect(view.textContent).toContain('—');
  expect(view.textContent).not.toContain('加载失败');
});

it('keeps no-total terminal empty pagination navigable and filter submission resets page one', async () => {
  const full = Array.from({ length: 20 }, (_, index) => ({ ...ITEM, id: index + 1 }));
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt({ ...LIST, items: full }))
    .mockResolvedValueOnce(receipt({ items: [], page: 2, pageSize: 20 }))
    .mockResolvedValueOnce(receipt({ ...LIST, items: full }))
    .mockResolvedValueOnce(receipt({ items: [], page: 2, pageSize: 20 }))
    .mockResolvedValueOnce(receipt({ items: [], page: 1, pageSize: 20 }));
  const { view } = await ready(request);
  await click(view, '下一页');
  expect(view.textContent).toContain('本页没有审计记录');
  expect(view.textContent).not.toContain('暂无审计记录');
  expect(
    [...view.querySelectorAll('button')].find((button) => button.textContent === '下一页')
      ?.disabled,
  ).toBe(true);
  await click(view, '上一页');
  expect(view.textContent).toContain('第 1 页');
  await click(view, '下一页');
  await draft(view, '#audit-email', 'absent');
  await settleSubmit(view);

  expect(view.textContent).toContain('第 1 页');
  expect(view.textContent).toContain('没有匹配的审计记录');
  expect(view.textContent).not.toContain('共');
  expect(request.mock.calls[4]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&email=absent',
  );
});

it.each([401, 403, 500])(
  'waits for current rejected %i body before settling authority or failure',
  async (status) => {
    for (const outcome of ['resolve', 'reject']) {
      const response = receipt({ message: 'private' }, status);
      const body = holdResponseBody(response);
      const { view, navigate, request, unmount } = await ready(
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      expect(view.textContent).toContain('加载中…');
      expect(navigate).not.toHaveBeenCalled();
      await finishResponseBody(body, outcome === 'reject', 'private body');
      expect(view.textContent).toContain(status === 500 ? '加载失败' : '无权限');
      expect(view.querySelector('table')).toBeNull();
      expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      unmount();
    }
  },
);

it.each([200, 401, 403, 500])(
  'ignores obsolete headers %i and does not navigate or replace current rows',
  async (status) => {
    const held = Promise.withResolvers<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(receipt());
    const { view, navigate } = renderAccountPage(<AuditPage />, '/_platform/admin/audit', request);
    await draft(view, '#audit-email', 'current');
    await settleSubmit(view);
    await settle(() => {
      held.resolve(receipt({}, status));
    });

    expect(view.textContent).toContain(ITEM.target);
    expect(view.textContent).not.toContain('无权限');
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it.each(['json', 'rejection-body', 'network'] as const)(
  'ignores stale %s completion and rejection',
  async (stage) => {
    for (const outcome of ['resolve', 'reject']) {
      const held = Promise.withResolvers<unknown>();
      const body = Promise.withResolvers<ArrayBuffer>();
      const response = receipt({}, stage === 'rejection-body' ? 403 : 200);
      if (stage === 'json') vi.spyOn(response, 'json').mockReturnValue(held.promise);
      if (stage === 'rejection-body')
        vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
      const request = vi.fn<typeof fetch>();
      if (stage === 'network')
        request.mockImplementationOnce(async () => {
          await held.promise;
          return response;
        });
      else request.mockResolvedValueOnce(response);
      request.mockResolvedValueOnce(receipt());
      const { view, navigate, unmount } = await ready(request);
      await draft(view, '#audit-email', 'current');
      await settleSubmit(view);
      await act(async () => {
        if (stage === 'rejection-body') {
          if (outcome === 'resolve') body.resolve(new ArrayBuffer(0));
          else body.reject(new Error('private-stale'));
        } else if (outcome === 'resolve')
          held.resolve({ ...LIST, items: [{ ...ITEM, target: 'stale' }] });
        else held.reject(new Error('private-stale'));
        await Promise.resolve();
      });
      expect(view.textContent).toContain(ITEM.target);
      expect(view.textContent).not.toContain('stale');
      expect(view.textContent).not.toContain('无权限');
      expect(navigate).not.toHaveBeenCalled();
      unmount();
    }
  },
);

it.each(['headers', 'json', 'rejection-body'] as const)(
  'departure cancels unfinished %s and blocks late authority',
  async (stage) => {
    const held = Promise.withResolvers<unknown>();
    const body = Promise.withResolvers<ArrayBuffer>();
    const response = receipt({}, stage === 'json' ? 200 : 401);
    const request = vi.fn<typeof fetch>();
    if (stage === 'headers')
      request.mockImplementationOnce(async () => {
        await held.promise;
        return response;
      });
    else {
      if (stage === 'json') vi.spyOn(response, 'json').mockReturnValue(held.promise);
      else vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
      request.mockResolvedValueOnce(response);
    }
    const { navigate, unmount } = await ready(request);
    unmount();
    await act(async () => {
      if (stage === 'rejection-body') body.resolve(new ArrayBuffer(0));
      else held.resolve(LIST);
      await Promise.resolve();
    });

    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it('submits an event choice and can clear submitted time and email filters', async () => {
  const { view, request } = await ready();
  await act(async () => {
    const select = element(view, '#audit-type', HTMLSelectElement);
    select.value = 'login.failed';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await settleSubmit(view);

  expect(request.mock.calls[1]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&eventType=login.failed',
  );
  await draft(view, '#audit-email', 'filtered@example.com');
  await draft(view, 'input[type="datetime-local"]', localValue(0));
  await draft(view, 'label:last-of-type input', localValue(1000));
  await settleSubmit(view);
  await draft(view, '#audit-email', '');
  await draft(view, 'input[type="datetime-local"]', '');
  await draft(view, 'label:last-of-type input', '');
  await settleSubmit(view);
  expect(request.mock.calls[3]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&eventType=login.failed',
  );
});

it('accepts the maximum representable local date and clears validation on valid submission', async () => {
  const { view, request } = await ready();
  element(view, 'input[type="datetime-local"]', HTMLInputElement).type = 'text';
  await draft(view, 'label input[type="text"]', 'invalid');
  await settleSubmit(view);
  expect(view.textContent).toContain('时间范围无效');
  await draft(view, 'label input[type="text"]', localValue(8_640_000_000_000_000));
  await settleSubmit(view);

  expect(request.mock.calls[1]?.[0]).toBe(
    '/_platform/api/admin/audit-events?page=1&pageSize=20&from=8640000000000000',
  );
  expect(view.textContent).not.toContain('时间范围无效');
});

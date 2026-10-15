// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
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

const PATH = '/_platform/admin/instances';
const STATES = ['not-created', 'stopped', 'starting', 'running', 'error'] as const;
const ITEMS = STATES.map((status, index) => ({
  userId: `instance000${String(index)}`,
  email: `${status}@example.test`,
  status,
  lastStartedAt: status === 'not-created' ? null : 1_900_000_000_000,
  lastActivityAt: status === 'not-created' ? null : 1_900_000_001_000,
  lastError: status === 'error' ? '安全日志：启动失败 <img src=x>' : null,
}));
const TARGET = {
  userId: 'instance0004',
  email: 'error@example.test',
  status: 'error',
  lastStartedAt: 1,
  lastActivityAt: 2,
  lastError: '启动失败',
};
const receipt = createJsonReceipt({ items: [TARGET] });

it('routes the administrator instance list with five states, nullable times and plain saved error details', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ items: ITEMS }), { status: 200 }));
  const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);

  expect(view.querySelector('h1')?.textContent).toBe('实例管理');
  for (const label of ['未创建', '已停止', '启动中', '运行中', '出错']) {
    expect(view.textContent).toContain(label);
  }
  expect(view.querySelectorAll('tbody tr')).toHaveLength(5);
  expect(view.querySelector('tbody tr')?.textContent).toContain('暂无');
  expect(view.querySelector('details')?.textContent).toContain('安全日志：启动失败 <img src=x>');
  expect(view.querySelector('details')?.hasAttribute('open')).toBe(false);
  expect(view.querySelector('img')).toBeNull();
});

it('confirms reset, cancels without mutation and retains one pending fence through the complete 204 body', async () => {
  const target = ITEMS[4];
  if (target === undefined) throw new Error('Missing target');
  const receipt = createJsonReceipt({ items: [target] });
  const reset = new Response(null, { status: 204 });
  const body = holdResponseBody(reset);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(reset)
    .mockResolvedValueOnce(receipt({ items: [{ ...target, status: 'stopped', lastError: null }] }));
  const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);
  await click(view, '重置配置');
  expect(view.querySelector('[role="dialog"]')?.textContent).toContain(target.email);
  expect(view.textContent).toContain('会恢复该用户的 DSH 设置，文件和对话保留');
  await click(view, '取消');
  expect(request).toHaveBeenCalledTimes(1);
  await click(view, '重置配置');

  await settle(() => {
    submit(view);
    submit(view);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(button(view, '正在提交…').disabled).toBe(true);
  expect(button(view, '取消').disabled).toBe(true);
  expect(button(view, '重启').disabled).toBe(true);
  await settleSubmit(view);
  expect(request).toHaveBeenCalledTimes(2);
  await settle(() => {
    body.resolve(new ArrayBuffer(0));
  });

  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[1]?.[0]).toBe(
    '/_platform/api/admin/instances/instance0004/reset-config',
  );
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    body: '{}',
    credentials: 'same-origin',
    redirect: 'error',
  });
  expect(view.querySelector('[role="dialog"]')).toBeNull();
  expect(view.textContent).toContain('配置已重置');
  expect(view.textContent).toContain('已停止');
  expect(view.textContent).not.toContain('已启动');
});

it('separates loading, local no-match, true empty and safe failure with an explicit retry', async () => {
  const loading = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(loading.promise)
    .mockResolvedValueOnce(receipt({ items: [] }))
    .mockResolvedValueOnce(new Response('private-backend-error', { status: 500 }))
    .mockResolvedValueOnce(receipt());
  const { view } = renderAccountPage(<AccountPage />, PATH, request);
  expect(view.textContent).toContain('加载中');
  expect(view.querySelector('table')).toBeNull();
  await settle(() => {
    loading.resolve(receipt());
  });
  await draft(view, '#instance-search', 'no-match');
  expect(view.textContent).toContain('没有匹配的实例');
  expect(request).toHaveBeenCalledTimes(1);
  await click(view, '刷新');
  expect(view.textContent).toContain('暂无实例');
  await click(view, '刷新');
  expect(view.textContent).toContain('加载失败');
  expect(view.textContent).not.toContain('private-backend-error');
  await draft(view, '#instance-search', '');
  await click(view, '重试');
  expect(view.querySelector('tbody tr')?.textContent).toContain(TARGET.email);
});

it.each([401, 403])(
  'current list authority %s removes data even when its response body fails',
  async (status) => {
    const denial = new Response(null, { status });
    vi.spyOn(denial, 'arrayBuffer').mockRejectedValue(new Error('private-body-error'));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(denial);
    const { view, navigate } = await renderSettledAccountPage(<AccountPage />, PATH, request);
    await click(view, '重置配置');
    await click(view, '刷新');
    expect(view.textContent).toContain('无权限');
    expect(view.querySelector('table')).toBeNull();
    expect(view.querySelector('button')).toBeNull();
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
  },
);

it.each([
  null,
  [],
  {},
  { items: null },
  { items: [null] },
  { items: [{ ...TARGET, userId: '../other' }] },
  { items: [{ ...TARGET, email: null }] },
  { items: [{ ...TARGET, status: '__proto__' }] },
  { items: [{ ...TARGET, lastActivityAt: 'yesterday' }] },
  { items: [{ ...TARGET, lastStartedAt: 8_640_000_000_000_001 }] },
  { items: [{ ...TARGET, lastError: { private: 'not-displayable' } }] },
])('rejects malformed list projection %# instead of exposing actions', async (value) => {
  const { view } = await renderSettledAccountPage(
    <AccountPage />,
    PATH,
    vi.fn<typeof fetch>().mockResolvedValue(receipt(value)),
  );
  expect(view.textContent).toContain('加载失败');
  expect(view.querySelector('table')).toBeNull();
  expect(view.querySelector('[role="dialog"]')).toBeNull();
});

it('ignores an obsolete authority response after a newer successful refresh and aborts only pending reads on departure', async () => {
  const stale = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(receipt());
  const { view, navigate, unmount } = renderAccountPage(<AccountPage />, PATH, request);
  const firstSignal = request.mock.calls[0]?.[1]?.signal;
  await click(view, '刷新');
  expect(firstSignal?.aborted).toBe(true);
  await settle(() => {
    stale.resolve(new Response(null, { status: 401 }));
  });
  expect(view.querySelector('tbody tr')?.textContent).toContain(TARGET.email);
  expect(navigate).not.toHaveBeenCalled();
  const currentSignal = request.mock.calls[1]?.[1]?.signal;
  unmount();
  expect(currentSignal?.aborted).toBe(false);
});

it.each([401, 403])(
  'mutation authority %s clears rows and confirmation without a redundant refresh',
  async (status) => {
    const denied = new Response(null, { status });
    vi.spyOn(denied, 'arrayBuffer').mockRejectedValue(new Error('private-body'));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(denied);
    const { view, navigate } = await renderSettledAccountPage(<AccountPage />, PATH, request);
    await click(view, '重置配置');
    await settleSubmit(view);
    expect(view.textContent).toContain('无权限');
    expect(view.querySelector('table')).toBeNull();
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
  },
);

it.each([409, 500])(
  'reset failure %s refreshes durable state without retrying the mutation or displaying raw errors',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(new Response('private-operation-detail', { status }))
      .mockResolvedValueOnce(receipt());
    const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);
    await click(view, '重置配置');
    await settleSubmit(view);
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      status === 409 ? '操作冲突' : '状态可能已变更',
    );
    expect(view.textContent).not.toContain('private-operation-detail');
    expect(view.textContent).not.toContain('配置已重置');
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(view.querySelector('tbody tr')?.textContent).toContain(TARGET.email);
  },
);

it.each(['starting', 'running', 'full', 'unconfigured', 'error', 'stopped'])(
  'presents restart %s as its actual admission outcome, never automatic readiness',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(
        receipt({ userId: TARGET.userId, status, reason: status === 'running' ? null : status }),
      )
      .mockResolvedValueOnce(receipt());
    const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);
    await click(view, '重启');
    await settleSubmit(view);
    expect(request.mock.calls[1]?.[0]).toBe(
      `/_platform/api/admin/instances/${TARGET.userId}/restart`,
    );
    expect(view.textContent).toContain(
      status === 'starting' || status === 'running' ? '不代表已就绪' : '重启未完成',
    );
    expect(view.querySelector('[role="dialog"]')).toBeNull();
  },
);

it('rejects a restart receipt for another target and does not retry the submitted action', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(receipt({ userId: 'another00000', status: 'running', reason: null }))
    .mockResolvedValueOnce(receipt());
  const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);
  await click(view, '重启');
  await settleSubmit(view);
  expect(view.textContent).toContain('操作失败');
  expect(view.textContent).not.toContain('重启已提交');
  expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it('does not update or navigate after departure while an accepted mutation response is pending', async () => {
  const response = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockReturnValueOnce(response.promise);
  const { view, navigate, unmount } = await renderSettledAccountPage(
    <AccountPage />,
    PATH,
    request,
  );
  await click(view, '重置配置');
  await settleSubmit(view);
  expect(element(view, '#instance-search', HTMLInputElement).disabled).toBe(true);
  unmount();
  await settle(() => {
    response.resolve(new Response(null, { status: 403 }));
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(navigate).not.toHaveBeenCalled();
});

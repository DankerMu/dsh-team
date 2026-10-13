// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
import { RuntimePage } from './runtime-page.tsx';
import {
  click,
  createJsonReceipt,
  draft,
  element,
  renderAccountPage,
  renderSettledAccountPage,
  settle,
  settleSubmit,
  submit,
} from '../test/account-dom-fixture.tsx';

const PATH = '/_platform/admin/runtime';
const CONFIG = {
  idleMinutes: 30,
  cpuCores: 2,
  memoryMiB: 4096,
  maxRunningInstances: 60,
  defaultPermissionTier: 'yolo',
};
const receipt = createJsonReceipt(CONFIG);
const render = (request = vi.fn<typeof fetch>().mockResolvedValue(receipt())) =>
  renderSettledAccountPage(<RuntimePage />, PATH, request);

it('loads the routed runtime editor and preserves fractional CPU through a fenced save', async () => {
  const body = Promise.withResolvers<unknown>();
  const response = receipt();
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(response);
  const { view } = await renderSettledAccountPage(<AccountPage />, PATH, request);
  expect(element(view, '#runtime-cpuCores', HTMLInputElement).value).toBe('2');
  await draft(view, '#runtime-cpuCores', '0.125');
  await draft(view, '#runtime-idleMinutes', '15');
  await settle(() => {
    submit(view);
    submit(view);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(true);
  const payload = request.mock.calls[1]?.[1]?.body;
  if (typeof payload !== 'string') throw new Error('Missing runtime JSON payload');
  expect(JSON.parse(payload)).toEqual({ ...CONFIG, cpuCores: 0.125, idleMinutes: 15 });
  await settleSubmit(view);
  expect(request).toHaveBeenCalledTimes(2);
  await settle(() => {
    body.resolve({ ...CONFIG, cpuCores: 0.125, idleMinutes: 15, runningInstances: 3 });
  });
  expect(element(view, '#runtime-cpuCores', HTMLInputElement).value).toBe('0.125');
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(false);
  expect(view.textContent).toContain('已保存');
  expect(view.textContent).toContain('3（非实时统计）');
});

it.each(['idleMinutes', 'memoryMiB', 'maxRunningInstances'])(
  'rejects unsafe or fractional %s without mutation',
  async (name) => {
    const { view, request } = await render();
    for (const value of ['', '0', '1.5', '9007199254740992']) {
      await draft(view, `#runtime-${name}`, value);
      await settleSubmit(view);
      expect(view.textContent).toContain('1–9007199254740991');
      expect(request).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(['0', '-1', '1e309'])('rejects invalid CPU %s without saving', async (value) => {
  const { view, request } = await render();
  await draft(view, '#runtime-cpuCores', value);
  await settleSubmit(view);
  expect(view.textContent).toContain('大于 0');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([Number.MIN_VALUE, 0.000001, Number.MAX_VALUE])(
  'accepts finite positive CPU domain %s without an invented minimum or step',
  async (cpuCores) => {
    const values = { ...CONFIG, cpuCores };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt(values))
      .mockResolvedValueOnce(receipt({ ...values, runningInstances: 0 }));
    const { view } = await render(request);
    await settleSubmit(view);
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.textContent).toContain('已保存');
    expect(Number(element(view, '#runtime-cpuCores', HTMLInputElement).value)).toBe(cpuCores);
  },
);

it('changes the permission field and rejects an unavailable option', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(
      receipt({ ...CONFIG, defaultPermissionTier: 'approval', runningInstances: 0 }),
    );
  const { view } = await render(request);
  for (const value of ['', 'approval']) {
    await settle(() => {
      const select = element(view, '#runtime-tier', HTMLSelectElement);
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleSubmit(view);
    expect(request).toHaveBeenCalledTimes(value === '' ? 1 : 2);
  }
  expect(element(view, '#runtime-tier', HTMLSelectElement).value).toBe('approval');
});

it.each([
  null,
  [],
  { ...CONFIG, modelApiKey: 'private-data' },
  { ...CONFIG, cpuCores: '2' },
  { ...CONFIG, idleMinutes: 0 },
  { ...CONFIG, memoryMiB: 1.5 },
  { ...CONFIG, cpuCores: null },
  { ...CONFIG, defaultPermissionTier: 'administrator' },
])('rejects invalid or unsafe GET projections %# and retries explicitly', async (body) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt(body))
    .mockResolvedValueOnce(receipt());
  const { view } = await render(request);
  expect(view.querySelector('form')).toBeNull();
  expect(view.textContent).toContain('加载失败');
  expect(view.innerHTML).not.toContain('private-data');
  await click(view, '重试');
  expect(element(view, '#runtime-idleMinutes', HTMLInputElement).value).toBe('30');
});

it.each([undefined, -1, 0.5, '1'])(
  'rejects malformed save metadata %j without false success',
  async (runningInstances) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(receipt({ ...CONFIG, runningInstances }));
    const { view } = await render(request);
    await settleSubmit(view);
    expect(view.textContent).toContain('保存失败');
    expect(view.textContent).not.toContain('已保存');
    expect(element(view, '#runtime-maxRunningInstances', HTMLInputElement).value).toBe('60');
  },
);

it.each([
  ['PLATFORM_SUBNET_POOL provides 4096 /28 subnets; private-data', '容量：4096'],
  ['PLATFORM_SUBNET_POOL provides 999999999999999999999 /28 subnets; private-data', '取值范围'],
  ['PLATFORM_SUBNET_POOL provides 0 /28 subnets; private-data', '取值范围'],
  ['private-data', '取值范围'],
])('shows only validated capacity guidance for a rejected save %#', async (message, expected) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(receipt({ message }, 400));
  const { view } = await render(request);
  await draft(view, '#runtime-maxRunningInstances', '4097');
  await settleSubmit(view);
  expect(view.textContent).toContain(expected);
  expect(view.innerHTML).not.toContain('private-data');
  expect(element(view, '#runtime-maxRunningInstances', HTMLInputElement).value).toBe('4097');
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([400, 500])('keeps unreadable rejection %i safe and permits correction', async (status) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(receipt())
    .mockResolvedValueOnce(new Response('private-data', { status }));
  const { view } = await render(request);
  await settleSubmit(view);
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toContain(
    status === 400 ? '取值范围' : '保存失败',
  );
  expect(view.innerHTML).not.toContain('private-data');
  expect(element(view, 'fieldset', HTMLFieldSetElement).disabled).toBe(false);
});

it.each(['network', 'json', 'http'] as const)('fails closed on %s load failure', async (kind) => {
  const request = vi.fn<typeof fetch>();
  if (kind === 'network') request.mockRejectedValue(new Error('private-data'));
  else
    request.mockResolvedValue(
      new Response('private-data', { status: kind === 'json' ? 200 : 500 }),
    );
  const { view } = await render(request);
  expect(view.querySelector('form')).toBeNull();
  expect(view.textContent).toContain('加载失败');
  expect(view.innerHTML).not.toContain('private-data');
});

it.each([401, 403])(
  'current unreadable save denial %i removes all settings and obeys redirect policy',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(new Response('private-data', { status }));
    const { view, navigate } = await render(request);
    await settleSubmit(view);
    expect(view.querySelector('form')).toBeNull();
    expect(view.textContent).toContain('无权限');
    expect(view.innerHTML).not.toContain('private-data');
    expect(navigate.mock.calls).toEqual(status === 401 ? [['/_platform/login']] : []);
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it.each(['json', 'denial', 'network'] as const)(
  'obsolete %s completion cannot restore state or navigate after unmount',
  async (kind) => {
    const pending = Promise.withResolvers<Response>();
    const body = Promise.withResolvers<unknown>();
    const response = receipt({}, kind === 'denial' ? 401 : 200);
    vi.spyOn(response, 'json').mockReturnValue(body.promise);
    const request = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const { view, unmount, navigate } = renderAccountPage(<RuntimePage />, PATH, request);
    if (kind !== 'network')
      await settle(() => {
        pending.resolve(response);
      });
    const signal = request.mock.calls[0]?.[1]?.signal;
    unmount();
    await settle(() => {
      if (kind === 'network') pending.reject(new Error('private-data'));
      else body.resolve(CONFIG);
    });
    expect(signal?.aborted).toBe(true);
    expect(view.innerHTML).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  },
);

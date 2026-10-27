// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { element, renderAccountPage } from '../test/account-dom-fixture.tsx';
import { AccountPage } from './account-page.tsx';
import { WaitPage } from './wait-page.tsx';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function response(status: string): Response {
  return new Response(JSON.stringify({ status, reason: status === 'running' ? null : status }));
}

const SESSION_API = '/_platform/api/session';

function identity(role: string): Response {
  return new Response(JSON.stringify({ email: 'person@example.com', role }));
}

/** Instance calls reach `request`; the separate identity read reaches `session`. */
function renderWait(
  request = vi.fn<typeof fetch>().mockResolvedValue(response('starting')),
  session = vi.fn<typeof fetch>().mockResolvedValue(identity('employee')),
) {
  const routed = vi.fn<typeof fetch>((url, init) =>
    url === SESSION_API ? session(url, init) : request(url, init),
  );
  return { ...renderAccountPage(<WaitPage />, '/_platform/wait', routed), request, session };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function retry(view: HTMLDivElement): void {
  element(view, 'button', HTMLButtonElement).click();
}

it('dispatches the exact wait page and starts the current user with empty same-origin JSON', async () => {
  const request = vi.fn<typeof fetch>((url) =>
    Promise.resolve(url === SESSION_API ? identity('employee') : response('running')),
  );
  const { view, navigate } = renderAccountPage(<AccountPage />, '/_platform/wait', request);

  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('启动中');
  await settle();

  const signal = request.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(request).toHaveBeenNthCalledWith(1, '/_platform/api/instance/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    body: '{}',
    signal,
  });
  expect(request.mock.calls[1]?.[0]).toBe(SESSION_API);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  await advance(120000);
  expect(request).toHaveBeenCalledTimes(2);
});

it('observes starting serially one second after each settled response without a frontend deadline', async () => {
  const first = Promise.withResolvers<Response>();
  const pendingStatus = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(pendingStatus.promise)
    .mockResolvedValueOnce(response('running'));
  const { view, navigate } = renderWait(request);

  await advance(70000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    first.resolve(response('starting'));
    await Promise.resolve();
  });
  await advance(999);
  expect(request).toHaveBeenCalledTimes(1);
  await advance(1);
  const signal = request.mock.calls[1]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(request).toHaveBeenNthCalledWith(2, '/_platform/api/instance', {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  await advance(70000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => {
    pendingStatus.resolve(response('starting'));
    await Promise.resolve();
  });
  await advance(999);
  expect(request).toHaveBeenCalledTimes(2);
  await advance(1);

  expect(request.mock.calls.map(([url, options]) => [url, options?.method, options?.body])).toEqual(
    [
      ['/_platform/api/instance/start', 'POST', '{}'],
      ['/_platform/api/instance', 'GET', undefined],
      ['/_platform/api/instance', 'GET', undefined],
    ],
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  await advance(5000);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([
  ['full', '当前使用人数已满，请稍后再试'],
  ['unconfigured', '管理员尚未完成模型配置'],
  ['error', '启动失败，请重试。'],
  ['stopped', '实例已停止，请点击重试。'],
])('stops at %s until an explicit retry starts a new attempt', async (status, message) => {
  const pending = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(status))
    .mockReturnValueOnce(pending.promise);
  const { view, navigate } = renderWait(request);
  await settle();

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
  await advance(10000);
  expect(request).toHaveBeenCalledTimes(1);
  act(() => {
    retry(view);
    retry(view);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]?.method).toBe('POST');
  expect(request.mock.calls[1]?.[1]?.body).toBe('{}');
  expect(element(view, '[role="status"]', HTMLElement).textContent).toBe('启动中');
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(true);
  expect(view.querySelector('[role="alert"]')).toBeNull();
  await advance(10000);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending.resolve(response('running'));
    await Promise.resolve();
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it('retains administrator guidance after another failed explicit retry and permits later recovery', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response('error'))
    .mockResolvedValueOnce(response('error'))
    .mockResolvedValueOnce(response('running'));
  const { view, navigate } = renderWait(request);
  await settle();

  await act(async () => {
    retry(view);
    await Promise.resolve();
  });
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('启动失败，请重试。');
  expect(view.textContent).toContain('仍失败时请联系管理员');
  await advance(10000);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    retry(view);
    await Promise.resolve();
  });

  expect(request.mock.calls.map(([, options]) => options?.method)).toEqual([
    'POST',
    'POST',
    'POST',
  ]);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it.each([
  'null',
  '[]',
  '{}',
  '"running"',
  '{"status":"running"}',
  '{"status":"running","reason":"starting"}',
  '{"status":"starting","reason":null}',
  '{"status":"error","reason":"full"}',
  '{"status":"unknown","reason":"unknown"}',
  '{"status":"running","reason":null,"endpoint":"private"}',
  'private non-JSON',
])('rejects invalid successful API body %s without navigation or automatic work', async (body) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
  const { view, navigate } = renderWait(request);

  await settle();
  await advance(10000);

  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('启动失败，请重试。');
  expect(view.textContent).not.toContain('private');
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it.each([201, 204, 302, 400, 403, 429, 500, 503])(
  'bounds HTTP %i failure without accepting a running body',
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(status === 204 ? null : '{"status":"running","reason":null}', { status }),
      );
    const { view, navigate } = renderWait(request);

    await settle();
    await advance(10000);

    expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('启动失败，请重试。');
    expect(request).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  },
);

it.each(['start', 'status'])(
  'navigates to fixed login and stops when %s returns 401',
  async (phase) => {
    const request = vi.fn<typeof fetch>();
    if (phase === 'status') request.mockResolvedValueOnce(response('starting'));
    request.mockResolvedValue(new Response('private unauthorized', { status: 401 }));
    const { navigate } = renderWait(request);

    await settle();
    if (phase === 'status') await advance(1000);
    await advance(10000);

    expect(navigate).toHaveBeenCalledExactlyOnceWith('/_platform/login');
    expect(request).toHaveBeenCalledTimes(phase === 'start' ? 1 : 2);
  },
);

it('shows a recoverable bounded failure for a rejected network request', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('private transport'))
    .mockResolvedValueOnce(response('running'));
  const { view, navigate } = renderWait(request);

  await settle();
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('启动失败，请重试。');
  expect(view.textContent).not.toContain('private');
  await act(async () => {
    retry(view);
    await Promise.resolve();
  });

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
});

it.each(['running', 'starting', 'unauthorized', 'rejected'])(
  'aborts an unmounted request and ignores its late %s result',
  async (result) => {
    const pending = Promise.withResolvers<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const { unmount, navigate } = renderWait(request);
    const signal = request.mock.calls[0]?.[1]?.signal;

    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (result === 'rejected') pending.reject(new Error('late private rejection'));
      else
        pending.resolve(
          result === 'unauthorized' ? new Response(null, { status: 401 }) : response(result),
        );
      await Promise.resolve();
    });
    await advance(10000);

    expect(navigate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(['running', 'starting', 'rejected'])(
  'fences late JSON %s completion after unmount and replacement',
  async (status) => {
    const json = Promise.withResolvers<unknown>();
    const late = response('starting');
    vi.spyOn(late, 'json').mockReturnValue(json.promise);
    const request = vi.fn<typeof fetch>().mockResolvedValue(late);
    const first = renderWait(request);
    await settle();

    first.unmount();
    const second = renderWait(vi.fn<typeof fetch>().mockResolvedValue(response('full')));
    await settle();
    await act(async () => {
      if (status === 'rejected') json.reject(new Error('late private JSON failure'));
      else json.resolve({ status, reason: status === 'running' ? null : status });
      await Promise.resolve();
    });
    await advance(10000);

    expect(first.navigate).not.toHaveBeenCalled();
    expect(second.navigate).not.toHaveBeenCalled();
    expect(element(second.view, '[role="alert"]', HTMLElement).textContent).toBe(
      '当前使用人数已满，请稍后再试',
    );
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it('cancels a scheduled observation when the page unmounts', async () => {
  const { request, unmount, navigate } = renderWait();
  await settle();

  unmount();
  await advance(10000);

  expect(request).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it('waits for status JSON settlement before scheduling another observation', async () => {
  const json = Promise.withResolvers<unknown>();
  const status = response('starting');
  vi.spyOn(status, 'json').mockReturnValue(json.promise);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response('starting'))
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(response('running'));
  const { navigate } = renderWait(request);
  await settle();
  await advance(1000);

  await advance(10000);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    json.resolve({ status: 'starting', reason: 'starting' });
    await Promise.resolve();
  });
  await advance(999);
  expect(request).toHaveBeenCalledTimes(2);
  await advance(1);

  expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(['malformed', 'http', 'network', 'terminal'])(
  'stops a starting attempt on a %s status observation and requires a fresh POST to recover',
  async (failure) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response('starting'));
    if (failure === 'network') request.mockRejectedValueOnce(new Error('private observation'));
    else
      request.mockResolvedValueOnce(
        failure === 'malformed'
          ? new Response('{"status":"running","reason":"error"}')
          : failure === 'http'
            ? new Response('private observation', { status: 503 })
            : response('error'),
      );
    request.mockResolvedValueOnce(response('running'));
    const { view, navigate } = renderWait(request);
    await settle();

    await advance(1000);
    expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('启动失败，请重试。');
    expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    await advance(10000);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry(view);
      await Promise.resolve();
    });

    expect(request.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      ['/_platform/api/instance/start', 'POST'],
      ['/_platform/api/instance', 'GET'],
      ['/_platform/api/instance/start', 'POST'],
    ]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  },
);

it('aborts a pending observation on departure and rejects late running navigation', async () => {
  const observation = Promise.withResolvers<Response>();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response('starting'))
    .mockReturnValueOnce(observation.promise);
  const { unmount, navigate } = renderWait(request);
  await settle();
  await advance(1000);
  const signal = request.mock.calls[1]?.[1]?.signal;

  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    observation.resolve(response('running'));
    await Promise.resolve();
  });
  await advance(10000);

  expect(navigate).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
});

function configureLink(view: HTMLDivElement): HTMLAnchorElement | undefined {
  return [...view.querySelectorAll('a')].find((link) => link.textContent === '去配置模型');
}

function consoleLink(view: HTMLDivElement): HTMLAnchorElement | undefined {
  return [...view.querySelectorAll('a')].find((link) => link.textContent === '管理后台');
}

it.each([
  ['starting', '启动中'],
  ['full', '当前使用人数已满，请稍后再试'],
  ['error', '启动失败，请重试。'],
  ['stopped', '实例已停止，请点击重试。'],
  ['unconfigured', '管理员尚未完成模型配置'],
])('shows an administrator the console link in the %s state', async (status, message) => {
  const { view, session, navigate } = renderWait(
    vi.fn<typeof fetch>().mockResolvedValue(response(status)),
    vi.fn<typeof fetch>().mockResolvedValue(identity('admin')),
  );
  await settle();
  await settle();

  const link = consoleLink(view);
  expect(link?.getAttribute('href')).toBe('/_platform/admin');
  expect(link?.closest('[role="alert"], [role="status"], [aria-live], button')).toBeNull();
  expect(link?.closest('.card-links')).not.toBeNull();
  expect(configureLink(view)?.getAttribute('href')).toBe(
    status === 'unconfigured' ? '/_platform/admin/models' : undefined,
  );
  expect(
    element(view, status === 'starting' ? '[role="status"]' : '[role="alert"]', HTMLElement)
      .textContent,
  ).toBe(message);
  expect(session).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it('reads the identity once per page across retries outside the unconfigured state', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response('full'))
    .mockResolvedValueOnce(response('error'))
    .mockResolvedValueOnce(response('full'));
  const { view, session } = renderWait(
    request,
    vi.fn<typeof fetch>().mockResolvedValue(identity('admin')),
  );
  await settle();
  await settle();
  for (const message of ['启动失败，请重试。', '当前使用人数已满，请稍后再试']) {
    await act(async () => {
      retry(view);
      await Promise.resolve();
    });
    expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(message);
    expect(consoleLink(view)?.getAttribute('href')).toBe('/_platform/admin');
  }

  expect(request).toHaveBeenCalledTimes(3);
  expect(session).toHaveBeenCalledTimes(1);
});

it('shows an administrator the model configuration link only while unconfigured after one identity read', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response('unconfigured'))
    .mockResolvedValueOnce(response('full'))
    .mockResolvedValueOnce(response('unconfigured'));
  const { view, session, navigate } = renderWait(
    request,
    vi.fn<typeof fetch>().mockResolvedValue(identity('admin')),
  );
  await settle();
  await settle();

  const link = configureLink(view);
  expect(link?.getAttribute('href')).toBe('/_platform/admin/models');
  expect(link?.closest('[role="alert"], [role="status"], [aria-live], button')).toBeNull();
  expect(link?.closest('.card-links')).not.toBeNull();
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('管理员尚未完成模型配置');
  const signal = session.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(session).toHaveBeenCalledExactlyOnceWith(SESSION_API, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  await act(async () => {
    retry(view);
    await Promise.resolve();
  });
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe(
    '当前使用人数已满，请稍后再试',
  );
  expect(configureLink(view)).toBeUndefined();
  expect(consoleLink(view)?.getAttribute('href')).toBe('/_platform/admin');
  await act(async () => {
    retry(view);
    await Promise.resolve();
  });

  expect(configureLink(view)?.getAttribute('href')).toBe('/_platform/admin/models');
  expect(consoleLink(view)?.getAttribute('href')).toBe('/_platform/admin');
  expect(session).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(3);
  expect(navigate).not.toHaveBeenCalled();
});

it.each(['starting', 'full', 'error', 'stopped', 'unconfigured'])(
  'shows an employee the unchanged %s page without administrator links',
  async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(status));
    const { view, session } = renderWait(request);
    await settle();
    await settle();

    expect(session).toHaveBeenCalledTimes(1);
    expect(configureLink(view)).toBeUndefined();
    expect(consoleLink(view)).toBeUndefined();
    expect([...view.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/_platform/account',
    ]);
  },
);

it.each(['full', 'error', 'stopped', 'starting', 'running', 'unconfigured'])(
  'reads the current identity exactly once on entry in the %s state',
  async (status) => {
    const { session } = renderWait(vi.fn<typeof fetch>().mockResolvedValue(response(status)));
    await settle();
    await advance(1000);

    const signal = session.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(session).toHaveBeenCalledExactlyOnceWith(SESSION_API, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
    });
  },
);

it.each<[string, () => Promise<Response>]>([
  ['401', () => Promise.resolve(new Response('{"statusCode":401}', { status: 401 }))],
  ['500', () => Promise.resolve(new Response('private detail', { status: 500 }))],
  ['a network failure', () => Promise.reject(new Error('private transport detail'))],
  ['an unparseable body', () => Promise.resolve(new Response('not JSON: private detail'))],
  ['a non-object body', () => Promise.resolve(new Response('["admin"]'))],
  ['an unknown role', () => Promise.resolve(identity('Admin'))],
  [
    'an extra field',
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ email: 'person@example.com', role: 'admin', id: 'x' })),
      ),
  ],
  ['a missing email', () => Promise.resolve(new Response('{"role":"admin"}'))],
])('adds nothing when the identity read returns %s', async (_name, answer) => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response('unconfigured'));
  const { view, session, navigate } = renderWait(request, vi.fn<typeof fetch>(answer));
  await settle();
  await settle();
  await settle();

  expect(session).toHaveBeenCalledTimes(1);
  expect(configureLink(view)).toBeUndefined();
  expect(consoleLink(view)).toBeUndefined();
  expect(element(view, '[role="alert"]', HTMLElement).textContent).toBe('管理员尚未完成模型配置');
  expect(element(view, 'button', HTMLButtonElement).disabled).toBe(false);
  expect(view.textContent).not.toContain('private');
  expect(navigate).not.toHaveBeenCalled();
});

it('aborts a pending identity read on departure and ignores its late administrator answer', async () => {
  const pending = Promise.withResolvers<Response>();
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response('full'));
  const { session, unmount, view } = renderWait(
    request,
    vi.fn<typeof fetch>().mockReturnValue(pending.promise),
  );
  await settle();
  const signal = session.mock.calls[0]?.[1]?.signal;

  unmount();
  await act(async () => {
    pending.resolve(identity('admin'));
    await Promise.resolve();
  });

  expect(signal?.aborted).toBe(true);
  expect(configureLink(view)).toBeUndefined();
  expect(consoleLink(view)).toBeUndefined();
});

import { expect, it } from 'vitest';
import { trackFrames } from './browser-frame-ledger.mjs';

type Handler = (params: Record<string, unknown>) => void;

/** A CDP tab whose sessions record commands and receive scripted events. */
function fakeTab(fail: (sessionId: string, method: string) => boolean = () => false) {
  const listeners = new Map<string, Set<Handler>>();
  const sent: { sessionId: string; method: string; params: unknown }[] = [];
  const session = (sessionId: string) => ({
    sessionId,
    send(method: string, params: unknown = {}) {
      sent.push({ sessionId, method, params });
      return fail(sessionId, method)
        ? Promise.reject(new Error('cdp-closed'))
        : Promise.resolve({});
    },
    on() {
      throw new Error('trackFrames must not replace page handlers');
    },
    listen(method: string, handler: Handler) {
      const key = `${sessionId}\0${method}`;
      const set = listeners.get(key) ?? new Set<Handler>();
      listeners.set(key, set);
      set.add(handler);
      return () => set.delete(handler);
    },
  });
  const page = { ...session('page'), session, close: () => undefined };
  const emit = (sessionId: string, method: string, params: Record<string, unknown>) => {
    for (const handler of listeners.get(`${sessionId}\0${method}`) ?? []) handler(params);
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { page, sent, emit, settled, listeners };
}

const ALLOWED = [
  ['Blocked script execution', "'allow-scripts' permission is not set"],
  ['ERR_FAILED'],
];

it('auto-attaches paused targets and resumes each only after its domains are enabled', async () => {
  const tab = fakeTab();
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'frame-session',
    targetInfo: { targetId: 'F', type: 'iframe' },
    waitingForDebugger: true,
  });
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'worker-session',
    targetInfo: { targetId: 'W', type: 'worker' },
    waitingForDebugger: true,
  });
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'old-worker',
    targetInfo: { targetId: 'O', type: 'worker' },
    waitingForDebugger: false,
  });
  await tab.settled();

  const commands = (sessionId: string) =>
    tab.sent.filter((row) => row.sessionId === sessionId).map((row) => row.method);
  expect(tab.sent[0]).toEqual({
    sessionId: 'page',
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
  });
  expect(commands('frame-session')).toEqual([
    'Network.enable',
    'Page.enable',
    'Runtime.enable',
    'Log.enable',
    'Runtime.runIfWaitingForDebugger',
  ]);
  expect(commands('worker-session')).toEqual(['Runtime.enable', 'Runtime.runIfWaitingForDebugger']);
  expect(commands('old-worker')).toEqual(['Runtime.enable']);
  expect(frames.owner('F').sessionId).toBe('frame-session');
  expect(frames.owner('W').sessionId).toBe('page');
  expect(frames.owner('other').sessionId).toBe('page');

  tab.emit('page', 'Target.detachedFromTarget', { sessionId: 'frame-session' });
  expect(frames.owner('F').sessionId).toBe('page');
  expect(tab.listeners.get('frame-session\0Network.responseReceived')?.size).toBe(0);
  frames.dispose();
  expect(tab.listeners.get('page\0Target.attachedToTarget')?.size).toBe(0);
});

it('merges one document and its redirect hops across sessions, never keeping a cookie value', async () => {
  const tab = fakeTab();
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'frame-session',
    targetInfo: { targetId: 'F', type: 'iframe' },
    waitingForDebugger: true,
  });
  const sent = (sessionId: string, requestId: string, headers: Record<string, string>) => {
    tab.emit(sessionId, 'Network.requestWillBeSentExtraInfo', { requestId, headers });
  };
  const request = (
    sessionId: string,
    requestId: string,
    frameId: string,
    url: string,
    redirectResponse?: unknown,
  ) => {
    tab.emit(sessionId, 'Network.requestWillBeSent', {
      requestId,
      frameId,
      type: 'Document',
      request: { url },
      redirectResponse,
    });
  };
  const answer = (sessionId: string, requestId: string, status: number, headers = {}) => {
    tab.emit(sessionId, 'Network.responseReceived', {
      requestId,
      frameId: 'F',
      type: 'Document',
      response: { status, headers },
    });
  };
  request('page', 'old', 'F', 'http://h/sidebar/file?a');
  answer('page', 'old', 200);
  const before = frames.known();
  request('page', 'foreign', 'G', 'http://h/sidebar/file?b');
  answer('page', 'foreign', 200);
  request('page', 'html', 'F', 'http://h/sidebar/html/s/x');
  answer('frame-session', 'html', 200);
  // The cookieless script navigation: 302 to the login page, which then answers 200.
  sent('frame-session', 'self', { 'Sec-Fetch-Site': 'cross-site' });
  request('page', 'self', 'F', 'http://h/sidebar/file?c');
  request('page', 'self', 'F', 'http://h/_platform/login', {
    status: 302,
    headers: { Location: '/_platform/login', 'Content-Security-Policy': 'sandbox' },
  });
  sent('page', 'self', { 'sec-fetch-site': 'cross-site' });
  const inFlight = frames.nextDocument(
    'F',
    before,
    (url: string) => url.includes('/sidebar/file'),
    1000,
    'self',
  );
  answer('page', 'self', 200);
  // The browser's navigation sends the platform cookie; only its presence is kept.
  request('page', 'nav', 'F', 'http://h/sidebar/file?c');
  sent('page', 'nav', { 'sec-fetch-site': 'none', Cookie: 'platform_session=private' });
  answer('frame-session', 'nav', 200, { 'X-Content-Type-Options': 'nosniff' });

  expect(await inFlight).toEqual({
    requestId: 'self',
    url: 'http://h/sidebar/file?c',
    hops: [
      {
        url: 'http://h/sidebar/file?c',
        status: 302,
        headers: { location: '/_platform/login', 'content-security-policy': 'sandbox' },
        location: '/_platform/login',
        secFetchSite: 'cross-site',
        cookie: false,
      },
      {
        url: 'http://h/_platform/login',
        status: 200,
        headers: {},
        location: null,
        secFetchSite: 'cross-site',
        cookie: false,
      },
    ],
  });
  const nav = await frames.nextDocument(
    'F',
    new Set([...before, 'self']),
    (url: string) => url.includes('/sidebar/file'),
    1000,
    'nav',
  );
  expect(nav.hops).toEqual([
    {
      url: 'http://h/sidebar/file?c',
      status: 200,
      headers: { 'x-content-type-options': 'nosniff' },
      location: null,
      secFetchSite: 'none',
      cookie: true,
    },
  ]);
  expect(JSON.stringify(nav)).not.toContain('private');
  // A timeout names every hop of the frame's documents since `before`, by route only.
  await expect(frames.nextDocument('F', frames.known(), () => true, 300, 'none')).rejects.toThrow(
    'none documents=[]',
  );
  await expect(
    frames.nextDocument('F', before, (url: string) => url.includes('/missing'), 300, 'missing'),
  ).rejects.toThrow(
    'missing documents=[[{"route":"/sidebar/html","status":200}],' +
      '[{"route":"/sidebar/file","status":302},{"route":"/_platform/login","status":200}],' +
      '[{"route":"/sidebar/file","status":200}]]',
  );
  frames.dispose();
});

it('settles a document only once the frame committed it, redirect hops included', async () => {
  const tab = fakeTab();
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'frame-session',
    targetInfo: { targetId: 'F', type: 'iframe' },
    waitingForDebugger: true,
  });
  const navigated = (sessionId: string, frameId: string, loaderId: string, url: string) => {
    tab.emit(sessionId, 'Page.frameNavigated', { frame: { id: frameId, loaderId, url } });
  };
  const state = { settled: false, failed: false };
  navigated('page', 'F', 'old', 'http://h/sidebar/html/s/x');
  // The reload answered, but the frame still shows the previous document of the same route.
  const reload = frames.committed('F', 'reload', 2000, 'reload').then(
    () => (state.settled = true),
    () => (state.failed = true),
  );
  tab.emit('page', 'Network.responseReceived', {
    requestId: 'reload',
    frameId: 'F',
    type: 'Document',
    response: { status: 200, headers: {} },
  });
  await tab.settled();
  navigated('page', 'F', 'old', 'http://h/sidebar/html/s/x');
  navigated('page', 'G', 'reload', 'http://h/elsewhere');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(state).toEqual({ settled: false, failed: false });
  navigated('frame-session', 'F', 'reload', 'http://h/sidebar/html/s/x');
  await reload;
  expect(state).toEqual({ settled: true, failed: false });

  // A redirected navigation keeps one request id across hops and commits once, on its last hop.
  const self = frames.committed('F', 'self', 1000, 'self');
  navigated('page', 'F', 'self', 'http://h/_platform/login');
  await expect(self).resolves.toBeUndefined();
  // A document the frame never commits times out by label.
  await expect(frames.committed('F', 'never', 300, 'never')).rejects.toThrow('never uncommitted');
  frames.dispose();
});

it('records null request headers when Chrome reports none in time', async () => {
  const tab = fakeTab();
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Network.requestWillBeSent', {
    requestId: 'quiet',
    frameId: 'F',
    type: 'Document',
    request: { url: 'http://h/sidebar/file' },
  });
  tab.emit('page', 'Network.responseReceived', {
    requestId: 'quiet',
    frameId: 'F',
    type: 'Document',
    response: { status: 200, headers: {} },
  });

  const found = await frames.nextDocument('F', new Set(), () => true, 1000, 'quiet');

  expect(found.hops).toEqual([
    {
      url: 'http://h/sidebar/file',
      status: 200,
      headers: {},
      location: null,
      secFetchSite: null,
      cookie: null,
    },
  ]);
  frames.dispose();
}, 10_000);

it('attributes console errors by context, request or document URL, never by session', async () => {
  const tab = fakeTab();
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'frame-session',
    targetInfo: { targetId: 'F', type: 'iframe' },
    waitingForDebugger: true,
  });
  const context = (sessionId: string, id: number, frameId: string) => {
    tab.emit(sessionId, 'Runtime.executionContextCreated', {
      context: { id, auxData: { frameId, isDefault: true } },
    });
  };
  // In process: the probed frame's contexts, requests and documents are all the page session's.
  context('page', 1, 'M');
  context('page', 2, 'F');
  context('frame-session', 2, 'O');
  tab.emit('page', 'Page.frameNavigated', { frame: { id: 'M', url: 'http://h/' } });
  tab.emit('page', 'Page.frameNavigated', { frame: { id: 'F', url: 'http://h/sidebar/file?c' } });
  tab.emit('page', 'Network.requestWillBeSent', {
    requestId: 'fetch',
    frameId: 'F',
    type: 'Fetch',
  });
  tab.emit('page', 'Network.requestWillBeSent', {
    requestId: 'main',
    frameId: 'M',
    type: 'Script',
  });
  const log = (sessionId: string, text: string, extra: Record<string, unknown> = {}) => {
    tab.emit(sessionId, 'Log.entryAdded', { entry: { level: 'error', text, ...extra } });
  };
  const BLOCKED =
    "Blocked script execution in '[x]' because 'allow-scripts' permission is not set.";
  log('page', 'Failed to load resource: net::ERR_FAILED', { networkRequestId: 'fetch' });
  log('page', BLOCKED, { url: 'http://h/sidebar/file?c' });
  log('page', 'something else', { url: 'http://h/sidebar/file?c' });
  log('page', 'Failed to load resource: net::ERR_FAILED', { networkRequestId: 'main' });
  log('page', BLOCKED, { url: 'http://h/' });
  log('frame-session', BLOCKED);
  tab.emit('page', 'Log.entryAdded', { entry: { level: 'warning', text: 'ignored' } });
  tab.emit('page', 'Runtime.exceptionThrown', {
    exceptionDetails: { executionContextId: 2, exception: { description: 'Error: ERR_FAILED' } },
  });
  tab.emit('frame-session', 'Runtime.consoleAPICalled', {
    type: 'error',
    executionContextId: 2,
    args: [{ value: 'other frame error' }],
  });
  tab.emit('page', 'Runtime.consoleAPICalled', {
    type: 'error',
    executionContextId: 1,
    args: [{ value: 'page error' }],
  });
  tab.emit('page', 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'fine' }] });

  const report = frames.consoleReport('F');
  const texts = (rows: readonly { kind: string; text: string }[]) =>
    rows.map((row) => `${row.kind}:${row.text}`);

  expect(report.pageEvents).toBe(7);
  expect(texts(report.allowed)).toEqual([
    'log:Failed to load resource: net::ERR_FAILED',
    `log:${BLOCKED}`,
  ]);
  expect(texts(report.probeErrors)).toEqual(['log:something else', 'exception:Error: ERR_FAILED']);
  expect(texts(report.otherErrors)).toEqual([
    'log:Failed to load resource: net::ERR_FAILED',
    `log:${BLOCKED}`,
    `log:${BLOCKED}`,
    'console:other frame error',
    'console:page error',
  ]);
  frames.dispose();
});

it('records a failed resume of a still-attached target and ignores one that detached', async () => {
  const tab = fakeTab((_sessionId, method) => method === 'Runtime.enable');
  const frames = await trackFrames(tab.page, ALLOWED);
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'kept',
    targetInfo: { targetId: 'K', type: 'worker' },
    waitingForDebugger: true,
  });
  tab.emit('page', 'Target.attachedToTarget', {
    sessionId: 'gone',
    targetInfo: { targetId: 'G', type: 'worker' },
    waitingForDebugger: true,
  });
  tab.emit('page', 'Target.detachedFromTarget', { sessionId: 'gone' });
  await tab.settled();

  expect(frames.failures()).toEqual([{ type: 'worker', error: 'cdp-closed' }]);
  frames.dispose();
});

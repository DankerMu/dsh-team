import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page } from '@playwright/test';
import { afterEach, expect, it } from 'vitest';
import {
  EXPAND_BUTTON,
  explorerReselect,
  FILES_GUIDE,
  rowQuery,
} from './better-sidebar-browser-fixture.mjs';
import {
  converseInWorkbench,
  DS_UNLOAD_SOURCES,
  everythingPrinted,
  recordedError,
  scrub,
  showSidebarRows,
  StackWorkbenchFailure,
  workbenchSession,
} from './stack-browser-fixture.ts';

const REPLY = 'owned-reply-nonce';
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** What the stub page renders; the transcript is the only region a reply may count in. */
interface Dom {
  stop: boolean;
  send: boolean;
  transcript: string[];
  header: string[];
}

type Handler = (value: unknown) => void;

/** A console message as Playwright 1.63 hands it over: type, text and 0-based location. */
const consoleMessage = (text: string, url = '', line = 0, type = 'error') => ({
  type: () => type,
  text: () => text,
  location: () => ({ url, line, column: 0 }),
});
type ConsoleStub = ReturnType<typeof consoleMessage>;

interface StubOptions {
  /** Runs when the employee clicks SEND; schedules the stub's turn. */
  onSend: (dom: Dom, events: string[]) => void;
  /** Rejects the login navigation after emitting browser failures. */
  gotoFailure?: Error;
  closeFailure?: Error;
  /** Emitted in order by the login navigation. */
  console?: readonly ConsoleStub[];
}

/** Playwright 1.65's `waitFor` re-query back-off: 0, 20, 50, 100, 100ms, then every 500ms. */
const BACKOFF = [0, 20, 50, 100, 100];
const backoff = (attempt: number) => BACKOFF[attempt] ?? 500;

/** One `page.evaluate` call, ordered against the SEND click by a shared sequence. */
interface Evaluation {
  script: 'composer' | 'stop-latch';
  order: number;
}

/** A Chromium-free page: just the calls `converseInWorkbench` makes, over a mutable fake DOM. */
function stubBrowser(options: StubOptions) {
  let stop = false;
  // The in-page latch: armed only by the observer script, set on any STOP sighting, never reset.
  let latchArmed = false;
  let stopSeen = false;
  const dom: Dom = {
    get stop() {
      return stop;
    },
    set stop(value: boolean) {
      stop = value;
      if (value && latchArmed) stopSeen = true;
    },
    send: true,
    transcript: [],
    header: [],
  };
  const events: string[] = [];
  // Each screenshot's name and the text of every locator it masks.
  const masks: [string, string[] | undefined][] = [];
  const evaluations: Evaluation[] = [];
  const clicks: number[] = [];
  let sequence = 0;
  const handlers = new Map<string, Handler>();
  const visible = (
    check: () => boolean,
    click = () => undefined,
    pause = (attempt: number): number => (attempt === 0 ? 0 : 10),
  ) => {
    const locator = {
      first: () => locator,
      count: () => Promise.resolve(check() ? 1 : 0),
      focus: () => Promise.resolve(),
      click() {
        click();
        return Promise.resolve();
      },
      async waitFor({ timeout }: { timeout: number }) {
        const deadline = performance.now() + timeout;
        for (let attempt = 0; ; attempt++) {
          const wait = pause(attempt);
          if (wait > 0) await delay(wait);
          if (check()) return;
          if (performance.now() > deadline) throw new Error('stub waitFor timeout');
        }
      },
    };
    return locator;
  };
  const evaluate = (expression: string) => {
    if (expression.includes('[contenteditable="true"]')) {
      evaluations.push({ script: 'composer', order: sequence++ });
      return Promise.resolve('ready');
    }
    if (
      expression.includes('MutationObserver') &&
      expression.includes('Stop generating') &&
      expression.includes('window.__dshTeamStopSeen = true')
    ) {
      evaluations.push({ script: 'stop-latch', order: sequence++ });
      latchArmed = true;
      if (stop) stopSeen = true;
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error('stub evaluate: unexpected script'));
  };
  const waitForFunction = async (
    expression: string,
    _arg: undefined,
    { timeout }: { timeout: number },
  ) => {
    if (expression !== 'window.__dshTeamStopSeen === true')
      throw new Error('stub waitForFunction: unexpected predicate');
    const deadline = performance.now() + timeout;
    while (!stopSeen) {
      if (performance.now() > deadline) throw new Error('stub waitForFunction timeout');
      await delay(10);
    }
  };
  const page = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    goto() {
      handlers.get('response')?.('login document');
      for (const message of options.console ?? []) handlers.get('console')?.(message);
      if (options.gotoFailure === undefined) return Promise.resolve();
      handlers.get('console')?.(consoleMessage('stub console failure'));
      handlers.get('pageerror')?.(new Error('stub page failure'));
      handlers.get('requestfailed')?.({ method: () => 'GET', url: () => 'http://stub/asset.js' });
      return Promise.reject(options.gotoFailure);
    },
    screenshot({ path, mask }: { path: string; mask?: { text: string }[] }) {
      events.push(`screenshot:${basename(path)}`);
      masks.push([basename(path), mask?.map(({ text }) => text)]);
      return Promise.resolve();
    },
    reload() {
      events.push('reload');
      return Promise.resolve();
    },
    getByLabel: () => ({ fill: () => Promise.resolve() }),
    getByRole: () => ({ click: () => Promise.resolve() }),
    waitForURL: () => Promise.resolve(),
    evaluate,
    waitForFunction,
    keyboard: { insertText: () => Promise.resolve() },
    getByText: (text: string) => ({
      ...visible(() => dom.transcript.includes(text) || dom.header.includes(text)),
      text,
    }),
    locator(selector: string) {
      if (selector === '[data-chat-flow]')
        return { getByText: (text: string) => visible(() => dom.transcript.includes(text)) };
      if (selector.includes('Stop generating')) return visible(() => dom.stop, undefined, backoff);
      if (selector.includes('Send message')) {
        return visible(
          () => dom.send,
          () => {
            clicks.push(sequence++);
            options.onSend(dom, events);
          },
        );
      }
      return visible(() => true);
    },
  };
  const context = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    newPage: () => Promise.resolve(page),
  };
  const browser = {
    newContext: () => Promise.resolve(context),
    close: () =>
      options.closeFailure === undefined ? Promise.resolve() : Promise.reject(options.closeFailure),
  };
  const emit = (name: string, value: unknown) => handlers.get(name)?.(value);
  return {
    events,
    masks,
    evaluations,
    clicks,
    emit,
    launch: () => Promise.resolve(browser as unknown as Browser),
  };
}

async function conversation(turnComplete: () => Promise<void>, timeout = 5_000) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-stack-browser-'));
  directories.push(directory);
  return {
    base: 'http://127.0.0.1:1',
    directory,
    email: 'employee@example.test',
    password: 'stub-password',
    message: 'stub message',
    reply: REPLY,
    timeout,
    turnComplete,
  };
}

it('waits past an early reply until STOP has appeared, disappeared and the provider completed', async () => {
  const stub = stubBrowser({
    onSend(dom, events) {
      // The title request's reply is already rendered before the turn visibly starts.
      dom.transcript.push(REPLY);
      void (async () => {
        await delay(600);
        dom.stop = true;
        dom.send = false;
        events.push('stop-shown');
        await delay(600);
        dom.stop = false;
        dom.send = true;
        events.push('stop-hidden');
      })();
    },
  });
  const turnComplete = async () => {
    await delay(1_800);
    stub.events.push('turn-complete');
  };
  const evidence = await converseInWorkbench(await conversation(turnComplete), stub.launch);
  expect(stub.events).toEqual([
    'screenshot:login.png',
    'screenshot:workbench.png',
    'stop-shown',
    'stop-hidden',
    'turn-complete',
    'screenshot:reply.png',
  ]);
  expect(evidence.screenshots).toEqual(['login.png', 'workbench.png', 'reply.png']);
});

it('latches a short turn whose STOP shows only between two back-off samples', async () => {
  const stub = stubBrowser({
    onSend(dom, events) {
      dom.transcript.push(REPLY);
      // Visible from about 100ms to 150ms after the click: between the 70ms and 170ms samples.
      void (async () => {
        await delay(100);
        dom.stop = true;
        dom.send = false;
        events.push('stop-shown');
        await delay(50);
        dom.stop = false;
        dom.send = true;
        events.push('stop-hidden');
      })();
    },
  });
  const turnComplete = async () => {
    await delay(300);
    stub.events.push('turn-complete');
  };

  const evidence = await converseInWorkbench(await conversation(turnComplete, 1_500), stub.launch);

  expect(stub.events).toEqual([
    'screenshot:login.png',
    'screenshot:workbench.png',
    'stop-shown',
    'stop-hidden',
    'turn-complete',
    'screenshot:reply.png',
  ]);
  expect(evidence.screenshots).toEqual(['login.png', 'workbench.png', 'reply.png']);
  const latch = stub.evaluations.filter((evaluation) => evaluation.script === 'stop-latch');
  expect(latch).toHaveLength(1);
  expect(stub.clicks).toHaveLength(1);
  expect(latch[0]?.order).toBeLessThan(stub.clicks[0] ?? -1);
});

it('fails when STOP never appears, even after the provider served the reply', async () => {
  const stub = stubBrowser({
    onSend(dom) {
      // The reply is in the transcript and SEND stays available, but the turn never shows STOP.
      dom.transcript.push(REPLY);
    },
  });

  const failure = converseInWorkbench(
    await conversation(() => Promise.resolve(), 1_500),
    stub.launch,
  );

  await expect(failure).rejects.toThrow('stub waitForFunction timeout');
  await expect(failure).rejects.toBeInstanceOf(StackWorkbenchFailure);
  expect(stub.events).not.toContain('screenshot:reply.png');
  expect(stub.events.at(-1)).toBe('screenshot:failure.png');
});

it('does not accept the reply outside the conversation transcript', async () => {
  const stub = stubBrowser({
    onSend(dom) {
      // Only the session title carries the reply; the transcript never does.
      dom.header.push(REPLY);
      dom.stop = true;
      dom.send = false;
      setTimeout(() => {
        dom.stop = false;
        dom.send = true;
      }, 400);
    },
  });
  const failure = converseInWorkbench(
    await conversation(() => Promise.resolve(), 1_500),
    stub.launch,
  );
  await expect(failure).rejects.toThrow('stub waitFor timeout');
  expect(stub.events).not.toContain('screenshot:reply.png');
  expect(stub.events.at(-1)).toBe('screenshot:failure.png');
  await expect(failure).rejects.toBeInstanceOf(StackWorkbenchFailure);
});

it('keeps the original failure and its browser evidence when closing the browser also fails', async () => {
  const original = new Error('stub navigation failure');
  const closeFailure = new Error('stub close failure');
  const stub = stubBrowser({ onSend: () => undefined, gotoFailure: original, closeFailure });
  const error: unknown = await converseInWorkbench(
    await conversation(() => Promise.resolve()),
    stub.launch,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  const [first, second] = (error as AggregateError).errors as unknown[];
  expect(first).toBeInstanceOf(StackWorkbenchFailure);
  const failure = first as StackWorkbenchFailure;
  expect(failure.cause).toBeUndefined();
  expect(second).toBe(closeFailure);
  expect(failure.message).toContain('stub navigation failure');
  expect(failure.message).toContain('consoleErrors=1 pageErrors=1 failedRequests=1');
  expect(failure.evidence).toMatchObject({
    screenshots: ['failure.png'],
    consoleErrors: ['stub console failure'],
    pageErrors: ['stub page failure'],
    failedRequests: ['GET http://stub/asset.js'],
  });
  expect(JSON.stringify(failure.evidence)).not.toContain('stub-password');
});

const UNLOAD = 'Permissions policy violation: unload is not allowed in this document.';
const ORIGIN = 'http://127.0.0.1:1';
const MOUNT = `${ORIGIN}/sidebar/onlyoffice/ds/9.4.0-c83aecd3de42866b80ccf786af6354d6/`;
const DOCX_MAIN = 'web-apps/apps/documenteditor/main/app/controller/Main.js';
/** #671's measured sources: 0-based `location().line`, the issue's 1-based line minus one. */
const MEASURED = [
  [DOCX_MAIN, 2145],
  ['web-apps/apps/spreadsheeteditor/main/app/controller/Main.js', 1785],
  ['web-apps/apps/presentationeditor/main/app/controller/Main.js', 1638],
  ['sdkjs/cell/sdk-all.js', 465226],
  ['sdkjs-plugins/v1/plugins.js', 39],
] as const;
// A Document Server script URL as Chromium reports it, its cache query included.
const script = (path: string) => `${MOUNT}${path}?_dc=0`;

it('pins the measured Document Server unload sources', () => {
  expect(DS_UNLOAD_SOURCES).toEqual(new Map(MEASURED));
});

it.each(MEASURED)('allows the unload report from %s at line %d by its source', (path, line) => {
  const source = `${path}:${String(line)}`;

  expect(recordedError(consoleMessage(UNLOAD, script(path), line), ORIGIN)).toEqual({
    unload: source,
  });
  expect(scrub(source)).toBe(source);
});

it.each([
  ['the text with a character appended', consoleMessage(`${UNLOAD}x`, script(DOCX_MAIN), 2145)],
  ['a truncated text', consoleMessage(UNLOAD.slice(0, -1), script(DOCX_MAIN), 2145)],
  [
    'another origin',
    consoleMessage(UNLOAD, script(DOCX_MAIN).replace(ORIGIN, 'http://127.0.0.2:1'), 2145),
  ],
  ['version 9.4.1', consoleMessage(UNLOAD, script(DOCX_MAIN).replace('/9.4.0-', '/9.4.1-'), 2145)],
  [
    'an unknown script at a measured line',
    consoleMessage(UNLOAD, script('web-apps/apps/pdfeditor/main/app/controller/Main.js'), 2145),
  ],
  ['a known script at another measured line', consoleMessage(UNLOAD, script(DOCX_MAIN), 1785)],
  ['an empty location URL', consoleMessage(UNLOAD, '', 2145)],
  ['an ordinary error', consoleMessage('Uncaught TypeError: x', script(DOCX_MAIN), 2145)],
])('keeps %s a console error', (_case, message) => {
  expect(recordedError(message, ORIGIN)).toEqual({ error: message.text() });
});

it('records nothing of a message that is not an error', () => {
  const warning = consoleMessage(UNLOAD, script(DOCX_MAIN), 2145, 'warning');

  expect(recordedError(warning, ORIGIN)).toBeUndefined();
});

it('routes an allowed unload report out of the console errors and keeps every other in order', async () => {
  const stub = stubBrowser({
    onSend: () => undefined,
    console: [
      consoleMessage(UNLOAD, script(DOCX_MAIN), 2145),
      consoleMessage(UNLOAD, script('sdkjs/word/sdk-all.js'), 2145),
      consoleMessage(UNLOAD, script(DOCX_MAIN), 2146),
      consoleMessage('stub info', '', 0, 'info'),
      consoleMessage('Uncaught TypeError: x'),
    ],
  });

  const evidence = await workbenchSession(
    await conversation(() => Promise.resolve()),
    { label: 'unload', failure: 'unload-failure' },
    () => Promise.resolve(),
    stub.launch,
  );

  expect(evidence.unloadViolations).toEqual([`${DOCX_MAIN}:2145`]);
  expect(evidence.consoleErrors).toEqual([UNLOAD, UNLOAD, 'Uncaught TypeError: x']);
});

it('hands every response of the observed session to the observer, and none after teardown', async () => {
  const stub = stubBrowser({ onSend: () => undefined });
  const seen: unknown[] = [];
  const session = await conversation(() => Promise.resolve());
  await workbenchSession(
    session,
    { label: 'observer', failure: 'observer-failure' },
    () => {
      stub.emit('response', 'workbench document');
      return Promise.resolve();
    },
    stub.launch,
    (response) => seen.push(response),
  );
  stub.emit('response', 'teardown response');

  expect(seen).toEqual(['login document', 'workbench document']);
});

it('excuses only the requests a deliberate reload cancels, then waits for the composer', async () => {
  const stub = stubBrowser({ onSend: () => undefined });
  const request = (url: string) => ({ method: () => 'GET', url: () => url });
  const [stream, finished, later] = [
    request('http://stub/plugins/events'),
    request('http://stub/done.js'),
    request('http://stub/late.js'),
  ];
  const evidence = await workbenchSession(
    await conversation(() => Promise.resolve()),
    { label: 'reload', failure: 'reload-failure' },
    async (_page, _shoot, reload) => {
      stub.emit('request', stream);
      stub.emit('request', finished);
      stub.emit('requestfinished', finished);
      await reload();
      // The reload cancelled the open stream; a request failing after it still counts.
      stub.emit('requestfailed', stream);
      stub.emit('requestfailed', finished);
      stub.emit('request', later);
      stub.emit('requestfailed', later);
    },
    stub.launch,
  );

  expect(stub.events).toEqual(['reload']);
  expect(evidence.failedRequests).toEqual(['GET http://stub/done.js', 'GET http://stub/late.js']);
  expect(evidence.requests).toBe(3);
});

it('counts only requests and WebSockets off the platform origin, a same-origin blob: included', async () => {
  const stub = stubBrowser({ onSend: () => undefined });
  const urls = {
    http: 'http://127.0.0.1:1/plugins/client.js',
    foreignHttp: 'http://127.0.0.2:1/font.woff2',
    https: 'https://127.0.0.1:1/plugins/client.js',
    blob: 'blob:http://127.0.0.1:1/2f6c2d1e-pdf-worker',
    foreignBlob: 'blob:http://127.0.0.2:1/2f6c2d1e-pdf-worker',
    ws: 'ws://127.0.0.1:1/events',
    foreignWs: 'ws://127.0.0.2:1/events',
    wss: 'wss://127.0.0.1:1/events',
  };
  const event = (url: string) => ({ method: () => 'GET', url: () => url });

  const evidence = await workbenchSession(
    await conversation(() => Promise.resolve()),
    { label: 'origins', failure: 'origins-failure' },
    () => {
      for (const url of [urls.http, urls.foreignHttp, urls.https, urls.blob, urls.foreignBlob])
        stub.emit('request', event(url));
      for (const url of [urls.ws, urls.foreignWs, urls.wss]) stub.emit('websocket', event(url));
      return Promise.resolve();
    },
    stub.launch,
  );

  expect(evidence.externalRequests).toEqual([
    urls.foreignHttp,
    urls.https,
    urls.foreignBlob,
    urls.foreignWs,
    urls.wss,
  ]);
  expect([evidence.requests, evidence.websockets]).toEqual([5, 3]);
});

it('masks the named text in every screenshot of a session, the failure screenshot included', async () => {
  const stub = stubBrowser({ onSend: () => undefined });
  const masked = ['保存未写回文件（文档服务会重试'];
  const names = { label: 'masked', login: 'login', failure: 'masked-failure', masked };

  const failure = workbenchSession(
    await conversation(() => Promise.resolve()),
    names,
    async (_page, shoot) => {
      await shoot('editor');
      throw new Error('stub body failure');
    },
    stub.launch,
  );

  await expect(failure).rejects.toThrow('stub body failure');
  expect(stub.masks).toEqual([
    ['login.png', masked],
    ['editor.png', masked],
    ['masked-failure.png', masked],
  ]);
});

it('passes no mask in a session that names no text', async () => {
  const stub = stubBrowser({ onSend: () => undefined });

  await workbenchSession(
    await conversation(() => Promise.resolve()),
    { label: 'plain', failure: 'plain-failure' },
    (_page, shoot) => shoot('editor'),
    stub.launch,
  );

  expect(stub.masks).toEqual([['editor.png', undefined]]);
});

/** A page whose in-page expressions answer from `shown`; clicks are recorded by expression. */
function sidebarPage(shown: Set<string>) {
  const clicks: string[] = [];
  const page = {
    evaluate: (expression: string) => Promise.resolve(shown.has(expression)),
    evaluateHandle: (expression: string) =>
      Promise.resolve({
        asElement: () =>
          shown.has(expression)
            ? { click: () => Promise.resolve(void clicks.push(expression)) }
            : null,
      }),
  };
  // Only `evaluate` and `evaluateHandle` are called; the stub stands in for a Playwright page.
  return { clicks, page: page as unknown as Page };
}

const rowsShown = (names: readonly string[]) =>
  names.map((name) => `Boolean(${rowQuery(name)})`).join(' && ');

it('reports the sidebar rows shown only when every named row is visible, without a click', async () => {
  const names = ['打包甲.txt', 'archive-b.bin'];
  const { clicks, page } = sidebarPage(new Set([rowsShown(names), EXPAND_BUTTON]));

  expect(await showSidebarRows(page, names)).toBe(true);

  expect(clicks).toEqual([]);
});

const RESELECT = explorerReselect('旧通知.doc');

it.each([
  ['expands the collapsed Sidebar first', [EXPAND_BUTTON, FILES_GUIDE, RESELECT], EXPAND_BUTTON],
  ['takes the files guide next', [FILES_GUIDE, RESELECT], FILES_GUIDE],
  ['reselects the explorer tab of the first name last', [RESELECT], RESELECT],
])('%s, one step toward the rows', async (_case, present, target) => {
  const { clicks, page } = sidebarPage(new Set(present));

  expect(await showSidebarRows(page, ['旧通知.doc', '旧报表.xls'])).toBe(false);

  expect(clicks).toEqual([target]);
});

it('takes no step when no row, expand button, guide or reselectable tab is shown', async () => {
  const { clicks, page } = sidebarPage(new Set([explorerReselect('旧报表.xls')]));

  expect(await showSidebarRows(page, ['旧通知.doc'])).toBe(false);

  expect(clicks).toEqual([]);
});

// A letters-only document key: it is a lowercase word too, so only the key rule can catch it.
const KEY = 'ab'.repeat(32);
const SOCKET = `ws://127.0.0.1:1/doc/${KEY}/c/?EIO=4&transport=websocket`;
const POLL = `http://127.0.0.1:1/doc/${KEY}/c/?EIO=4&transport=polling`;
const LEAKED = [KEY, 'EIO=4', 'transport='];
/** A session that saw the Document Server socket fail: its key and query in every list. */
const leaky = () => ({
  screenshots: ['office-editor-docx-failure.png'],
  consoleErrors: [`WebSocket connection to '${SOCKET}' failed: net::ERR_CONNECTION_REFUSED`],
  unloadViolations: ['sdkjs/cell/sdk-all.js:465226', 'sdkjs-plugins/v1/plugins.js:39'],
  pageErrors: [`Uncaught Error: socket /doc/${KEY}/c/ closed`],
  failedRequests: [`GET ${POLL}`],
  externalRequests: [`http://127.0.0.2:1/doc/${KEY}/c/?EIO=4`],
  ...{ requests: 9, websockets: 1 },
});
const expectNoLeak = (printed: string) => {
  for (const secret of LEAKED) expect(printed).not.toContain(secret);
};

const DS = 'http://127.0.0.1:1/sidebar/onlyoffice/ds/9.4.0-c83aecd3de42866b80ccf786af6354d6';
const FRAMES = (version: string) =>
  `Office editor typing or saving failed, frames [{"path":"${version}/web-apps/apps/documenteditor/main/index.html","focus":"BODY#"},{"path":"about:blank","focus":"DIV#area_id"}]`;
const LOCATOR = `locator.waitFor: Timeout 30000ms exceeded.\n  - waiting for locator('[data-dsh-team-office-hints="docx"] iframe[src*="/sidebar/onlyoffice/ds/"]').contentFrame().locator('#editor_sdk') to be visible`;
const REFUSED = 'Failed to load resource: net::ERR_CONNECTION_REFUSED';

it.each([
  [
    'a typeAndSave frames JSON',
    FRAMES(DS),
    FRAMES('http://127.0.0.1:1/sidebar/onlyoffice/ds/9.4.<redacted>'),
  ],
  ['a Playwright #id locator', LOCATOR, LOCATOR],
  ['a Chromium ERR_* code', REFUSED, REFUSED],
])('keeps %s readable', (_case, text, readable) => {
  expect(scrub(text)).toBe(readable);
});

it.each([
  ['a known secret', 'token s3cr3t-value used', ['s3cr3t-value'], 'token <redacted> used'],
  ['a letters-only document key', `/doc/${KEY}/c/`, [], '/doc/<redacted>/c/'],
  [
    'a query, up to whitespace',
    `GET ${POLL} 502`,
    [],
    'GET http://127.0.0.1:1/doc/<redacted>/c/ 502',
  ],
  [
    'a query and a hash, up to a quote or a JSON delimiter',
    `{"url":"/a?t=1","list":[/b#c,'/d?e']}`,
    [],
    `{"url":"/a","list":[/b,'/d']}`,
  ],
  [
    'an EDITOR nonce of letters only',
    `typed EDITOR${'ABCDEF'.repeat(5)}AB`,
    [],
    'typed <redacted>',
  ],
  [
    'a mixed 20-character run in a path',
    `/cache/files/${'Ab1'.repeat(7)}/x`,
    [],
    '/cache/files/<redacted>/x',
  ],
])('removes %s', (_case, text, secrets, scrubbed) => {
  expect(scrub(text, secrets)).toBe(scrubbed);
});

it('finds a key in an unscrubbed property, enumerable or not, and in an AggregateError entry', () => {
  const raw = Object.defineProperty(new Error('Stack workbench failed'), 'evidence', {
    value: leaky(),
    enumerable: false,
  });

  const printed = [everythingPrinted(raw), everythingPrinted(new AggregateError([raw], 'both'))];

  for (const text of printed) for (const secret of LEAKED) expect(text).toContain(secret);
});

it('folds the scrubbed cause chain into its message and keeps no cause and no raw list', () => {
  const evidence = leaky();
  const cause = new Error(`locator.click: Timeout on ${POLL}`, {
    cause: new Error(`frame /doc/${KEY}/c/`, { cause: 'a thrown string' }),
  });

  const failure = new StackWorkbenchFailure(cause, evidence, 'office editor docx');

  const counts = 'consoleErrors=1 pageErrors=1 failedRequests=1 externalRequests=1';
  expect(failure.message).toBe(
    `Stack workbench office editor docx failed (${counts}): locator.click: Timeout on http://127.0.0.1:1/doc/<redacted>/c/ <- frame /doc/<redacted>/c/ <- unknown failure`,
  );
  expect(Object.hasOwn(failure, 'cause')).toBe(false);
  expect(failure.evidence).toEqual({
    screenshots: ['office-editor-docx-failure.png'],
    consoleErrors: [
      "WebSocket connection to 'ws://127.0.0.1:1/doc/<redacted>/c/' failed: net::ERR_CONNECTION_REFUSED",
    ],
    unloadViolations: ['sdkjs/cell/sdk-all.js:465226', 'sdkjs-plugins/v1/plugins.js:39'],
    pageErrors: ['Uncaught Error: socket /doc/<redacted>/c/ closed'],
    failedRequests: ['GET http://127.0.0.1:1/doc/<redacted>/c/'],
    externalRequests: ['http://127.0.0.2:1/doc/<redacted>/c/'],
    ...{ requests: 9, websockets: 1 },
  });
  expectNoLeak(everythingPrinted(failure));
  expect(evidence).toEqual(leaky());
});

it('folds at most eight messages of the cause chain', () => {
  let cause = new Error('level 10');
  for (let level = 9; level > 0; level--) cause = new Error(`level ${String(level)}`, { cause });

  const failure = new StackWorkbenchFailure(cause, { ...leaky(), consoleErrors: [] });

  const chain = Array.from({ length: 8 }, (_, index) => `level ${String(index + 1)}`);
  expect(failure.message).toMatch(/^Stack workbench conversation failed \(consoleErrors=0 /);
  expect(failure.message.endsWith(`: ${chain.join(' <- ')}`)).toBe(true);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@playwright/test';
import { afterEach, expect, it } from 'vitest';
import {
  converseInWorkbench,
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

interface StubOptions {
  /** Runs when the employee clicks SEND; schedules the stub's turn. */
  onSend: (dom: Dom, events: string[]) => void;
  /** Rejects the login navigation after emitting browser failures. */
  gotoFailure?: Error;
  closeFailure?: Error;
}

/** Playwright 1.63's `waitFor` re-query back-off: 0, 20, 50, 100, 100ms, then every 500ms. */
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
      if (options.gotoFailure === undefined) return Promise.resolve();
      handlers.get('console')?.({ type: () => 'error', text: () => 'stub console failure' });
      handlers.get('pageerror')?.(new Error('stub page failure'));
      handlers.get('requestfailed')?.({ method: () => 'GET', url: () => 'http://stub/asset.js' });
      return Promise.reject(options.gotoFailure);
    },
    screenshot({ path }: { path: string }) {
      events.push(`screenshot:${basename(path)}`);
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
    getByText: (text: string) =>
      visible(() => dom.transcript.includes(text) || dom.header.includes(text)),
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
  expect(failure.cause).toBe(original);
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

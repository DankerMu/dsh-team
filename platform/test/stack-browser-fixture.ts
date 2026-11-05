import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser, Page, Request, Response } from '@playwright/test';

// DSH workbench selectors, as scripts/probe-dsh-api-ui.mjs drives the released client.
const SEND = 'button[aria-label="Send message"],button[aria-label="发送消息"]';
const STOP = 'button[aria-label="Stop generating"],button[aria-label="停止生成"]';
const NOTICE_LABELS = ['Continue', '继续'];
// The conversation transcript: the released 0.2.1-rc.2 ChatView message column
// (dsh-client-ui-chat lib/client.js, `"data-chat-flow": ""` on ChatView's column). The session
// title renders in ConversationHeader's <header> and the session list in the sidebar, both
// outside it (dsh-client-ui-conversation lib/client.js, ConversationRoot/ConversationHeader).
const TRANSCRIPT = '[data-chat-flow]';

/** Everything the local browser lane observed; counts only, never cookies or credentials. */
export interface StackBrowserEvidence {
  readonly screenshots: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  /** Requests and WebSockets whose origin is not the platform's public origin. */
  readonly externalRequests: readonly string[];
  readonly requests: number;
  readonly websockets: number;
}

/** One employee's observed browser session on the platform's public origin. */
export interface StackSession {
  /** The platform's public origin, the only origin the browser may contact. */
  readonly base: string;
  /** Screenshot directory, `reports/stack/<runId>/`. */
  readonly directory: string;
  readonly email: string;
  readonly password: string;
  readonly timeout: number;
}

export interface StackConversation extends StackSession {
  readonly message: string;
  readonly reply: string;
  /** Resolves once the provider has served the whole turn; the transcript checks follow it. */
  readonly turnComplete: () => Promise<void>;
}

/** What a session names in its messages and screenshots. */
export interface StackSessionNames {
  /** Used in failure messages: `Stack workbench <label> failed`. */
  readonly label: string;
  /** Taken on the login page before any field holds a credential; omitted when absent. */
  readonly login?: string;
  /** Best-effort screenshot of a failed session. */
  readonly failure: string;
}

/** A failed session: the original failure as `cause`, plus everything observed so far. */
export class StackWorkbenchFailure extends Error {
  readonly evidence: StackBrowserEvidence;

  constructor(cause: unknown, evidence: StackBrowserEvidence, label = 'conversation') {
    const counts = (['consoleErrors', 'pageErrors', 'failedRequests', 'externalRequests'] as const)
      .map((key) => `${key}=${String(evidence[key].length)}`)
      .join(' ');
    const reason = cause instanceof Error ? cause.message : 'unknown failure';
    super(`Stack workbench ${label} failed (${counts}): ${reason}`, { cause });
    this.name = 'StackWorkbenchFailure';
    this.evidence = evidence;
  }
}

// A usable composer, or one click on the first-use notice; the root config has no DOM lib.
const COMPOSER_STATE = `(() => {
  const composer = document.querySelector('[contenteditable="true"]');
  if (composer !== null && composer.closest('[inert]') === null) return 'ready';
  const labels = ${JSON.stringify(NOTICE_LABELS)};
  const notice = [...document.querySelectorAll('button')].find(
    (button) =>
      labels.includes((button.textContent || '').trim()) &&
      !button.disabled &&
      button.closest('[inert]') === null,
  );
  if (notice === undefined) return 'waiting';
  notice.click();
  return 'notice';
})()`;
export const composerState = (page: Page) => page.evaluate<string>(COMPOSER_STATE);

export async function until(check: () => Promise<boolean>, timeout: number, label: string) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Stack workbench ${label} not reached`);
    await delay(250);
  }
}

/**
 * Logs one employee in through the platform login page and waits for the gateway's real DSH
 * workbench composer; `body` then drives the page. Console, page, request-failure and external
 * request evidence covers the whole session and stops before the browser closes. `onResponse`
 * sees every response of the observed session, the login and workbench documents included.
 * `reload` reloads the page and waits for the composer again; only the requests still open when
 * it navigates (the event stream, for one) may fail without counting, as at teardown.
 */
export async function workbenchSession(
  session: StackSession,
  names: StackSessionNames,
  body: (
    page: Page,
    shoot: (name: string) => Promise<void>,
    reload: () => Promise<void>,
  ) => Promise<void>,
  launch: () => Promise<Browser> = () => chromium.launch(),
  onResponse?: (response: Response) => void,
): Promise<StackBrowserEvidence> {
  const { base, directory, timeout } = session;
  const platform = new URL(base);
  const screenshots: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  let requests = 0;
  let websockets = 0;
  let observing = true;
  const open = new Set<Request>();
  const cancelled = new Set<Request>();
  const foreign = (url: string, scheme: 'http:' | 'ws:') => {
    const target = new URL(url);
    if (target.protocol !== scheme || target.host !== platform.host) externalRequests.push(url);
  };
  const evidence = (): StackBrowserEvidence => ({
    screenshots,
    consoleErrors,
    pageErrors,
    failedRequests,
    externalRequests,
    requests,
    websockets,
  });
  await mkdir(directory, { recursive: true });
  const browser = await launch();
  const failures: unknown[] = [];
  let page: Page | undefined;
  const shoot = async (name: string) => {
    if (page === undefined) throw new Error('Stack workbench page not open');
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
    screenshots.push(`${name}.png`);
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', (request) => {
      if (!observing) return;
      requests++;
      open.add(request);
      foreign(request.url(), 'http:');
    });
    context.on('requestfinished', (request) => {
      open.delete(request);
    });
    context.on('requestfailed', (request) => {
      open.delete(request);
      if (cancelled.delete(request)) return;
      if (observing) failedRequests.push(`${request.method()} ${request.url()}`);
    });
    context.on('response', (response) => {
      if (observing) onResponse?.(response);
    });
    page = await context.newPage();
    page.on('console', (message) => {
      if (observing && message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      if (observing) pageErrors.push(error.message);
    });
    page.on('websocket', (socket) => {
      if (!observing) return;
      websockets++;
      foreign(socket.url(), 'ws:');
    });
    await page.goto(`${base}/_platform/login`, { waitUntil: 'networkidle' });
    // Captured before any field holds a credential.
    if (names.login !== undefined) await shoot(names.login);
    await page.getByLabel('邮箱').fill(session.email);
    await page.getByLabel('密码').fill(session.password);
    await Promise.all([
      page.waitForURL(`${base}/`, { timeout }),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    const workbench = page;
    const ready = () =>
      until(async () => (await composerState(workbench)) === 'ready', timeout, 'composer');
    await ready();
    await body(workbench, shoot, async () => {
      for (const request of open) cancelled.add(request);
      await workbench.reload({ waitUntil: 'load', timeout });
      await ready();
    });
  } catch (error) {
    // Best effort: a failed screenshot must not replace the session's own failure.
    await shoot(names.failure).catch(() => undefined);
    failures.push(new StackWorkbenchFailure(error, evidence(), names.label));
  }
  // Teardown aborts are not part of the observed session.
  observing = false;
  try {
    await browser.close();
  } catch (error) {
    failures.push(error);
  }
  // The session's failure stays first; a close failure follows it.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `Stack workbench ${names.label} and browser close failed`);
  return evidence();
}

/**
 * Logs one employee in, lands on the gateway's real DSH workbench and sends one message. The
 * turn must visibly start, the provider must report it served, and only then are the transcript
 * reply and the end of the turn accepted.
 */
export function converseInWorkbench(
  conversation: StackConversation,
  launch?: () => Promise<Browser>,
): Promise<StackBrowserEvidence> {
  const { timeout } = conversation;
  const names = { label: 'conversation', login: 'login', failure: 'failure' };
  return workbenchSession(
    conversation,
    names,
    async (page, shoot) => {
      await shoot('workbench');
      await page.locator('[contenteditable="true"]').first().focus();
      await page.keyboard.insertText(conversation.message);
      // A turn-end state before the turn ever started proves nothing: latch STOP first. A
      // scripted turn can finish within a second, so the in-page wait is armed before the click.
      await Promise.all([
        page.locator(STOP).first().waitFor({ state: 'visible', timeout }),
        page.locator(SEND).first().click(),
      ]);
      await conversation.turnComplete();
      await page
        .locator(TRANSCRIPT)
        .getByText(conversation.reply)
        .first()
        .waitFor({ state: 'visible', timeout });
      await until(
        async () =>
          (await page.locator(STOP).count()) === 0 && (await page.locator(SEND).count()) > 0,
        timeout,
        'turn end',
      );
      await shoot('reply');
    },
    launch,
  );
}

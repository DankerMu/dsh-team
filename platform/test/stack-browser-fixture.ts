import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';

// DSH workbench selectors, as scripts/probe-dsh-api-ui.mjs drives the released client.
const SEND = 'button[aria-label="Send message"],button[aria-label="发送消息"]';
const STOP = 'button[aria-label="Stop generating"],button[aria-label="停止生成"]';
const NOTICE_LABELS = ['Continue', '继续'];

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

export interface StackConversation {
  /** The platform's public origin, the only origin the browser may contact. */
  readonly base: string;
  /** Screenshot directory, `reports/stack/<runId>/`. */
  readonly directory: string;
  readonly email: string;
  readonly password: string;
  readonly message: string;
  readonly reply: string;
  readonly timeout: number;
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
const composerState = (page: Page) => page.evaluate<string>(COMPOSER_STATE);

async function until(check: () => Promise<boolean>, timeout: number, label: string) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Stack workbench ${label} not reached`);
    await delay(250);
  }
}

/**
 * Logs one employee in through the platform login page, lands on the gateway's real DSH
 * workbench, sends one message and waits for the reply text and the end of the turn.
 */
export async function converseInWorkbench(
  conversation: StackConversation,
): Promise<StackBrowserEvidence> {
  const { base, directory, timeout } = conversation;
  const platform = new URL(base);
  const screenshots: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  let requests = 0;
  let websockets = 0;
  let observing = true;
  const foreign = (url: string, scheme: 'http:' | 'ws:') => {
    const target = new URL(url);
    if (target.protocol !== scheme || target.host !== platform.host) externalRequests.push(url);
  };
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', (request) => {
      if (!observing) return;
      requests++;
      foreign(request.url(), 'http:');
    });
    context.on('requestfailed', (request) => {
      if (observing) failedRequests.push(`${request.method()} ${request.url()}`);
    });
    const page = await context.newPage();
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
    const shoot = async (name: string) => {
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
      screenshots.push(`${name}.png`);
    };
    await page.goto(`${base}/_platform/login`, { waitUntil: 'networkidle' });
    // Captured before any field holds a credential.
    await shoot('login');
    await page.getByLabel('邮箱').fill(conversation.email);
    await page.getByLabel('密码').fill(conversation.password);
    await Promise.all([
      page.waitForURL(`${base}/`, { timeout }),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    await until(async () => (await composerState(page)) === 'ready', timeout, 'composer');
    await shoot('workbench');
    await page.locator('[contenteditable="true"]').first().focus();
    await page.keyboard.insertText(conversation.message);
    await page.locator(SEND).first().click();
    await page.getByText(conversation.reply).first().waitFor({ state: 'visible', timeout });
    await until(
      async () =>
        (await page.locator(STOP).count()) === 0 && (await page.locator(SEND).count()) > 0,
      timeout,
      'turn end',
    );
    await shoot('reply');
    observing = false;
  } finally {
    // Teardown aborts are not part of the observed conversation.
    observing = false;
    await browser.close();
  }
  return {
    screenshots,
    consoleErrors,
    pageErrors,
    failedRequests,
    externalRequests,
    requests,
    websockets,
  };
}

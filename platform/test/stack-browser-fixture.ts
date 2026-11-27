import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser, ElementHandle, Page, Request, Response } from '@playwright/test';
import { expect } from 'vitest';
import {
  EXPAND_BUTTON,
  explorerReselect,
  FILES_GUIDE,
  rowQuery,
} from './better-sidebar-browser-fixture.mjs';

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
  /** The allowed Document Server unload reports, one `<script>:<line>` each, in arrival order. */
  readonly unloadViolations: readonly string[];
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  /** Requests and WebSockets whose origin is not the platform's public origin. */
  readonly externalRequests: readonly string[];
  readonly requests: number;
  readonly websockets: number;
}

// Chromium 158 reports this each time ONLYOFFICE 9.4.0 registers `unload` (#671). User decision
// 2026-11-23 (option A): allowed only from these measured script lines, with no count limit; the
// same text from any other source stays a console error. Lines are `location().line`, 0-based.
const UNLOAD_VIOLATION = 'Permissions policy violation: unload is not allowed in this document.';
export const DS_UNLOAD_SOURCES: ReadonlyMap<string, number> = new Map([
  ['web-apps/apps/documenteditor/main/app/controller/Main.js', 2145],
  ['web-apps/apps/spreadsheeteditor/main/app/controller/Main.js', 1785],
  ['web-apps/apps/presentationeditor/main/app/controller/Main.js', 1638],
  ['sdkjs/cell/sdk-all.js', 465226],
  ['sdkjs-plugins/v1/plugins.js', 39],
]);
// The Document Server 9.4.0 mount `9.4.0-<hash>`; the script path after it, never the hash.
const DS_SCRIPT = /^\/sidebar\/onlyoffice\/ds\/9\.4\.0-[^/]+\/(.+)$/;

/** What recordedError reads of a Playwright `ConsoleMessage`. */
interface ConsoleReport {
  readonly type: () => string;
  readonly text: () => string;
  readonly location: () => { readonly url: string; readonly line: number };
}

/**
 * How a session records one console message: nothing unless it is an error, the measured unload
 * report on `origin` by its source, any other error by its text.
 */
export function recordedError(
  message: ConsoleReport,
  origin: string,
): { readonly unload: string } | { readonly error: string } | undefined {
  if (message.type() !== 'error') return undefined;
  const text = message.text();
  if (text !== UNLOAD_VIOLATION) return { error: text };
  const { url, line } = message.location();
  // Parsed only when parseable: a listener never throws on an empty or malformed location URL.
  const target = URL.canParse(url) ? new URL(url) : undefined;
  const script = target?.origin === origin ? DS_SCRIPT.exec(target.pathname)?.[1] : undefined;
  const measured = script !== undefined && DS_UNLOAD_SOURCES.get(script) === line;
  return measured ? { unload: `${script}:${String(line)}` } : { error: text };
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
  /** Drives the page after the reply screenshot, inside the same observed session. */
  readonly after?: (page: Page, shoot: (name: string) => Promise<void>) => Promise<void>;
}

/** What a session names in its messages and screenshots. */
export interface StackSessionNames {
  /** Used in failure messages: `Stack workbench <label> failed`. */
  readonly label: string;
  /** Taken on the login page before any field holds a credential; omitted when absent. */
  readonly login?: string;
  /** Best-effort screenshot of a failed session. */
  readonly failure: string;
  /** Texts whose element every screenshot of the session masks, the failure's included. */
  readonly masked?: readonly string[];
}

export type Secrets = readonly (string | undefined)[];

/** Replaces each non-empty secret with a marker so no key or token survives in an error. */
export function redactSecrets(message: string, secrets: Secrets): string {
  let output = message;
  for (const secret of secrets)
    if (secret !== undefined && secret !== '') output = output.replaceAll(secret, '<redacted>');
  return output;
}

// A document key: a sha256 hex digest (dsh-sidebar-onlyoffice `onlyoffice.ts:37`).
const DOCUMENT_KEY = /[0-9a-f]{64}/g;
// A URL's query or hash: after a scheme's or a path's `/`, up to whitespace, a quote or a JSON
// delimiter, so free-text `#` (`BODY#`, `locator('#editor_sdk')`) and JSON structure survive.
const URL_QUERY = /(\/[^\s"'`,{}[\]?#]*)[?#][^\s"'`,{}[\]]*/g;
// Any 20-character word run is a key, token or nonce, but a lowercase word or a Chromium `ERR_*`.
const LONG_RUN = /[\w-]{20,}/g;
const READABLE_RUN = /^(?:[a-z_-]+|[A-Z]+(?:_[A-Z]+)+)$/;

/** `text` without `secrets`, document keys, URL queries and hashes, or long non-word runs. */
export const scrub = (text: string, secrets: Secrets = []) =>
  redactSecrets(text, secrets)
    .replace(DOCUMENT_KEY, '<redacted>')
    .replace(URL_QUERY, '$1')
    .replace(LONG_RUN, (run) => (READABLE_RUN.test(run) ? run : '<redacted>'));

/** Everything vitest prints of `error`: the JSON of each own property, enumerable or not, the
 * inspected whole with hidden properties, and so on for each error an AggregateError holds. */
export function everythingPrinted(error: unknown): string {
  if (!(error instanceof Error)) return inspect(error, { showHidden: true, depth: 20 });
  const names = Object.getOwnPropertyNames(error);
  const own = JSON.stringify(
    Object.fromEntries(names.map((name) => [name, Reflect.get(error, name)])),
  );
  // AggregateError types its entries as any; each is printed whatever it is.
  const entries = error instanceof AggregateError ? (error.errors as unknown[]) : [];
  const inspected = inspect(error, { showHidden: true, depth: 20 });
  return [own, inspected, ...entries.map(everythingPrinted)].join('\n');
}

/** Fails, labelled, when `value`'s JSON contains `secret`; the failure never prints the secret. */
export function expectFreeOf(value: unknown, secret: string, label: string) {
  expect(JSON.stringify(value).includes(secret), label).toBe(false);
}

export const scrubEach = (texts: readonly string[]) => texts.map((text) => scrub(text));

/** `evidence` with every element of its lists scrubbed, in new arrays; the counts stay. */
export const scrubbedEvidence = (evidence: StackBrowserEvidence): StackBrowserEvidence => ({
  ...evidence,
  screenshots: scrubEach(evidence.screenshots),
  consoleErrors: scrubEach(evidence.consoleErrors),
  unloadViolations: scrubEach(evidence.unloadViolations),
  pageErrors: scrubEach(evidence.pageErrors),
  failedRequests: scrubEach(evidence.failedRequests),
  externalRequests: scrubEach(evidence.externalRequests),
});

/** A thrown value that is no Error: its JSON, else a fixed text; never undefined, never throws. */
function rendered(value: unknown) {
  try {
    // Typed string, yet undefined for undefined, a function or a symbol, which have no JSON text.
    return (JSON.stringify(value) as string | undefined) ?? 'unknown failure';
  } catch {
    // Swallows what JSON cannot render: a circular value, a BigInt, a throwing toJSON or getter.
    return 'unknown failure';
  }
}

/** One reason: an Error's scrubbed message, an AggregateError's followed by its members' chains
 * in brackets, but those its message already names and any aggregate already expanded. */
function reason(value: unknown, secrets: Secrets, expanded: Set<unknown>): string {
  if (!(value instanceof Error)) return scrub(rendered(value), secrets);
  const message = scrub(value.message, secrets);
  if (!(value instanceof AggregateError) || expanded.has(value)) return message;
  expanded.add(value);
  // AggregateError types its members as any; each is rendered whatever it is.
  const members = (value.errors as unknown[])
    .map((member) => chain(member, secrets, expanded))
    .filter((member) => !message.includes(member));
  return members.length === 0 ? message : `${message} [${members.join('; ')}]`;
}

function chain(cause: unknown, secrets: Secrets, expanded: Set<unknown>) {
  const reasons: string[] = [];
  let current = cause;
  do {
    reasons.push(reason(current, secrets, expanded));
    current = current instanceof Error ? current.cause : undefined;
  } while (current !== undefined && reasons.length < 8);
  return reasons.join(' <- ');
}

/** The reasons of `cause` and its causes, each scrubbed of `secrets`, at most eight per branch;
 * an aggregate's members are branches of their own. */
export const scrubbedChain = (cause: unknown, secrets: Secrets = []) =>
  chain(cause, secrets, new Set());

/** A failed session, safe to print: vitest prints the cause chain and every own property, so the
 * scrubbed chain is folded into the message, no `cause` is kept and `evidence` is scrubbed. */
export class StackWorkbenchFailure extends Error {
  readonly evidence: StackBrowserEvidence;

  constructor(cause: unknown, evidence: StackBrowserEvidence, label = 'conversation') {
    const counts = (['consoleErrors', 'pageErrors', 'failedRequests', 'externalRequests'] as const)
      .map((key) => `${key}=${String(evidence[key].length)}`)
      .join(' ');
    super(`Stack workbench ${label} failed (${counts}): ${scrubbedChain(cause)}`);
    this.name = 'StackWorkbenchFailure';
    this.evidence = scrubbedEvidence(evidence);
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

// Latches the first sighting of STOP in the page, however briefly it shows. The flag is only
// ever set, so a second install has no further effect. The root config has no DOM lib.
const STOP_LATCH = `(() => {
  const selector = ${JSON.stringify(STOP)};
  const check = () => {
    if (document.querySelector(selector) !== null) window.__dshTeamStopSeen = true;
  };
  check();
  new MutationObserver(check).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
  });
})()`;

/** What an in-page expression yields: the typings, without the DOM lib, never admit null. */
export const element = async (page: Page, expression: string): Promise<ElementHandle | null> =>
  (await page.evaluateHandle(expression)).asElement();

/**
 * One step toward every named file-area row visible: expand the Sidebar, take the files guide or
 * reselect the explorer tab covered by an opened file (found by `names[0]`).
 */
export async function showSidebarRows(page: Page, names: readonly string[]): Promise<boolean> {
  const shown = names.map((name) => `Boolean(${rowQuery(name)})`).join(' && ');
  if (await page.evaluate<boolean>(shown)) return true;
  for (const expression of [EXPAND_BUTTON, FILES_GUIDE, explorerReselect(names[0] ?? '')]) {
    const target = await element(page, expression);
    if (target !== null) return target.click().then(() => false);
  }
  return false;
}

// The released dsh-client-locale@0.2.1-rc.2 sets `<html lang>` whenever it applies a locale
// (lib/client.js:1172-1175, zh as zh-CN); plugins/zh-locale selects zh. The root config has no DOM lib.
const chinese = (page: Page) => async () =>
  (await page.evaluate<string>('document.documentElement.lang')).startsWith('zh');

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
  const unloadViolations: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  let requests = 0;
  let websockets = 0;
  let observing = true;
  const open = new Set<Request>();
  const cancelled = new Set<Request>();
  // A `blob:` URL has no host of its own; its origin is the document that created it (the PDF
  // and spreadsheet Workers). `ws:` never equals `http:`, so the http and ws checks are unchanged.
  const foreign = (url: string, scheme: 'http:' | 'ws:') => {
    const target = new URL(url);
    const own =
      target.protocol === 'blob:'
        ? target.origin === platform.origin
        : target.protocol === scheme && target.host === platform.host;
    if (!own) externalRequests.push(url);
  };
  const evidence = (): StackBrowserEvidence => ({
    screenshots,
    consoleErrors,
    unloadViolations,
    pageErrors,
    failedRequests,
    externalRequests,
    requests,
    websockets,
  });
  await mkdir(directory, { recursive: true });
  const browser = await launch();
  let failed: { readonly error: unknown } | undefined;
  // Set while a masked session's page may show the notice unmasked: no failure screenshot then.
  let unmaskable = false;
  let page: Page | undefined;
  const shoot = async (name: string) => {
    if (page === undefined) throw new Error('Stack workbench page not open');
    const shown = page;
    const masked = names.masked?.map((text) => shown.getByText(text));
    const options = { path: join(directory, `${name}.png`), fullPage: true };
    await shown.screenshot(masked === undefined ? options : { ...options, mask: masked });
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
      const recorded = observing ? recordedError(message, platform.origin) : undefined;
      if (recorded === undefined) return;
      if ('unload' in recorded) unloadViolations.push(recorded.unload);
      else consoleErrors.push(recorded.error);
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
    if (names.masked !== undefined) {
      unmaskable = true;
      await until(chinese(workbench), timeout, 'Chinese UI');
      unmaskable = false;
    }
    await body(workbench, shoot, async () => {
      for (const request of open) cancelled.add(request);
      await workbench.reload({ waitUntil: 'load', timeout });
      await ready();
    });
  } catch (error) {
    // Best effort: a failed screenshot must not replace the session's own failure.
    if (!unmaskable) await shoot(names.failure).catch(() => undefined);
    failed = { error };
  }
  // Teardown aborts are not part of the observed session.
  observing = false;
  const closing = await browser.close().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  // vitest prints every raw member of an error: the close reason is folded in after the session's.
  if (failed !== undefined) {
    const cause =
      closing === undefined
        ? failed.error
        : new AggregateError([failed.error, closing.error], 'session and browser close failed');
    throw new StackWorkbenchFailure(cause, evidence(), names.label);
  }
  if (closing !== undefined)
    throw new Error(
      `Stack workbench ${names.label} browser close failed: ${scrubbedChain(closing.error)}`,
    );
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
      // A turn-end state before the turn ever started proves nothing: latch STOP first. A short
      // turn can show STOP only between two of Playwright's re-query back-off samples, so an
      // in-page observer, installed before the click, records any sighting of STOP.
      await page.evaluate(STOP_LATCH);
      await page.locator(SEND).first().click();
      await page.waitForFunction('window.__dshTeamStopSeen === true', undefined, { timeout });
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
      await conversation.after?.(page, shoot);
    },
    launch,
  );
}

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import { rowQuery } from './better-sidebar-browser-fixture.mjs';
import { counted, retiringOnError } from './office-editor-stack-fixture.ts';
import {
  documentServerReady,
  docxCommand,
  editorSettled,
  FAILURES,
  officeFacts,
  untilSeen,
} from './office-hints-stack-fixture.ts';
import type { OfficeFacts } from './office-hints-stack-fixture.ts';
import { request } from './office-idle-stack-fixture.ts';
import type { Admin } from './office-idle-stack-fixture.ts';
import { NODE, script } from './office-isolation-stack-fixture.ts';
import { LISTENER_JS, REWRITTEN_URL } from './office-profile-stack-fixture.ts';
import { providerCounts, withWorkFiles } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import {
  composerState,
  element,
  showSidebarRows,
  until,
  workbenchSession,
} from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

const PATH = '/_platform/api/admin/document-server';
const NAME = '外部失效.docx';
const PARAGRAPH = '外部 Document Server 失效探针：只打开，不编辑。';
const API_JS = '/sidebar/onlyoffice/ds/web-apps/apps/api/documents/api.js';
const SCREENSHOT = 'office-external-failed';
// dsh-sidebar-onlyoffice@0.2.0 loadApiScript's 20s timeout (src/client/OnlyOfficeView.tsx:62-65)
// plus 10s for the tab, the config fetch and the panel's render; a refused upstream fails at once.
const FAILURE_MS = 30_000;
/**
 * Chromium's console text for the proxied api.js answered 502: the gateway forwards the status
 * with Node's default reason (platform/src/gateway/http.ts `writeHead`), as office-editor's 404
 * `NOT_FOUND`. Read from that source, not yet observed in the stack.
 */
export const BAD_GATEWAY =
  'Failed to load resource: the server responded with a status of 502 (Bad Gateway)';
/** The administrator's view of Office bundled with the delivered Document Server configured. */
const BUNDLED = { mode: 'bundled', bundledConfigured: true, url: '', jwtConfigured: false };
// FAILURES opens with these keys' zh texts, in dsh-sidebar-onlyoffice@0.2.0 locales.ts order.
const KEYS = ['loadFailed', 'errFetch', 'errApi', 'errEditor', 'errEditorEvent'];

/** Each shown ONLYOFFICE text by its zh key; loading, English and office-hints texts as themselves. */
export const failureKeys = (texts: readonly string[]) =>
  texts.map((text) => KEYS[FAILURES.indexOf(text)] ?? text);

/**
 * The refused upstream's only trace allowed in the session: exactly Chromium's one 502 console
 * error and exactly one `status URL` response >= 400, the 502 of api.js on `base`'s origin.
 */
export const badGatewayPaired = (
  errors: readonly string[],
  responses: readonly string[],
  base: string,
) =>
  isDeepStrictEqual([errors, responses], [[BAD_GATEWAY], [`502 ${new URL(base).origin}${API_JS}`]]);

/** A's archive lane plus the administrator and the restart of A, awaited until it runs. */
export type OfficeExternalLane = ArchiveLane & {
  readonly administrator: Admin;
  readonly restart: () => Promise<void>;
};

/** The failure panel's keys, the visible hint kinds above it and the time from the click. */
interface Failure {
  readonly keys: readonly string[];
  readonly hints: readonly string[];
  readonly failureMs: number;
}

/** The browser half: the session, its `status URL` responses >= 400 (no query) and the failure. */
export interface ExternalOpen {
  readonly browser: StackBrowserEvidence;
  readonly responses: readonly string[];
  readonly failure: Failure;
}

/** No JWT: the failure, the file, the session, its paired 502 and the confirmed restore. */
export interface OfficeExternalEvidence extends Failure {
  readonly file: ArchiveEntry;
  readonly browser: StackBrowserEvidence;
  readonly consoleErrors: readonly string[];
  readonly responses: readonly string[];
  readonly restored: { readonly config: 'bundled'; readonly healthcheck: true };
}

/** The stack evidence line: the session by its screenshots and error counts. */
export function officeExternalLine(evidence: OfficeExternalEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office external evidence missing');
  const { browser, ...rest } = evidence;
  return { ...rest, browser: counted(browser) };
}

/** Only the projection's fields, so nothing else the platform answers reaches a diff. */
const projected = ({ mode, bundledConfigured, url, jwtConfigured }: Record<string, unknown>) => ({
  mode,
  bundledConfigured,
  url,
  jwtConfigured,
});
const configuration = (admin: Admin, body?: object) =>
  request<Record<string, unknown>>(admin, body === undefined ? 'GET' : 'PUT', PATH, body).then(
    projected,
  );

/**
 * Opens the file from the landing session's file area and waits, at most the plugin's timeout and
 * a margin, for the editor to settle; then checks the failure panel, the composer and the row.
 */
async function openFailing(page: Page, shoot: (name: string) => Promise<void>, timeout: number) {
  await until(() => showSidebarRows(page, [NAME]), timeout, 'office external row');
  const row = await element(page, rowQuery(NAME));
  if (row === null) throw new Error('Office external row missing');
  let facts: OfficeFacts | undefined;
  const settled = async () => {
    facts = await page.evaluate<OfficeFacts>(officeFacts(NAME));
    return editorSettled(facts);
  };
  const start = performance.now();
  await row.click();
  await untilSeen(() => facts, settled, FAILURE_MS, 'ONLYOFFICE never settled, last seen');
  const failureMs = Math.round(performance.now() - start);
  const final = await page.evaluate<OfficeFacts>(officeFacts(NAME));
  await shoot(SCREENSHOT);
  const keys = failureKeys(final.texts);
  expect(keys, `ONLYOFFICE texts, seen ${JSON.stringify(final)}`).toEqual(['loadFailed', 'errApi']);
  const ready = async () => (await composerState(page)) === 'ready';
  await until(ready, timeout, 'office external composer after the failure');
  await until(
    () => showSidebarRows(page, [NAME]),
    timeout,
    'office external row after the failure',
  );
  const hints = final.hints.filter(({ visible }) => visible).map(({ kind }) => String(kind));
  return { keys, hints, failureMs };
}

/** One employee session that opens the file and fails; `onResponse` keeps every status >= 400. */
async function openInBrowser(session: StackSession): Promise<ExternalOpen> {
  const responses: string[] = [];
  // The query and hash may carry keys.
  const record = (response: Response) => {
    const { origin, pathname } = new URL(response.url());
    const status = response.status();
    if (status >= 400) responses.push(`${String(status)} ${origin}${pathname}`);
  };
  let failure: Failure | undefined;
  const names = { label: 'office external', failure: 'office-external-failure' };
  const browser = await workbenchSession(
    session,
    names,
    async (page, shoot) => {
      failure = await openFailing(page, shoot, session.timeout);
    },
    undefined,
    record,
  );
  if (failure === undefined) throw new Error('Office external failure not observed');
  return { browser, responses, failure };
}

/** In external mode: nothing listens at the address, the file opens to the failure, unchanged. */
async function failedOpen(lane: OfficeExternalLane, open: typeof openInBrowser) {
  const { exec, session } = lane;
  const listener: unknown = JSON.parse(await exec([...NODE, script(LISTENER_JS)]));
  expect(listener, `Nothing listens at ${REWRITTEN_URL} in A`).toEqual({ listener: false });
  const before = await providerCounts(lane);
  // The instance's own size and digest of the file it has just written.
  const file = JSON.parse(await exec(docxCommand(NAME, PARAGRAPH))) as ArchiveEntry;
  expect(file.name).toBe(NAME);
  const { browser, responses, failure } = await open(session);
  const after: unknown = JSON.parse(await exec(docxCommand(NAME)));
  expect(after, 'Office external file unchanged by opening it').toEqual(file);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  const { consoleErrors } = browser;
  const seen = `consoleErrors, responses ${JSON.stringify([consoleErrors, responses])}`;
  expect(badGatewayPaired(consoleErrors, responses, session.base), seen).toBe(true);
  expect(browser, seen).toMatchObject({
    screenshots: [`${SCREENSHOT}.png`],
    ...{ pageErrors: [], failedRequests: [], externalRequests: [] },
  });
  return { ...failure, file, browser, consoleErrors, responses };
}

/** The refused address and a random JWT, which leaves only in this PUT's body; then A restarts. */
async function external(lane: OfficeExternalLane) {
  const jwtSecret = randomBytes(32).toString('hex');
  const body = { mode: 'external', url: REWRITTEN_URL, jwtSecret };
  const saved = { ...BUNDLED, mode: 'external', url: REWRITTEN_URL, jwtConfigured: true };
  expect(await configuration(lane.administrator, body), 'External Office saved').toEqual(saved);
  await lane.restart();
}

/** Bundled saved and read back, A restarted and its proxy reaching the bundled server again. */
async function bundled(lane: OfficeExternalLane) {
  const { administrator: admin } = lane;
  expect(await configuration(admin, { mode: 'bundled' }), 'Bundled Office saved').toEqual(BUNDLED);
  expect(await configuration(admin), 'Bundled Office read back').toEqual(BUNDLED);
  await lane.restart();
  await documentServerReady(lane);
  return { config: 'bundled', healthcheck: true } as const;
}

/**
 * #649: from bundled Office, the administrator saves the external Document Server at the refused
 * REWRITTEN_URL and restarts A; a DOCX opened from the file area shows the plugin's 「打开失败」
 * with 「无法加载 ONLYOFFICE 编辑器脚本」, is unchanged, and the composer and the row stay usable.
 * Bundled mode is restored either way and proven reachable; a restore failure follows the lane's.
 */
export async function officeExternalScenario(
  lane: OfficeExternalLane,
  open = openInBrowser,
): Promise<OfficeExternalEvidence> {
  const start = await configuration(lane.administrator);
  expect(start, 'Office starts bundled with the delivered Document Server').toEqual(BUNDLED);
  const run = async () => {
    await external(lane);
    return withWorkFiles(lane, [NAME], 'Office external', () => failedOpen(lane, open));
  };
  const failed = 'Office external lane and its bundled restore failed';
  const evidence = await retiringOnError(run, () => bundled(lane).then(() => undefined), failed);
  return { ...evidence, restored: await bundled(lane) };
}

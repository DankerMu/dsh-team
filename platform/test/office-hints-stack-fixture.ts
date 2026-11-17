import { extname } from 'node:path';
import type { ConsoleMessage, Page } from '@playwright/test';
import { expect } from 'vitest';
import { previewIds, rowQuery, visible } from './better-sidebar-browser-fixture.mjs';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { element, showSidebarRows, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

/** The delivered Document Server container (deploy/compose.yml). */
export const DOCUMENT_SERVER = 'dsh-team-documentserver';
const NAME = '同写提示.docx';
const PARAGRAPH = '同写提示探针：只打开，不编辑。';
/** Baseline F40, verbatim: plugins/office-hints/client.js `COLLAB`. */
export const COLLAB = '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。';
const MOUNT = '/sidebar/onlyoffice/ds/';
// dsh-sidebar-onlyoffice@0.2.0 src/client/locales.ts, zh then en: `loading`; then `loadFailed`,
// `errFetch`, `errApi`, `errEditor`, `errEditorEvent`; last office-hints' own `UNAVAILABLE`.
const LOADING = ['正在打开 ONLYOFFICE …', 'Opening in ONLYOFFICE …'];
const FAILURES = [
  ...['打开失败', '无法获取编辑器配置', '无法加载 ONLYOFFICE 编辑器脚本'],
  ...['ONLYOFFICE 编辑器初始化失败', 'ONLYOFFICE 编辑器发生错误', 'Failed to open'],
  ...['Could not fetch the editor config', 'Could not load the ONLYOFFICE editor script'],
  ...['The ONLYOFFICE editor failed to initialize', 'The ONLYOFFICE editor reported an error'],
  'Office 编辑器未加载',
];

// Python in the instance as uid 1001 with python-docx from the image; every value arrives as argv.
// With a paragraph it writes the one-paragraph document first; it always reads the file back.
// With `--base64 <data>` it writes those bytes instead.
const DOCX = `import base64, hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if sys.argv[2:3] == ["--base64"]:
    path.write_bytes(base64.b64decode(sys.argv[3]))
elif len(sys.argv) > 2:
    from docx import Document
    document = Document()
    document.add_paragraph(sys.argv[2])
    document.save(path)
data = path.read_bytes()
print(json.dumps({"name": path.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))`;
export const docxCommand = (name: string, ...content: string[]) => [
  ...['python3', '-c', DOCX, `${WORK}/${name}`],
  ...content,
];

// DSH Web answers only at the instance's own bridge address, never at its loopback
// (platform/src/managed-config/README.md); the Host is the loopback the plugin's trust fence admits.
const HEALTH = `import http.client, json, socket
try:
    c = http.client.HTTPConnection(socket.gethostbyname(socket.gethostname()), 3080, timeout=5)
    c.request("GET", "/sidebar/onlyoffice/ds/healthcheck", headers={"Host": "127.0.0.1:3080"})
    r = c.getresponse()
    print(json.dumps({"status": r.status, "body": r.read(200).decode("utf-8", "replace").strip()}))
except Exception as e:
    print(json.dumps({"status": 0, "body": type(e).__name__}))`;
export const HEALTH_COMMAND = ['python3', '-c', HEALTH];

type Hint = Record<'kind' | 'text', string | null> & Record<'visible' | 'nativeHost', boolean>;
/** What the page shows of the hints and the wrapped editor; iframe paths carry no query. */
interface OfficeFacts {
  readonly hints: readonly Hint[];
  readonly frames: number;
  readonly iframes: readonly { visible: boolean; sameOrigin: boolean; path: string }[];
  readonly texts: readonly string[];
}

/** The office-hints wrapper around the editor of `name`, by its extension. */
export const hintsFrame = (name: string) =>
  `[data-dsh-team-office-hints="${extname(name).slice(1)}"]`;
export const officeFacts = (name: string) => `(() => {
  const visible = ${visible};
  const frames = [...document.querySelectorAll('${hintsFrame(name)}')];
  const text = document.body.innerText;
  return {
    hints: [...document.querySelectorAll('[data-dsh-team-office-hint]')].map((el) => ({ kind: el.getAttribute('data-dsh-team-office-hint'), text: el.textContent, visible: visible(el), nativeHost: el.closest('[data-dsh-native-tab-host]') !== null })),
    frames: frames.length,
    iframes: frames.flatMap((frame) => [...frame.querySelectorAll('iframe')]).map((el) => { const url = new URL(el.getAttribute('src') ?? '', location.href); return { visible: visible(el), sameOrigin: url.origin === location.origin, path: url.pathname }; }),
    texts: ${JSON.stringify([...LOADING, ...FAILURES])}.filter((needle) => text.includes(needle)),
  };
})()`;

/**
 * Settled once the visible collaboration hint sits over a visible Document Server proxy iframe
 * with no loading text, or as soon as a failure text or the no-Session hint shows.
 */
export const editorSettled = ({ hints, iframes, texts }: OfficeFacts) =>
  hints.some(({ kind }) => kind === 'no-session') ||
  texts.some((text) => !LOADING.includes(text)) ||
  (texts.length === 0 &&
    hints.some((hint) => hint.kind === 'collab' && hint.visible) &&
    iframes.some((frame) => frame.visible && frame.path.startsWith(MOUNT)));

// Document Server 9.4 registers a caching ServiceWorker; the gateway refuses every request with a
// `Service-Worker` header (platform/src/gateway/README.md:9). User decision 2026-11-14 (§48.1).
const SW_FETCH = 'A bad HTTP response code (403) was received when fetching the script.';

/**
 * Exactly Chromium's two console errors for that refusal, in order, on `base`'s origin: scope and
 * script share one non-empty Document Server version segment without `/`.
 */
export function serviceWorkerRefused(errors: readonly string[], base: string): boolean {
  const mount = `${new URL(base).origin}${MOUNT}`;
  const lead = `Registration failed with TypeError: Failed to register a ServiceWorker for scope ('${mount}`;
  const [first, registration = '', ...rest] = errors;
  const tail = registration.startsWith(lead) ? registration.slice(lead.length) : '';
  const segment = tail.split('/')[0] ?? '';
  const scope = `${mount}${segment}/`;
  const expected = `${lead}${segment}/') with script ('${scope}document_editor_service_worker.js'): ${SW_FETCH}`;
  return rest.length === 0 && first === SW_FETCH && segment !== '' && registration === expected;
}

export interface OfficeHintsEvidence {
  readonly browser: StackBrowserEvidence;
  readonly file: ArchiveEntry;
  readonly hint: string;
}

/** The stack evidence line: the file, the hint text and the screenshot names. */
export function officeHintsLine(evidence: OfficeHintsEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office hints evidence missing');
  const { browser, file, hint } = evidence;
  return { ...file, hint, screenshots: browser.screenshots };
}

/** `until`, failing with `message` and the last observation `seen()`, the wait's error as cause. */
export const untilSeen = (
  seen: () => unknown,
  ...[check, timeout, message]: Parameters<typeof until>
) =>
  until(check, timeout, message).catch((cause: unknown) => {
    throw new Error(`${message} ${JSON.stringify(seen())}`, { cause });
  });

type Shoot = (name: string) => Promise<void>;

/**
 * Opens the file from the landing session's file area, waits for the hinted editor and then for
 * the ServiceWorker refusal, which ONLYOFFICE logs after its `ready` phase, and checks the page.
 */
export async function openHinted(
  page: Page,
  shoot: Shoot,
  { base, timeout }: StackSession,
  name: string,
  screenshot: string,
  refusal = serviceWorkerRefused,
) {
  await until(() => showSidebarRows(page, [name]), timeout, `office hints ${name} row`);
  const row = await element(page, rowQuery(name));
  if (row === null) throw new Error(`Office hints ${name} row missing`);
  // The text workbenchSession records for an error-type console message.
  const errors: string[] = [];
  const record = (message: ConsoleMessage) =>
    message.type() === 'error' && errors.push(message.text());
  page.on('console', record);
  let facts: OfficeFacts | undefined;
  const settled = async () => {
    facts = await page.evaluate<OfficeFacts>(officeFacts(name));
    return editorSettled(facts);
  };
  const refused = () => Promise.resolve(refusal(errors, base));
  try {
    await row.click();
    await untilSeen(() => facts, settled, timeout, 'Office hints editor never settled, last seen');
    await untilSeen(() => errors, refused, timeout, 'ServiceWorker refusal not logged, collected');
  } finally {
    page.off('console', record);
  }
  const final = await page.evaluate<OfficeFacts>(officeFacts(name));
  await shoot(screenshot);
  const seen = JSON.stringify(final);
  const hint = { kind: 'collab', text: COLLAB, visible: true, nativeHost: true };
  expect(final.hints, `Office hints, seen ${seen}`).toEqual([hint]);
  expect(final.texts, 'ONLYOFFICE loading or failure text').toEqual([]);
  // [sameOrigin, on the proxy path] of every visible iframe in the wrapper.
  const shown = final.iframes.filter((frame) => frame.visible);
  const mounted = shown.map(({ sameOrigin, path }) => [sameOrigin, path.startsWith(MOUNT)]);
  expect(mounted, `Editor iframes, seen ${seen}`).toEqual([[true, true]]);
  expect(await page.evaluate<string[]>(previewIds(name)), "DSH's preview, any id").toEqual([]);
}

/** Waits for the Document Server through the instance's proxy, so a cold 502 never reaches the browser. */
export async function documentServerReady({ exec, session }: ArchiveLane) {
  let seen = { status: 0, body: 'never polled' };
  const healthy = async () => {
    seen = JSON.parse(await exec(HEALTH_COMMAND)) as typeof seen;
    if (seen.status === 403) throw new Error('Refused by the ONLYOFFICE trust fence');
    return seen.status === 200 && seen.body === 'true';
  };
  const message = 'Document Server healthcheck not true, last';
  await untilSeen(() => seen, healthy, session.timeout, message);
}

/** How many times supervisord has spawned docservice since the Document Server started. */
export async function docserviceSpawns(run: DockerOutput): Promise<number> {
  const grep = ['grep', '-c', "spawned: 'docservice'", '/var/log/supervisor/supervisord.log'];
  const count = (await run(['exec', DOCUMENT_SERVER, ...grep])).trim();
  if (!/^\d+$/.test(count)) throw new Error(`docservice spawn count unreadable: ${count}`);
  return Number(count);
}

/**
 * Waits for run-document-server.sh's last step, `xargs tail -F`, which starts only after
 * documentserver-generate-allfonts.sh has restarted docservice and converter (#622). Returns the
 * time since the container started and the docservice spawns so far.
 */
export async function documentServerStarted(run: DockerOutput, timeout: number) {
  let seen = 'never polled';
  // `until` does not catch: pgrep without a match exits 1, which `run` throws as not yet.
  const started = async () => {
    try {
      await run(['exec', DOCUMENT_SERVER, 'pgrep', '-f', 'xargs tail -F']);
      return true;
    } catch (error) {
      seen = error instanceof Error ? error.message : String(error);
      return false;
    }
  };
  const message = 'Document Server startup script not finished, last';
  await untilSeen(() => seen, started, timeout, message);
  // RFC 3339 with nine fractional digits; Date.parse keeps the milliseconds.
  const startedAt = (await run(['inspect', '-f', '{{.State.StartedAt}}', DOCUMENT_SERVER])).trim();
  const since = Date.parse(startedAt);
  if (Number.isNaN(since))
    throw new Error(`Document Server StartedAt unreadable: ${JSON.stringify(startedAt)}`);
  return { startupMs: Date.now() - since, spawns: await docserviceSpawns(run) };
}

/** The write, the browser session and every check of the lane; cleanup is the caller's. */
async function officeHints(lane: ArchiveLane): Promise<OfficeHintsEvidence> {
  const { exec, session } = lane;
  const before = await providerCounts(lane);
  // The instance's own size and digest of the file it has just written.
  const file = JSON.parse(await exec(docxCommand(NAME, PARAGRAPH))) as ArchiveEntry;
  expect(file.name).toBe(NAME);
  expect(file.size).toBeGreaterThan(0);
  await documentServerReady(lane);
  const names = { label: 'office hints', failure: 'office-hints-failure' };
  const browser = await workbenchSession(session, names, (page, shoot) =>
    openHinted(page, shoot, session, NAME, 'office-hints-collab'),
  );
  // Opened, never edited: the Document Server closes with status 4 and writes nothing back.
  const after: unknown = JSON.parse(await exec(docxCommand(NAME)));
  expect(after, 'Office hints file unchanged by opening it').toEqual(file);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  // The editor iframe's own requests and console output count too.
  const { consoleErrors } = browser;
  const refusal = serviceWorkerRefused(consoleErrors, session.base);
  expect(refusal, `consoleErrors ${JSON.stringify(consoleErrors)}`).toBe(true);
  expect(browser).toMatchObject({
    screenshots: ['office-hints-collab.png'],
    pageErrors: [],
    failedRequests: [],
    externalRequests: [],
  });
  // openHinted asserted the shown hint verbatim.
  return { browser, file, hint: COLLAB };
}

/**
 * The collaboration hint over the ONLYOFFICE editor (#439, 18.4): 同写提示.docx opened from the
 * landing session's file area shows F40's hint inside better-sidebar's tab, above a mounted
 * Document Server proxy iframe, and leaves the instance's bytes unchanged; the file is then removed.
 */
export const officeHintsScenario = (lane: ArchiveLane): Promise<OfficeHintsEvidence> =>
  withWorkFiles(lane, [NAME], 'Office hints', () => officeHints(lane));

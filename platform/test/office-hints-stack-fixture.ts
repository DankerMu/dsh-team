import type { Page } from '@playwright/test';
import { expect } from 'vitest';
import { previewOutcome, rowQuery, visible } from './better-sidebar-browser-fixture.mjs';
import type { PreviewOutcome } from './better-sidebar-browser-fixture.mjs';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { element, showSidebarRows, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const NAME = '同写提示.docx';
const PARAGRAPH = '同写提示探针：只打开，不编辑。';
/** Baseline F40, verbatim: plugins/office-hints/client.js `COLLAB`. */
export const COLLAB = '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。';
const OFFICE_PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office';
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
const DOCX = `import hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if len(sys.argv) > 2:
    from docx import Document
    document = Document()
    document.add_paragraph(sys.argv[2])
    document.save(path)
data = path.read_bytes()
print(json.dumps({"name": path.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))`;
export const docxCommand = (paragraph?: string) => [
  ...['python3', '-c', DOCX, `${WORK}/${NAME}`],
  ...(paragraph === undefined ? [] : [paragraph]),
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

/** What the page shows of the hints and the wrapped editor; iframe paths carry no query. */
interface OfficeFacts {
  readonly hints: readonly {
    kind: string | null;
    text: string | null;
    visible: boolean;
    nativeHost: boolean;
  }[];
  readonly frames: number;
  readonly iframes: readonly { visible: boolean; sameOrigin: boolean; path: string }[];
  readonly texts: readonly string[];
}

export const OFFICE_FACTS = `(() => {
  const visible = ${visible};
  const frames = [...document.querySelectorAll('[data-dsh-team-office-hints="docx"]')];
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

/** Opens the file from the landing session's file area and checks the hinted editor mounted. */
async function openHinted(page: Page, shoot: (name: string) => Promise<void>, timeout: number) {
  await until(() => showSidebarRows(page, [NAME]), timeout, `office hints ${NAME} row`);
  const row = await element(page, rowQuery(NAME));
  if (row === null) throw new Error(`Office hints ${NAME} row missing`);
  await row.click();
  let facts: OfficeFacts | undefined;
  const settled = async () => {
    facts = await page.evaluate<OfficeFacts>(OFFICE_FACTS);
    return editorSettled(facts);
  };
  await until(settled, timeout, 'office hints editor').catch((error: unknown) => {
    throw new Error(`Office hints editor never settled, last seen ${JSON.stringify(facts)}`, {
      cause: error,
    });
  });
  if (facts === undefined) throw new Error('Office hints page never read');
  const native = await page.evaluate<PreviewOutcome>(previewOutcome(OFFICE_PREVIEW, NAME));
  await shoot('office-hints-collab');
  const seen = JSON.stringify(facts);
  const hint = { kind: 'collab', text: COLLAB, visible: true, nativeHost: true };
  expect(facts.hints, `Office hints, seen ${seen}`).toEqual([hint]);
  expect(facts.texts, 'ONLYOFFICE loading or failure text').toEqual([]);
  const shown = facts.iframes.filter((frame) => frame.visible);
  const mounted = shown.map(({ sameOrigin, path }) => ({
    sameOrigin,
    proxy: path.startsWith(MOUNT),
  }));
  expect(mounted, `Editor iframes, seen ${seen}`).toEqual([{ sameOrigin: true, proxy: true }]);
  expect(native.state, "DSH's own Office preview").toBeNull();
  return COLLAB;
}

/** Waits for the Document Server through the instance's proxy, so a cold 502 never reaches the browser. */
async function documentServerReady({ exec, session }: ArchiveLane) {
  let seen: unknown = 'never polled';
  const healthy = async () => {
    const health = JSON.parse(await exec(HEALTH_COMMAND)) as { status: number; body: string };
    seen = health;
    if (health.status === 403) throw new Error('Refused by the ONLYOFFICE trust fence');
    return health.status === 200 && health.body === 'true';
  };
  await until(healthy, session.timeout, 'Document Server healthcheck').catch((error: unknown) => {
    throw new Error(`Document Server healthcheck not true, last ${JSON.stringify(seen)}`, {
      cause: error,
    });
  });
}

/** The write, the browser session and every check of the lane; cleanup is the caller's. */
async function officeHints(lane: ArchiveLane): Promise<OfficeHintsEvidence> {
  const { exec, session } = lane;
  const before = await providerCounts(lane);
  // The instance's own size and digest of the file it has just written.
  const file = JSON.parse(await exec(docxCommand(PARAGRAPH))) as ArchiveEntry;
  expect(file.name).toBe(NAME);
  expect(file.size).toBeGreaterThan(0);
  await documentServerReady(lane);
  let hint: string | undefined;
  const names = { label: 'office hints', failure: 'office-hints-failure' };
  const browser = await workbenchSession(session, names, async (page, shoot) => {
    hint = await openHinted(page, shoot, session.timeout);
  });
  // Opened, never edited: the Document Server closes with status 4 and writes nothing back.
  const after: unknown = JSON.parse(await exec(docxCommand()));
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
  if (hint === undefined) throw new Error('Office hints hint missing');
  return { browser, file, hint };
}

/**
 * The collaboration hint over the ONLYOFFICE editor (#439, 18.4): 同写提示.docx opened from the
 * landing session's file area shows F40's hint inside better-sidebar's tab, above a mounted
 * Document Server proxy iframe, and leaves the instance's bytes unchanged; the file is then removed.
 */
export const officeHintsScenario = (lane: ArchiveLane): Promise<OfficeHintsEvidence> =>
  withWorkFiles(lane, [NAME], 'Office hints', () => officeHints(lane));

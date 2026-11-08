import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeMapped,
  mappedFlags,
  navigateReady,
  openMappedPage,
} from '../../scripts/probe-mapped-host.mjs';
import {
  captureSettledScreenshot,
  errorCode,
  waitComposer,
  waitFor,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { connectPage } from '../../scripts/probe-dsh-api-cdp.mjs';
import { retainPageRequestFailure } from '../../scripts/probe-browser-evidence.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { evaluate, physicalClick } from '../../scripts/probe-permission-ui.mjs';

const MS = 30_000;
// The product's own conversion timeout is 60s (dsh-office-to-pdf lib/index.js); the first WASM
// LibreOffice conversion of an instance also loads the ~150 MB engine, and the PDF must then render.
export const CONVERSION_MS = 240_000;

/*
 * Markers, all from the released packages (dsh-better-sidebar@0.28.0, @deepseek-ai/dsh@0.2.1-rc.2):
 * - right Sidebar shell (dsh-client-ui-sidebar-right lib/client.js): the expand button
 *   `data-sidebar-right-expand` (ExpandButton), the open panel `data-sidebar-right-open`
 *   (SidebarPanel), guide entries `data-sidebar-right-guide-entry="<kind>"` (EntryBox) and the tab
 *   title/body pair sharing `data-sidebar-right-tab="<tab id>"`;
 * - better-sidebar only (lib/client.js; src/client/native/tab-adapter.tsx): every native tab body
 *   it draws sits in `[data-dsh-native-tab-host]`; its explorer takes over the built-in `files`
 *   kind, file rows are `[role="button"]` titled with the entry path (src/client/FileTree.tsx
 *   FileRow); its Markdown preview container carries `data-dsh-md-surface`
 *   (src/client/use-markdown-surface.ts MARKDOWN_SURFACE_ATTR); its download pane is the
 *   `a[download]` of src/client/binary-download.tsx;
 * - DSH's own document preview (dsh-client-ui-sidebar-documentpreview lib/client.js): the
 *   container `data-document-preview="<preview id>"` with `data-textpreview-url`, the Office id
 *   below, failures `data-textpreview-failed` or a `[role="alert"]` status, the converted PDF
 *   `section[data-pdf-preview]` whose pages are `[data-pdf-page]` with a non-hidden
 *   `[data-document-zoom-surface]` canvas once rendered (client.pdf.js PdfPage), and the
 *   missing-font notice `data-office-font-warning` (FontNotice), which is not a failure.
 * Native handoff (src/client/native/index.ts HOST_OWNED_EXTS): better-sidebar refuses docx, so the
 * address falls to the built-in preview, which converts it to PDF inside the instance.
 * Tab strip (dockkit, bundled in dsh-web-frontend dist/assets/index-CN7NIWNw.js:188): `pZ` keeps
 * an inactive tab's body mounted but `hidden`/`aria-hidden`/inert, and only the active tab's pane
 * draws the strip (`ux`), whose `[role="tab"][data-dockkit-tab="<tab id>"]` carries
 * `aria-selected` and selects its tab on click; its `[data-dockkit-tab-title]` span is laid out
 * (index-BxpfOGf3.css `._tabTitle_6nhg2_389{display:flex}`), unlike the Sidebar's own title span
 * inside it (dsh-client-ui-sidebar-right lib/client.js:1289-1293 `tabTitle`, `:1143`
 * `.P3OORG_tabTitle{display:contents}`), which has no box to click.
 */
const OFFICE_PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office';
// XLS: Fortune-sheet, `allowEdit: false` (client.excel.js ExcelBody: `section[data-excel-preview]`).
const EXCEL_PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel';
const PANEL = '[data-sidebar-right-open]';

const visible = `(el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.closest('[hidden],[aria-hidden="true"]') === null; }`;

const ROW = '[data-dsh-native-tab-host] [role="button"][title]';
const titled = (name) =>
  `(el) => el.title === ${JSON.stringify(name)} || el.title.endsWith(${JSON.stringify(`/${name}`)})`;

/** The visible explorer row of one workspace file, drawn by better-sidebar wherever it docks. */
export const rowQuery = (name) =>
  `[...document.querySelectorAll(${JSON.stringify(ROW)})].find((el) => (${titled(name)})(el) && (${visible})(el))`;

/**
 * The one dock strip tab of the Sidebar tab whose body holds better-sidebar's explorer row for
 * `name`, visible or not; null unless exactly one tab body and exactly one strip tab match.
 */
const explorerStripTab = (name) => `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(ROW)})].filter(${titled(name)});
  const ids = [...new Set(rows.map((row) => row.closest('div[data-sidebar-right-tab]')?.getAttribute('data-sidebar-right-tab') ?? ''))];
  if (ids.length !== 1 || ids[0] === '') return null;
  const tabs = [...document.querySelectorAll('[role="tab"][data-dockkit-tab]')].filter((el) => el.getAttribute('data-dockkit-tab') === ids[0]);
  return tabs.length === 1 ? tabs[0] : null;
})()`;

/** The clickable title of the explorer's strip tab while another tab covers the explorer. */
export const explorerReselect = (name) =>
  `(() => { const tab = ${explorerStripTab(name)}; const title = tab?.getAttribute('aria-selected') === 'false' ? tab.querySelector('[data-dockkit-tab-title]') : null; return (${visible})(title) ? title : null; })()`;

/** The collapsed right Sidebar's visible expand button; ExpandButton renders nothing while open. */
export const EXPAND_BUTTON = `(() => { const el = document.querySelector('button[data-sidebar-right-expand]'); return (${visible})(el) ? el : null; })()`;

/** The visible guide entry of the built-in `files` kind, which better-sidebar's explorer takes over. */
export const FILES_GUIDE = `([...document.querySelectorAll('[data-sidebar-right-guide-entry="files"]')].find(${visible}) ?? null)`;

/** Compact, secret-free DOM summary of the right Sidebar for a failed wait. */
const panelSummary = `(() => {
  const panel = document.querySelector('[data-sidebar-right-panel]');
  if (!panel) return { panel: false };
  const nodes = [...panel.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('data-') && a.name !== 'data-plugin-css')).slice(0, 200);
  return {
    panel: true,
    open: panel.hasAttribute('data-sidebar-right-open'),
    nodes: nodes.map((el) => ({ tag: el.tagName.toLowerCase(), data: Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value.slice(0, 120)])), title: el.getAttribute('title')?.slice(0, 120) ?? null, text: el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 80) : null })),
  };
})()`;

export async function stage(page, evidence, label, run) {
  try {
    return await run();
  } catch (error) {
    try {
      const summary = await evaluate(page, panelSummary);
      await writeFile(
        join(evidence, `${label}-failure-dom.json`),
        JSON.stringify(summary, null, 2),
        {
          mode: 0o600,
        },
      );
      await retainPageRequestFailure(page, join(evidence, `${label}-failure.png`));
    } catch {
      /* Diagnostics must not replace the stage failure. */
    }
    throw new Error(`better-sidebar-browser-${label}`, { cause: error });
  }
}

/** Expand the right Sidebar and show better-sidebar's explorer, from the guide when it is shown. */
export async function openExplorer(page, evidence, name) {
  await stage(page, evidence, 'expand', async () => {
    const open = `Boolean(document.querySelector(${JSON.stringify(PANEL)}))`;
    const state = await waitFor(
      () => evaluate(page, `${open} ? 'open' : (${EXPAND_BUTTON}) ? 'collapsed' : null`),
      60_000,
      'sidebar-expand-or-open',
    );
    if (state === 'collapsed') await physicalClick(page, EXPAND_BUTTON);
    await waitFor(
      () => evaluate(page, `Boolean(document.querySelector(${JSON.stringify(PANEL)}))`),
      MS,
      'sidebar-open',
    );
  });
  await stage(page, evidence, 'explorer', async () => {
    const shown = await waitFor(
      () => evaluate(page, `(${rowQuery(name)}) ? 'row' : ${FILES_GUIDE} ? 'guide' : null`),
      MS,
      'sidebar-explorer-or-guide',
    );
    if (shown === 'guide') await physicalClick(page, FILES_GUIDE);
    await waitFor(
      () => evaluate(page, `Boolean(${rowQuery(name)})`),
      MS,
      'better-sidebar-explorer-row',
    );
  });
}

/**
 * Click one explorer row. Two states are recognized: the row is visible, or an opened file covers
 * the explorer and its unselected strip tab is shown; that tab is selected first and the row must
 * then be visible in a selected explorer tab. Any other state times out with the stage diagnostics.
 */
export async function openFromExplorer(page, evidence, label, name) {
  await stage(page, evidence, label, async () => {
    const shown = await waitFor(
      () =>
        evaluate(
          page,
          `(${rowQuery(name)}) ? 'row' : (${explorerReselect(name)}) ? 'reselect' : null`,
        ),
      MS,
      'better-sidebar-explorer-row-or-tab',
    );
    if (shown === 'reselect') {
      await physicalClick(page, explorerReselect(name));
      await waitFor(
        () =>
          evaluate(
            page,
            `Boolean(${rowQuery(name)}) && (${explorerStripTab(name)})?.getAttribute('aria-selected') === 'true'`,
          ),
        MS,
        'better-sidebar-explorer-reselected',
      );
    }
    await physicalClick(page, rowQuery(name));
  });
}

/** The Markdown control: better-sidebar's own renderer shows the heading, not DSH's preview. */
async function observeMarkdown(page, evidence, markdown) {
  return stage(page, evidence, 'markdown', async () => {
    const surface = `[...document.querySelectorAll('[data-dsh-md-surface]')].find((el) => (${visible})(el) && [...el.querySelectorAll('h1')].some((h) => h.textContent.includes(${JSON.stringify(markdown.heading)})))`;
    await waitFor(
      () => evaluate(page, `Boolean(${surface})`),
      MS,
      'better-sidebar-markdown-surface',
    );
    const observed = await evaluate(
      page,
      `(() => { const el = ${surface}; return { nativeHost: el.closest('[data-dsh-native-tab-host]') !== null, paragraph: el.textContent.includes(${JSON.stringify(markdown.paragraph)}), dshMarkdown: [...document.querySelectorAll('[data-document-markdown]')].some(${visible}) }; })()`,
    );
    const shot = await captureSettledScreenshot(page, join(evidence, 'markdown.png'));
    return { ...observed, screenshot: shot.screenshot };
  });
}

/** The visible preview container of `previewId` whose address ends in `/<name>`, or undefined. */
const previewContainer = (previewId, name) =>
  `[...document.querySelectorAll(${JSON.stringify(`[data-document-preview="${previewId}"]`)})].find((el) => (${visible})(el) && decodeURIComponent(el.getAttribute('data-textpreview-url') ?? '').endsWith(${JSON.stringify(`/${name}`)}))`;

// The probe workbook's one sheet (platform/test/office-legacy/README.md).
const SHEET = '报表';
/** Drawn, read inside the container `el`: a PDF page canvas, or the Fortune-sheet workbook. */
const drawn = (previewId) =>
  previewId === EXCEL_PREVIEW
    ? `(${visible})(el.querySelector('section[data-excel-preview]')) && [...el.querySelectorAll('#fortune-sheettab-container-c .luckysheet-sheets-item-name')].some((item) => (${visible})(item) && item.textContent === ${JSON.stringify(SHEET)})`
    : `[...el.querySelectorAll('section[data-pdf-preview] [data-pdf-page] [data-document-zoom-surface]:not([hidden]) canvas')].some(${visible})`;

/**
 * DSH's own document preview of `name`, read only inside the matched container, settles in
 * exactly one released state: `rendered` (drawn, see above) or `failed` (`data-textpreview-failed`,
 * whose value is the code, or a `[role="alert"]` status, which has none). `state` stays null
 * while the container is absent or unsettled.
 */
export const previewOutcome = (previewId, name) => `(() => {
  const el = ${previewContainer(previewId, name)};
  if (!el) return { state: null, pages: 0, nativeHost: false, fontWarning: false };
  // The visible message without the retry button's label.
  const message = (node) => { const copy = node.cloneNode(true); copy.querySelectorAll('button').forEach((b) => b.remove()); return copy.textContent.trim().slice(0, 200); };
  const failed = [...el.querySelectorAll('[data-textpreview-failed]')].find(${visible});
  // Fortune-sheet's own screen-reader live regions (client.excel.js Sheet: #sr-selection and
  // #sr-sheetFocus, .sr-only with role alert) sit inside a drawn workbook; ExcelBody's failure
  // alerts render instead of section[data-excel-preview], never inside it.
  const alert = [...el.querySelectorAll('[role="alert"]')].filter((node) => node.closest('section[data-excel-preview]') === null).find(${visible});
  const rendered = ${drawn(previewId)};
  const outcome = rendered === Boolean(failed ?? alert) ? { state: null } : rendered ? { state: 'rendered' } : failed ? { state: 'failed', code: failed.getAttribute('data-textpreview-failed'), message: message(failed) } : { state: 'failed', message: message(alert) };
  return {
    ...outcome,
    pages: el.querySelectorAll('section[data-pdf-preview] [data-pdf-page]').length,
    nativeHost: el.closest('[data-dsh-native-tab-host]') !== null,
    fontWarning: el.querySelector('[data-office-font-warning]') !== null,
  };
})()`;

// Fortune-sheet's cell input (client.excel.js InputBox): contenteditable whenever no row or column
// is read-only, whatever the workbook's `allowEdit`; only typing into it shows whether it edits.
const CELL_INPUT = 'luckysheet-rich-text-editor';

/**
 * Raw read-only facts of the matched container, judged by the caller: the text and `aria-label`
 * of its visible controls, its editable surfaces other than the cell input (reported apart as
 * `cellInput`), its frames, and the formula bar's text (null without one). Never the composer,
 * which lies outside every preview container.
 */
export const previewFacts = (previewId, name) => `(() => {
  const el = ${previewContainer(previewId, name)};
  if (!el) return null;
  const controls = [...el.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"]')].filter(${visible});
  return {
    labels: controls.flatMap((node) => [node.textContent.trim(), node.getAttribute('aria-label') ?? ''].filter(Boolean)),
    contentEditable: [...el.querySelectorAll('[contenteditable="true"]')].filter((node) => node.id !== ${JSON.stringify(CELL_INPUT)}).length,
    cellInput: el.querySelector(${JSON.stringify(`#${CELL_INPUT}`)}) !== null,
    editors: el.querySelectorAll('.cm-editor').length,
    iframes: el.querySelectorAll('iframe').length,
    cell: el.querySelector('.fortune-fx-input')?.textContent ?? null,
  };
})()`;

/**
 * The matched workbook's cell input state: the viewport rectangle of the cell input (over the
 * selected cell, parked at -10000 without a selection; null without an input) and the viewport's
 * own size, whether the input holds the focus, the formula bar's text, and the input box's
 * z-index, inline first (Fortune-sheet sets -1 while no cell is being edited, 19 while one is).
 */
export const cellInputState = (previewId, name) => `(() => {
  const el = ${previewContainer(previewId, name)};
  const input = el?.querySelector(${JSON.stringify(`#${CELL_INPUT}`)});
  const box = el?.querySelector('.luckysheet-input-box');
  const r = input?.getBoundingClientRect();
  return {
    rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    viewport: { width: innerWidth, height: innerHeight },
    focused: input !== undefined && input !== null && document.activeElement === input,
    cell: el?.querySelector('.fortune-fx-input')?.textContent ?? null,
    zIndex: box ? box.style.zIndex || getComputedStyle(box).zIndex : null,
  };
})()`;

/**
 * The docx: better-sidebar handed it to DSH's own Office preview and drew no viewer for it. The
 * preview must then settle in exactly one released state (`previewOutcome`). The state is
 * recorded here and the caller judges it (#554); an unsettled preview times out.
 */
async function observeDocx(page, evidence, docx) {
  return stage(page, evidence, 'docx', async () => {
    const observed = await waitFor(
      () =>
        evaluate(
          page,
          `(() => {
            const outcome = ${previewOutcome(OFFICE_PREVIEW, docx.name)};
            if (outcome.state === null) return null;
            return {
              ...outcome,
              downloads: [...document.querySelectorAll('a[download]')].filter((a) => decodeURIComponent(a.href).includes(${JSON.stringify(docx.name)})).length,
              editors: [...document.querySelectorAll('[data-dsh-native-tab-host] .cm-editor')].filter(${visible}).length,
            };
          })()`,
        ),
      CONVERSION_MS,
      'office-preview-settled',
    );
    const shot = await captureSettledScreenshot(page, join(evidence, 'docx.png'));
    return { ...observed, screenshot: shot.screenshot };
  });
}

/**
 * One owned Chrome on the employee's platform origin, its workbench started and its composer
 * ready, handed to `run`. Console errors are counted from the first navigation; screenshots and
 * failure DOM summaries stay in `evidence`.
 */
export async function withSidebarBrowser({ origin, cookie, host, runtime, evidence }, run) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-team-better-sidebar-browser-'));
  let browser;
  let failure;
  try {
    browser = await openMappedPage({
      origin,
      cookie,
      extraFlags: mappedFlags(host),
      composition: true,
      runtime,
      profile: join(profile, 'profile'),
      receiptFile: join(profile, 'chrome.receipt.json'),
    });
    const { page } = browser;
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await stage(page, evidence, 'startup', async () => {
      await navigateReady(page, origin, MS);
      await waitComposer(page, MS);
    });
    return await run(browser);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      // openMappedPage closes its own Chrome when it fails; only an opened page is closed here.
      if (browser !== undefined)
        await closeMapped(browser.page, browser.chrome, browser.welcome, failure);
    } finally {
      await rescueChrome(join(profile, 'chrome.receipt.json'));
      await rm(profile, { recursive: true, force: true });
    }
  }
}

/**
 * better-sidebar's explorer opens the Markdown control in its own renderer and hands the docx to
 * DSH's Office preview.
 */
export async function observeSidebarHandoff({ markdown, docx, ...input }) {
  return withSidebarBrowser(input, async ({ page, errors }) => {
    await openExplorer(page, input.evidence, markdown.name);
    await openFromExplorer(page, input.evidence, 'open-markdown', markdown.name);
    const markdownView = await observeMarkdown(page, input.evidence, markdown);
    await openFromExplorer(page, input.evidence, 'open-docx', docx.name);
    const docxView = await observeDocx(page, input.evidence, docx);
    return { markdown: markdownView, docx: docxView, consoleErrors: [...errors] };
  });
}

/** The Markdown control's image, loaded from `/sidebar/file` and decoded; its URL stays in memory. */
async function observeMarkdownImage(page, evidence, markdown) {
  return stage(page, evidence, 'markdown-image', async () => {
    const image = `[...document.querySelectorAll('[data-dsh-md-surface] img')].find((img) => { const url = new URL(img.src, location.href); return url.origin === location.origin && url.pathname === '/sidebar/file' && (url.searchParams.get('path') ?? '').endsWith(${JSON.stringify(`/${markdown.image}`)}); })`;
    const observed = await waitFor(
      () =>
        evaluate(
          page,
          `(() => { const img = ${image}; return img?.complete && img.naturalWidth > 0 ? { src: img.src, naturalWidth: img.naturalWidth } : null; })()`,
        ),
      MS,
      'better-sidebar-markdown-image',
    );
    const shot = await captureSettledScreenshot(page, join(evidence, 'markdown-image.png'));
    return { src: observed.src, naturalWidth: observed.naturalWidth, screenshot: shot.screenshot };
  });
}

// Chrome's notice for a script the document's sandbox refuses; the only allowed probe error.
export const BLOCKED_SCRIPT = ['Blocked script execution', "'allow-scripts' permission is not set"];
export const redactUrls = (text) =>
  String(text ?? '')
    .replace(/https?:\/\/[^\s'"]+/gi, '[url]')
    .slice(0, 240);

/** A fresh tab of the same browser whose document responses and console errors are recorded. */
async function openProbeTab(browserWs) {
  const tab = await connectPage(browserWs);
  const state = { loads: 0, documents: new Map(), blocked: [], errors: [] };
  tab.on('Page.loadEventFired', () => {
    state.loads++;
  });
  tab.on('Network.responseReceived', ({ requestId, type, response }) => {
    if (type !== 'Document') return;
    const headers = Object.fromEntries(
      Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    state.documents.set(requestId, { status: response.status, headers });
  });
  tab.on('Log.entryAdded', ({ entry }) => {
    if (entry?.level !== 'error') return;
    const text = String(entry.text ?? '');
    if (BLOCKED_SCRIPT.every((fragment) => text.includes(fragment)))
      state.blocked.push(redactUrls(text));
    else state.errors.push(redactUrls(text));
  });
  tab.on('Runtime.exceptionThrown', (params) => {
    state.errors.push(errorCode(params.exceptionDetails?.text));
  });
  tab.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') state.errors.push(errorCode(params.args?.[0]?.value));
  });
  for (const domain of ['Network', 'Page', 'Log', 'DOM', 'Runtime'])
    await tab.send(`${domain}.enable`);
  return { tab, state };
}

// The document's real origin and whether it may touch the origin's storage and cookies.
const ORIGIN_READ = `(() => { const name = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } }; return { origin: self.origin, storage: name(() => localStorage.length), cookie: name(() => document.cookie) }; })()`;

/** @returns {{ id: string } | undefined} */
const findFrame = (tree, frameId) =>
  tree.frame.id === frameId
    ? tree.frame
    : (tree.childFrames ?? []).map((child) => findFrame(child, frameId)).find(Boolean);

/**
 * Evaluate `expression` by value in a fresh isolated world of one frame of `target`'s own frame
 * tree (its main frame by default). The world runs even where the document's sandbox blocks page
 * script, and shares the document's DOM. A frame the target does not hold is an error.
 */
export async function isolatedEvaluate(target, expression, frameId) {
  const { frameTree } = await target.send('Page.getFrameTree');
  const frame = frameId === undefined ? frameTree.frame : findFrame(frameTree, frameId);
  if (frame === undefined) throw new Error('isolated-world-frame-missing');
  const { executionContextId } = await target.send('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'dsh-team-isolated-read',
  });
  const result = await target.send('Runtime.evaluate', {
    expression,
    contextId: executionContextId,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('isolated-world-evaluation-failed');
  return result.result.value;
}

/**
 * ORIGIN_READ in an isolated world of one frame. The frame tree's `securityOrigin` is derived from
 * the URL and reports the platform origin for a sandboxed document, so it is no oracle.
 */
export const readOrigin = (target, frameId) => isolatedEvaluate(target, ORIGIN_READ, frameId);

/**
 * Navigate the probe tab as a top-level document, then read its response headers, its origin in
 * an isolated world and, through DOM.*, the static `#probe` marker and the script-written `#ran`.
 */
async function probeDocument({ tab, state }, url, evidence, label) {
  return stage(tab, evidence, label, async () => {
    const before = state.loads;
    const { loaderId, errorText } = await tab.send('Page.navigate', { url });
    if (errorText !== undefined) throw new Error('probe-navigation-failed');
    await waitFor(
      () => state.loads > before && state.documents.has(loaderId),
      MS,
      `${label}-document-load`,
    );
    const response = state.documents.get(loaderId);
    const originRead = await readOrigin(tab);
    const { root } = await tab.send('DOM.getDocument', { depth: 0 });
    const marker = async (selector) =>
      (await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
    const ran = await marker('#ran');
    const shot = await captureSettledScreenshot(tab, join(evidence, `${label}.png`));
    return {
      status: response.status,
      contentType: response.headers['content-type'] ?? null,
      csp: response.headers['content-security-policy'] ?? null,
      nosniff: response.headers['x-content-type-options'] ?? null,
      originRead,
      probe: (await marker('#probe')) !== 0,
      ran: ran === 0 ? null : (await tab.send('DOM.getOuterHTML', { nodeId: ran })).outerHTML,
      screenshot: shot.screenshot,
    };
  });
}

/**
 * The workspace HTML probe opened as a top-level document in a new tab: once through the URL
 * better-sidebar's own Markdown image uses (`/sidebar/file`, only `path` replaced) and once
 * through its `/sidebar/html` preview route as the positive control. The image proves the
 * subresource use still loads; the platform page's own origin read proves the read tells origins
 * apart. No URL or session id enters the observation.
 */
export async function observeWorkspaceDocument({ markdown, probePath, ...input }) {
  return withSidebarBrowser(input, async ({ page, chrome, errors }) => {
    await openExplorer(page, input.evidence, markdown.name);
    await openFromExplorer(page, input.evidence, 'open-markdown', markdown.name);
    const markdownView = await observeMarkdown(page, input.evidence, markdown);
    const { src, ...image } = await observeMarkdownImage(page, input.evidence, markdown);
    // The origin read's own positive control, on the platform page itself.
    const platformOriginRead = await readOrigin(page);
    const fileUrl = new URL(src);
    const sessionId = fileUrl.searchParams.get('sessionId') ?? '';
    if (fileUrl.origin !== input.origin || sessionId === '')
      throw new Error('better-sidebar-browser-image-url');
    fileUrl.searchParams.set('path', probePath);
    const htmlPath = probePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const htmlUrl = `${input.origin}/sidebar/html/${encodeURIComponent(sessionId)}/${htmlPath}`;
    const probe = await openProbeTab(chrome.browserWs);
    try {
      const document = await probeDocument(probe, fileUrl.href, input.evidence, 'file-document');
      const preview = await probeDocument(probe, htmlUrl, input.evidence, 'html-preview');
      await probe.tab.send('Page.close');
      return {
        markdown: markdownView,
        image,
        platformOriginRead,
        document,
        preview,
        blockedScripts: [...probe.state.blocked],
        probeConsoleErrors: [...probe.state.errors],
        consoleErrors: [...errors],
      };
    } finally {
      probe.tab.close();
    }
  });
}

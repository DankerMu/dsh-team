import assert from 'node:assert/strict';
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
  waitComposer,
  waitFor,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { retainPageRequestFailure } from '../../scripts/probe-browser-evidence.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { evaluate, physicalClick } from '../../scripts/probe-permission-ui.mjs';

const MS = 30_000;
// The first WASM LibreOffice conversion of an instance loads the engine before it converts.
const CONVERSION_MS = 240_000;

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
 */
const OFFICE_PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office';
const PANEL = '[data-sidebar-right-open]';

const visible = `(el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.closest('[hidden],[aria-hidden="true"]') === null; }`;

/** The visible explorer row of one workspace file, drawn by better-sidebar wherever it docks. */
const rowQuery = (name) =>
  `[...document.querySelectorAll(${JSON.stringify('[data-dsh-native-tab-host] [role="button"][title]')})].find((el) => (el.title === ${JSON.stringify(name)} || el.title.endsWith(${JSON.stringify(`/${name}`)})) && (${visible})(el))`;

/** The sidebar tab id whose body holds better-sidebar's explorer row for `name`, visible or not. */
const explorerTabQuery = (name) =>
  `(() => { const row = [...document.querySelectorAll(${JSON.stringify('[data-dsh-native-tab-host] [role="button"][title]')})].find((el) => el.title === ${JSON.stringify(name)} || el.title.endsWith(${JSON.stringify(`/${name}`)})); return row?.closest('div[data-sidebar-right-tab]')?.getAttribute('data-sidebar-right-tab') ?? null; })()`;

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

async function stage(page, evidence, label, run) {
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
async function openExplorer(page, evidence, name) {
  await stage(page, evidence, 'expand', async () => {
    // ExpandButton renders nothing while the panel is already expanded.
    const expand = `document.querySelector('button[data-sidebar-right-expand]')`;
    const open = `Boolean(document.querySelector(${JSON.stringify(PANEL)}))`;
    const state = await waitFor(
      () => evaluate(page, `${open} ? 'open' : (${visible})(${expand}) ? 'collapsed' : null`),
      60_000,
      'sidebar-expand-or-open',
    );
    if (state === 'collapsed') await physicalClick(page, expand);
    await waitFor(
      () => evaluate(page, `Boolean(document.querySelector(${JSON.stringify(PANEL)}))`),
      MS,
      'sidebar-open',
    );
  });
  await stage(page, evidence, 'explorer', async () => {
    const guide = `[...document.querySelectorAll('[data-sidebar-right-guide-entry="files"]')].find(${visible})`;
    const shown = await waitFor(
      () => evaluate(page, `(${rowQuery(name)}) ? 'row' : (${guide}) ? 'guide' : null`),
      MS,
      'sidebar-explorer-or-guide',
    );
    if (shown === 'guide') await physicalClick(page, guide);
    await waitFor(
      () => evaluate(page, `Boolean(${rowQuery(name)})`),
      MS,
      'better-sidebar-explorer-row',
    );
  });
}

/** Click one explorer row, first re-selecting the explorer tab when an opened file covers it. */
async function openFromExplorer(page, evidence, label, name) {
  await stage(page, evidence, label, async () => {
    if (!(await evaluate(page, `Boolean(${rowQuery(name)})`))) {
      const tab = await evaluate(page, explorerTabQuery(name));
      assert.equal(typeof tab, 'string', 'better-sidebar explorer tab must remain open');
      await physicalClick(
        page,
        `document.querySelector(${JSON.stringify(`span[data-sidebar-right-tab="${tab}"]`)})`,
      );
      await waitFor(
        () => evaluate(page, `Boolean(${rowQuery(name)})`),
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

/** The docx: DSH's own Office preview converted it; better-sidebar drew no viewer for it. */
async function observeDocx(page, evidence, docx) {
  return stage(page, evidence, 'docx', async () => {
    const container = `[...document.querySelectorAll(${JSON.stringify(`[data-document-preview="${OFFICE_PREVIEW}"]`)})].find((el) => (${visible})(el) && decodeURIComponent(el.getAttribute('data-textpreview-url') ?? '').endsWith(${JSON.stringify(`/${docx.name}`)}))`;
    const outcome = await waitFor(
      () =>
        evaluate(
          page,
          `(() => {
            const failed = [...document.querySelectorAll('[data-textpreview-failed]')].find(${visible});
            if (failed) return { failed: failed.getAttribute('data-textpreview-failed'), text: failed.textContent.trim().slice(0, 200) };
            const el = ${container};
            if (!el) return null;
            const alert = [...el.querySelectorAll('[role="alert"]')].find(${visible});
            if (alert) return { failed: 'alert', text: alert.textContent.trim().slice(0, 200) };
            const ready = [...el.querySelectorAll('section[data-pdf-preview] [data-pdf-page] [data-document-zoom-surface]:not([hidden]) canvas')].filter(${visible});
            return ready.length > 0 ? { failed: null } : null;
          })()`,
        ),
      CONVERSION_MS,
      'office-preview-conversion',
    );
    assert.equal(
      outcome.failed,
      null,
      `Office preview failed: ${outcome.failed} ${outcome.text ?? ''}`,
    );
    const observed = await evaluate(
      page,
      `(() => {
        const el = ${container};
        return {
          pages: el.querySelectorAll('section[data-pdf-preview] [data-pdf-page]').length,
          nativeHost: el.closest('[data-dsh-native-tab-host]') !== null,
          fontWarning: el.querySelector('[data-office-font-warning]') !== null,
          downloads: [...document.querySelectorAll('a[download]')].filter((a) => decodeURIComponent(a.href).includes(${JSON.stringify(docx.name)})).length,
          editors: [...document.querySelectorAll('[data-dsh-native-tab-host] .cm-editor')].filter(${visible}).length,
        };
      })()`,
    );
    const shot = await captureSettledScreenshot(page, join(evidence, 'docx.png'));
    return { ...observed, screenshot: shot.screenshot };
  });
}

/**
 * One owned Chrome on the employee's platform origin: better-sidebar's explorer opens the Markdown
 * control in its own renderer and hands the docx to DSH's Office preview. Console errors are
 * counted from the first navigation; screenshots and failure DOM summaries stay in `evidence`.
 */
export async function observeSidebarHandoff({
  origin,
  cookie,
  host,
  runtime,
  evidence,
  markdown,
  docx,
}) {
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
    const { page, errors } = browser;
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
    await openExplorer(page, evidence, markdown.name);
    await openFromExplorer(page, evidence, 'open-markdown', markdown.name);
    const markdownView = await observeMarkdown(page, evidence, markdown);
    await openFromExplorer(page, evidence, 'open-docx', docx.name);
    const docxView = await observeDocx(page, evidence, docx);
    return { markdown: markdownView, docx: docxView, consoleErrors: [...errors] };
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

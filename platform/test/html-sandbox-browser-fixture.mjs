import { basename, join } from 'node:path';
import { sleep } from '../../scripts/probe-dsh-api-cdp.mjs';
import { captureSettledScreenshot, waitFor } from '../../scripts/probe-dsh-api-ui.mjs';
import { openSettings } from '../../scripts/probe-first-run-preservation.mjs';
import { evaluate, physicalClick } from '../../scripts/probe-permission-ui.mjs';
import {
  BLOCKED_SCRIPT,
  isolatedEvaluate,
  openExplorer,
  openFromExplorer,
  readOrigin,
  redactUrls,
  stage,
  withSidebarBrowser,
} from './better-sidebar-browser-fixture.mjs';
import { routeOf, trackFrames } from './browser-frame-ledger.mjs';

const MS = 30_000;

/*
 * Released markers (dsh-better-sidebar@0.28.0, @deepseek-ai/dsh@0.2.1-rc.2):
 * - the HTML preview iframe (lib/client-editor.js:54797-54812) loads `/sidebar/html/<session>/…`
 *   with `sandbox` unless `htmlViewerNoSandbox` or the status bar's temporary unlock is on;
 * - SandboxStatusBar (lib/client-editor.js:49305-49340): 临时解锁（不安全） only while sandboxed,
 *   恢复沙箱 only while a local unlock is on (lib/client.js:2710-2711, en :3340-3341);
 * - the Side card settings section (`settings.section` id better-sidebar, nav label 侧边卡片
 *   :2655), whose HTML viewer card opens its popup from `button[aria-label="HTML 功能设置"]`
 *   (:31604-31609, :2694, :2698) with the 完成 footer (:2658), inside DSH's settings dialog.
 */
const DIALOG = '[role="dialog"][data-shortcut-modal="settings"]';
const SIDE_CARD = ['侧边卡片', 'Side card'];
const HTML_SETTINGS = ['HTML 功能设置', 'HTML Feature settings'];
const DONE = ['完成', 'Done'];
const CLOSE = ['关闭', 'Close'];
const UNLOCK = ['临时解锁（不安全）', 'Temporarily disable (unsafe)'];
const RESTORE = ['恢复沙箱', 'Restore sandbox'];
const SANDBOX_TITLES = [
  '关闭 HTML 预览沙箱（不安全）',
  'HTML 预览默认以非沙箱模式打开（不安全）',
  'Disable HTML preview sandbox (unsafe)',
  'Open HTML previews unsandboxed by default (unsafe)',
];
const LOCK = 'data-dsh-team-plugin-lock';

// Console errors tolerated only when attributed to the probed frame (literal fragments).
const FRAME_ALLOWED = [
  BLOCKED_SCRIPT,
  ['has been blocked by CORS policy', "from origin 'null'"],
  ['Failed to load resource: net::ERR_FAILED'],
];

const usableText = (selector, labels) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${JSON.stringify(labels)}.includes((el.textContent ?? '').trim()) && !el.disabled && el.getClientRects().length > 0)`;

/** The frame document as its own isolated world sees it; page script is not involved. */
const FRAME_STATE = `(() => ({
  path: location.pathname,
  ready: document.readyState,
  probe: document.getElementById('probe') !== null,
  result: document.getElementById('result')?.textContent ?? null,
}))()`;
const RELEASE = `(document.documentElement.dataset.dshTeamGo = '1', true)`;

const htmlRoute = (url) => routeOf(url) === '/sidebar/html';
const fileRoute = (url) => routeOf(url) === '/sidebar/file';

/** Poll the frame's isolated world on whichever session owns the frame at that moment. */
async function frameRead(ctx, expression, accept, label) {
  const deadline = Date.now() + MS;
  let last;
  while (Date.now() < deadline) {
    try {
      const owner = ctx.frames.owner(ctx.frameId);
      const value = await isolatedEvaluate(owner, expression, ctx.frameId);
      if (accept(value)) return value;
      last = undefined;
    } catch (error) {
      // A navigating frame has no world for a moment, or has moved to another session.
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`html-sandbox-${label}`, { cause: last });
}

/**
 * Wait for the frame's next document whose first URL `accept`s, and for its final hop to be the
 * frame's current, complete document.
 */
async function settle(ctx, before, accept, script, label) {
  const response = await ctx.frames.nextDocument(ctx.frameId, before, accept, MS, label);
  const route = routeOf(response.hops.at(-1).url);
  const state = await frameRead(
    ctx,
    FRAME_STATE,
    (value) =>
      routeOf(`http://x${value.path}`) === route &&
      value.ready === 'complete' &&
      (!script || value.result !== null),
    `${label}-state`,
  );
  return { response, route, state };
}

/** Navigate the frame from the browser on the session that owns it now. */
async function navigateFrame(ctx, url) {
  const { errorText } = await ctx.frames.owner(ctx.frameId).send('Page.navigate', {
    frameId: ctx.frameId,
    url,
  });
  if (errorText !== undefined) throw new Error('html-sandbox-frame-navigation-failed');
}

/**
 * One load's evidence, from its first hop and the document it ended on: no URL, session id or
 * cookie value is recorded, only whether a cookie was sent.
 */
async function recordLoad(ctx, label, { response, route, state }) {
  const shot = await captureSettledScreenshot(ctx.page, join(ctx.evidence, `${label}.png`));
  const [first] = response.hops;
  return {
    route: routeOf(first.url),
    status: first.status,
    location: first.location,
    csp: first.headers['content-security-policy'] ?? null,
    nosniff: first.headers['x-content-type-options'] ?? null,
    secFetchSite: first.secFetchSite,
    cookie: first.cookie,
    hops: response.hops.length,
    finalRoute: route,
    probe: state.probe,
    result: state.result === null ? null : JSON.parse(state.result),
    originRead: await readOrigin(ctx.frames.owner(ctx.frameId), ctx.frameId),
    screenshot: basename(shot.screenshot),
  };
}

/** Return the frame to the iframe's own src and wait until its probe script finished again. */
async function returnToPreview(ctx, label) {
  const before = ctx.frames.known();
  await navigateFrame(ctx, ctx.src);
  await settle(ctx, before, htmlRoute, true, label);
}

/**
 * Three loads of the frame: the preview as it stands, the probe script's own navigation to
 * `/sidebar/file` once the test releases it (cookieless, so the gateway redirects it to the login
 * page), and the browser's navigation to that same URL.
 * The frame returns to the preview after each of the last two.
 */
async function threeLoads(ctx, label, before, settled) {
  return stage(ctx.page, ctx.evidence, label, async () => {
    const preview = await recordLoad(
      ctx,
      `${label}-preview`,
      settled ?? (await settle(ctx, before, htmlRoute, true, `${label}-preview`)),
    );
    const beforeSelf = ctx.frames.known();
    await isolatedEvaluate(ctx.frames.owner(ctx.frameId), RELEASE, ctx.frameId);
    const selfLoad = await settle(ctx, beforeSelf, fileRoute, false, `${label}-self`);
    const self = await recordLoad(ctx, `${label}-self`, selfLoad);
    await returnToPreview(ctx, `${label}-self-return`);
    const beforeBrowser = ctx.frames.known();
    await navigateFrame(ctx, selfLoad.response.url);
    const browserLoad = await settle(ctx, beforeBrowser, fileRoute, false, `${label}-browser`);
    const browser = await recordLoad(ctx, `${label}-browser`, browserLoad);
    await returnToPreview(ctx, `${label}-browser-return`);
    return { label, preview, self, browser };
  });
}

/** The visible preview iframe of `name`: its frame id, src and `sandbox` attribute. */
async function previewFrame(page, name) {
  const query = `[...document.querySelectorAll('iframe')].find((f) => { try { const u = new URL(f.src); return u.origin === location.origin && u.pathname.startsWith('/sidebar/html/') && decodeURIComponent(u.pathname).endsWith(${JSON.stringify(`/${name}`)}) && f.getClientRects().length > 0; } catch { return false; } })`;
  const objectId = await waitFor(
    async () =>
      (await page.send('Runtime.evaluate', { expression: query, returnByValue: false })).result
        ?.objectId,
    MS,
    'html-preview-iframe',
  );
  const { node } = await page.send('DOM.describeNode', { objectId });
  if (typeof node.frameId !== 'string') throw new Error('html-preview-iframe-frame');
  const attributes = async () =>
    (
      await page.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () { return { src: this.src, sandbox: this.getAttribute('sandbox') }; }`,
        returnByValue: true,
      })
    ).result.value;
  return { frameId: node.frameId, attributes, ...(await attributes()) };
}

/** The HTML viewer's settings popup: each sandbox toggle hidden and followed by its lock mark. */
async function observeSettings(page, evidence, label) {
  return stage(page, evidence, label, async () => {
    await openSettings(page, () => MS);
    await waitFor(
      () => evaluate(page, `Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`),
      MS,
      'settings-dialog',
    );
    await physicalClick(page, usableText(`${DIALOG} nav button`, SIDE_CARD));
    const gear = `[...document.querySelectorAll('button[aria-label]')].find((el) => ${JSON.stringify(HTML_SETTINGS)}.includes(el.getAttribute('aria-label')) && el.getClientRects().length > 0)`;
    await waitFor(() => evaluate(page, `Boolean(${gear})`), MS, 'html-viewer-settings-button');
    await physicalClick(page, gear);
    const toggles = await waitFor(
      () =>
        evaluate(
          page,
          `(() => { const rows = [...document.querySelectorAll('input[type="checkbox"]')].filter((input) => ${JSON.stringify(SANDBOX_TITLES)}.includes(input.getAttribute('aria-label'))).map((input) => { const label = input.closest('label'); const mark = label?.nextElementSibling; return { title: input.getAttribute('aria-label'), labelRects: label?.getClientRects().length ?? null, mark: mark?.getAttribute(${JSON.stringify(LOCK)}) ?? null, markText: mark?.textContent ?? null, markRects: mark?.getClientRects().length ?? 0 }; }); return rows.length === 2 ? rows : null; })()`,
        ),
      MS,
      'html-sandbox-toggles',
    );
    const shot = await captureSettledScreenshot(page, join(evidence, `${label}.png`));
    await physicalClick(page, usableText('[role="dialog"] button', DONE));
    const open = `[...document.querySelectorAll('input[type="checkbox"]')].some((input) => ${JSON.stringify(SANDBOX_TITLES)}.includes(input.getAttribute('aria-label')))`;
    await waitFor(() => evaluate(page, `!${open}`), MS, 'html-viewer-settings-closed');
    await physicalClick(page, usableText(`${DIALOG} button`, CLOSE));
    await waitFor(
      () => evaluate(page, `!document.querySelector(${JSON.stringify(DIALOG)})`),
      MS,
      'settings-closed',
    );
    return { toggles, screenshot: basename(shot.screenshot) };
  });
}

/** The status bar's two actions as currently rendered. */
const statusBar = (page) =>
  evaluate(
    page,
    `({ unlock: Boolean(${usableText('button', UNLOCK)}), restore: Boolean(${usableText('button', RESTORE)}) })`,
  );

/** Phase 1: sandboxed by default, then the status bar's temporary unlock and a frame reload. */
async function defaultPhase(ctx, iframe, opened) {
  const locked = await threeLoads(ctx, 'default-locked', undefined, opened);
  const settings = await observeSettings(ctx.page, ctx.evidence, 'default-settings');
  const bar = await statusBar(ctx.page);
  if (!bar.unlock) throw new Error('html-sandbox-unlock-missing');
  await physicalClick(ctx.page, usableText('button', UNLOCK));
  const unlocked = await waitFor(
    async () => {
      const { sandbox } = await iframe.attributes();
      return sandbox === null ? { sandbox } : null;
    },
    MS,
    'html-sandbox-attribute-removed',
  );
  const shot = await captureSettledScreenshot(ctx.page, join(ctx.evidence, 'default-unlocked.png'));
  const before = ctx.frames.known();
  await navigateFrame(ctx, ctx.src);
  const reloaded = await threeLoads(ctx, 'default-unlocked', before);
  return {
    statusBar: bar,
    settings,
    unlock: {
      ...unlocked,
      statusBar: await statusBar(ctx.page),
      screenshot: basename(shot.screenshot),
    },
    rounds: [locked, reloaded],
  };
}

/** Phase 2: the employee's own profile turned both keys on; the preview opens unsandboxed. */
async function employeePhase(ctx, opened) {
  const bar = await statusBar(ctx.page);
  const shot = await captureSettledScreenshot(ctx.page, join(ctx.evidence, 'employee-opened.png'));
  return {
    statusBar: { ...bar, screenshot: basename(shot.screenshot) },
    rounds: [await threeLoads(ctx, 'employee', undefined, opened)],
  };
}

/**
 * Open the HTML probe from better-sidebar's file area and check its frame across three loads per
 * round. `default`: one round sandboxed, the settings lock display, the temporary unlock, one more
 * round. `employee`: one round after the employee's profile enabled both keys. Console errors are
 * attributed per frame; the main page's must stay zero.
 */
export async function observeHtmlSandbox({ probe, phase, ...input }) {
  return withSidebarBrowser(input, async ({ page, errors }) => {
    const startup = errors.length;
    const frames = await trackFrames(page, FRAME_ALLOWED);
    try {
      await openExplorer(page, input.evidence, probe.name);
      const before = frames.known();
      await openFromExplorer(page, input.evidence, `${phase}-open-probe`, probe.name);
      const iframe = await stage(page, input.evidence, `${phase}-iframe`, () =>
        previewFrame(page, probe.name),
      );
      const ctx = {
        page,
        frames,
        frameId: iframe.frameId,
        src: iframe.src,
        evidence: input.evidence,
      };
      const opened = await settle(ctx, before, htmlRoute, true, `${phase}-opened`);
      const observed =
        phase === 'default'
          ? await defaultPhase(ctx, iframe, opened)
          : await employeePhase(ctx, opened);
      const report = frames.consoleReport(iframe.frameId);
      if (errors.length - startup !== report.pageEvents)
        throw new Error('html-sandbox-console-accounting');
      const text = (rows) => rows.map((row) => `${row.kind}:${redactUrls(row.text)}`);
      return {
        phase,
        sandbox: iframe.sandbox,
        ...observed,
        allowedFrameConsole: text(report.allowed),
        probeConsoleErrors: text(report.probeErrors),
        consoleErrors: [...errors.slice(0, startup), ...text(report.otherErrors)],
        attachFailures: frames.failures(),
      };
    } finally {
      frames.dispose();
    }
  });
}

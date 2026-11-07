import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import {
  observeSidebarHandoff,
  observeWorkspaceDocument,
} from './better-sidebar-browser-fixture.mjs';
import { observeHtmlSandbox } from './html-sandbox-browser-fixture.mjs';
import type { FrameRound } from './html-sandbox-browser-fixture.mjs';
import { postRestart } from './account-status-fixture.ts';
import {
  awaitEmployeeInstance,
  startBrowserPlatform,
  startEmployeeInstance,
} from './instance-browser-docker-fixture.ts';
import { PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';
import { configureInstanceModel, registerInstanceUser } from './instance-fixture.ts';
import { rejectPluginFailures } from './plugin-failure-markers.ts';
import { assertDocxReadback, offlineDocxScript, runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

// The positive control: a Markdown file better-sidebar renders itself.
const MARKDOWN = {
  name: 'sidebar-control.md',
  heading: '增强侧栏正向对照',
  paragraph: '这段文字由增强侧栏自己的渲染器显示。',
};
// The image's own python3-docx writes the known Chinese document (assertDocxReadback's fixture).
const DOCX = { name: 'offline.docx' };

/** Run one script as the instance's own uid1001 user; its output is the script's stdout. */
async function instanceExec(lifecycle: UserImageLifecycle, id: string, args: readonly string[]) {
  const result = await lifecycle.commandAsync(['exec', id, ...args], 30_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Owned instance file preparation failed');
  return result.stdout;
}

/** The instance is the employee's own running instance; the browser reaches it at `origin`. */
interface SidebarEmployee {
  readonly lifecycle: UserImageLifecycle;
  readonly id: string;
  readonly origin: string;
  readonly cookie: string;
  readonly host: string;
  readonly evidence: string;
  /** An administrator's real HTTP restart of the instance; resolves to the ready container. */
  readonly restart: () => Promise<string>;
}

/**
 * One owned platform and one registered employee whose instance runs this image. `run` returns
 * the container-start summary and its report line, written once the instance's plugins are also
 * proved to have loaded without a failure marker.
 */
async function withSidebarEmployee(
  label: string,
  assertSummary: (summary: string) => void,
  run: (employee: SidebarEmployee) => Promise<{ summary: string; report: string }>,
) {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  isolatedBrowserRuntime();
  await runUserImage('container-start', assertSummary, undefined, async (lifecycle) => {
    const host = `dsh-team-${label}.invalid`;
    const { app, database, base, origin } = await startBrowserPlatform(lifecycle, host);
    const evidence = resolve('.run/issue429', `${label}-${lifecycle.runId}`);
    try {
      await mkdir(evidence, { recursive: true });
      // No model request is sent: this config only admits ordinary instance startup.
      configureInstanceModel(database);
      const user = await registerInstanceUser(base, origin, `${label}@example.test`);
      let id = await startEmployeeInstance(lifecycle, base, origin, database, user);
      const restart = async () => {
        const admin = await registerInstanceUser(base, origin, `${label}-admin@example.test`);
        database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
        expect(await postRestart(base, admin.cookie, user.id, origin)).toEqual({
          status: 200,
          body: { userId: user.id, status: 'starting', reason: 'starting' },
        });
        id = await awaitEmployeeInstance(lifecycle, base, database, user);
        return id;
      };
      const { summary, report } = await run({
        lifecycle,
        id,
        origin,
        cookie: user.cookie,
        host,
        evidence,
        restart,
      });
      // The current container: a restart replaces it. A failed or over-limit read returns empty
      // output, which must not pass the marker check.
      const logs = await lifecycle.commandAsync(['logs', id], 30_000);
      if (logs.error !== undefined || logs.status !== 0)
        throw new Error('Sidebar instance logs unavailable');
      rejectPluginFailures(logs, 'Sidebar instance plugin load failed');
      process.stdout.write(`${report} run=${lifecycle.runId} screenshots=${evidence}\n`);
      return summary;
    } finally {
      await app.close();
      database.close();
    }
  });
}

const writeText =
  'import sys, pathlib; pathlib.Path(sys.argv[1]).write_text(sys.argv[2], encoding="utf-8")';

it('opens Markdown in better-sidebar and hands a docx from its file area to the released Office preview', async () => {
  await withSidebarEmployee(
    'better-sidebar',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({ markdown: true, docx: true, consoleErrors: 0 });
    },
    async ({ lifecycle, id, origin, cookie, host, evidence }) => {
      assertDocxReadback(await instanceExec(lifecycle, id, ['python3', '-c', offlineDocxScript]));
      await instanceExec(lifecycle, id, [
        'python3',
        '-c',
        writeText,
        `/data/work/${MARKDOWN.name}`,
        `# ${MARKDOWN.heading}\n\n${MARKDOWN.paragraph}\n`,
      ]);

      const observed = await observeSidebarHandoff({
        origin,
        cookie,
        host,
        runtime: isolatedBrowserRuntime(lifecycle.runId),
        evidence,
        markdown: MARKDOWN,
        docx: DOCX,
      });
      await writeFile(join(evidence, 'evidence.json'), JSON.stringify(observed, null, 2), {
        mode: 0o600,
      });

      // better-sidebar's own renderer, inside its own tab host, not DSH's Markdown preview.
      expect(observed.markdown).toMatchObject({
        nativeHost: true,
        paragraph: true,
        dshMarkdown: false,
      });
      // DSH's Office preview received the docx and settled; its outcome is recorded, not
      // asserted (#554). better-sidebar drew no editor or download pane.
      expect(observed.docx).toMatchObject({ nativeHost: false, downloads: 0, editors: 0 });
      expect(observed.consoleErrors).toEqual([]);
      return {
        summary: JSON.stringify({
          markdown: true,
          docx: true,
          consoleErrors: observed.consoleErrors.length,
        }),
        report:
          `Docker better-sidebar handoff verified: preview=${observed.docx.state} ` +
          `code=${observed.docx.code ?? '-'} message=${JSON.stringify(observed.docx.message ?? '')} ` +
          `pages=${String(observed.docx.pages)} fontWarning=${String(observed.docx.fontWarning)}`,
      };
    },
  );
});

// The image control: better-sidebar loads a Markdown image through `/sidebar/file` as `<img>`.
const IMAGE_MARKDOWN = {
  name: 'sidebar-image.md',
  heading: '工作区图片对照',
  paragraph: '这张图片经工作区文件路由加载。',
  image: 'sidebar-pixel.png',
};
const PROBE_PATH = '/data/work/file-probe.html';
// The page script writes `#ran` with its own origin only where the document may run scripts.
const PROBE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">' +
  '<title>file probe</title></head><body><h1 id="probe">file probe</h1><script>' +
  "const ran = document.createElement('pre'); ran.id = 'ran'; ran.textContent = String(self.origin); " +
  'document.body.appendChild(ran);</script></body></html>';
// A 4x3 RGB PNG built by the image's own python3 standard library.
const PNG_SCRIPT = [
  'import sys, struct, zlib',
  'def chunk(kind, data): return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))',
  'rows = b"".join(b"\\x00" + b"\\xc0\\x20\\x20" * 4 for _ in range(3))',
  'header = struct.pack(">IIBBBBB", 4, 3, 8, 2, 0, 0, 0)',
  'png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")',
  'open(sys.argv[1], "wb").write(png)',
].join('\n');
// The released better-sidebar 0.28.0 `/sidebar/html` policy: scripts, never the platform origin.
const HTML_PREVIEW_CSP =
  "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'";
// An opaque origin, read in an isolated world: no origin, no storage, no cookies.
const OPAQUE_ORIGIN_READ = { origin: 'null', storage: 'SecurityError', cookie: 'SecurityError' };

it('opens a workspace HTML file as a document from /sidebar/file only in an opaque origin, without script', async () => {
  await withSidebarEmployee(
    'sidebar-file-document',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({ sandboxed: true, consoleErrors: 0 });
    },
    async ({ lifecycle, id, origin, cookie, host, evidence }) => {
      await instanceExec(lifecycle, id, ['python3', '-c', writeText, PROBE_PATH, PROBE_HTML]);
      await instanceExec(lifecycle, id, [
        'python3',
        '-c',
        PNG_SCRIPT,
        `/data/work/${IMAGE_MARKDOWN.image}`,
      ]);
      await instanceExec(lifecycle, id, [
        'python3',
        '-c',
        writeText,
        `/data/work/${IMAGE_MARKDOWN.name}`,
        `# ${IMAGE_MARKDOWN.heading}\n\n${IMAGE_MARKDOWN.paragraph}\n\n![pixel](./${IMAGE_MARKDOWN.image})\n`,
      ]);

      const observed = await observeWorkspaceDocument({
        origin,
        cookie,
        host,
        runtime: isolatedBrowserRuntime(lifecycle.runId),
        evidence,
        markdown: IMAGE_MARKDOWN,
        probePath: PROBE_PATH,
      });
      await writeFile(join(evidence, 'evidence.json'), JSON.stringify(observed, null, 2), {
        mode: 0o600,
      });

      expect(observed.markdown).toMatchObject({ nativeHost: true, paragraph: true });
      // The subresource use of /sidebar/file is unaffected by the document sandbox.
      expect(observed.image.naturalWidth).toBe(4);
      expect(observed.document).toMatchObject({
        status: 200,
        contentType: 'text/html',
        csp: 'sandbox',
        nosniff: 'nosniff',
        probe: true,
        ran: null,
      });
      // The real origin, read in an isolated world; the frame tree's URL-derived one is no oracle.
      expect(observed.document.originRead).toEqual(OPAQUE_ORIGIN_READ);
      // The read's own positive control: on the platform page it sees the platform origin.
      expect(observed.platformOriginRead).toEqual({ origin, storage: 'ok', cookie: 'ok' });
      // Positive control: the same file and DOM reading, where the released route runs scripts.
      expect(observed.preview).toMatchObject({
        status: 200,
        csp: HTML_PREVIEW_CSP,
        probe: true,
        ran: '<pre id="ran">null</pre>',
      });
      // That route's sandbox lacks allow-same-origin, so it is opaque as well.
      expect(observed.preview.originRead).toEqual(OPAQUE_ORIGIN_READ);
      expect(observed.probeConsoleErrors).toEqual([]);
      expect(observed.consoleErrors).toEqual([]);
      return {
        summary: JSON.stringify({ sandboxed: true, consoleErrors: observed.consoleErrors.length }),
        report:
          `Docker sidebar file document verified: csp=${observed.document.csp ?? '-'} ` +
          `originRead=${JSON.stringify(observed.document.originRead)} ` +
          `previewOriginRead=${JSON.stringify(observed.preview.originRead)} ` +
          `platformOriginRead=${JSON.stringify({ ...observed.platformOriginRead, origin: observed.platformOriginRead.origin === origin ? 'platform' : 'other' })} ` +
          `blockedScripts=${String(observed.blockedScripts.length)} image=${String(observed.image.naturalWidth)}`,
      };
    },
  );
});

const SANDBOX_PROBE = { name: 'sandbox-probe.html' };
const SANDBOX_PROBE_PATH = `/data/work/${SANDBOX_PROBE.name}`;
// The first, synchronous statement marks the document as run, before any await. Then five
// attempts, each `ok` or the caught error's name, then `done`. Once the test has read
// `#result` it sets `data-dsh-team-go` from an isolated world (the DOM is shared), and only then
// does the opaque page navigate its own frame to `/sidebar/file` for the same file.
const SANDBOX_PROBE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">' +
  '<title>sandbox probe</title></head><body><p id="probe">sandbox probe</p><script>' +
  "document.documentElement.dataset.dshTeamRan = '1';" +
  '(async () => {' +
  "const name = (read) => { try { read(); return 'ok'; } catch (e) { return e.name; } };" +
  'const result = { origin: String(self.origin),' +
  ' parent: name(() => window.parent.document.title),' +
  ' top: name(() => window.top.location.href),' +
  ' cookie: name(() => document.cookie),' +
  ' storage: name(() => localStorage.length) };' +
  "try { await (await fetch('/_platform/api/session', { credentials: 'include' })).json(); result.fetch = 'ok'; }" +
  ' catch (e) { result.fetch = e.name; }' +
  "result.state = 'done';" +
  "const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = JSON.stringify(result);" +
  'document.body.appendChild(pre);' +
  'const root = document.documentElement;' +
  "const go = () => { const sessionId = decodeURIComponent(location.pathname.split('/')[3]);" +
  " location.href = '/sidebar/file?sessionId=' + encodeURIComponent(sessionId) + '&path=' +" +
  ` encodeURIComponent(${JSON.stringify(SANDBOX_PROBE_PATH)}); };` +
  "if (root.dataset.dshTeamGo === '1') go();" +
  " else new MutationObserver((records, observer) => { if (root.dataset.dshTeamGo === '1') { observer.disconnect(); go(); } })" +
  ".observe(root, { attributes: true, attributeFilter: ['data-dsh-team-go'] });" +
  '})();</script></body></html>';

/**
 * The employee's own edit, as uid1001: the loader-row id of dsh-better-sidebar is read from the
 * image's default profile (the bundle layer that inserts it), and one row setting both keys is
 * appended to the profile's cordis.patch.yml, written as a whole file (development note 1).
 */
const EMPLOYEE_SANDBOX_EDIT = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { load, dump } = require('js-yaml');
const seed = '/opt/dsh-team/profile-seed/web';
const bundles = JSON.parse(readFileSync(join(seed, 'package.json'), 'utf8')).dsh?.profile?.bundles;
if (!Array.isArray(bundles) || !bundles.includes('dsh-better-sidebar')) throw new Error('better-sidebar is not a default bundle');
const bundleRoot = join(seed, 'node_modules', 'dsh-better-sidebar');
const layerPath = JSON.parse(readFileSync(join(bundleRoot, 'package.json'), 'utf8')).dsh?.bundle?.patch;
if (typeof layerPath !== 'string') throw new Error('better-sidebar declares no bundle patch');
const yamlLib = createRequire(require.resolve('@deepseek-ai/dsh-config-editor/package.json'))('yaml');
const layer = yamlLib.parseDocument(readFileSync(join(bundleRoot, layerPath), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
});
if (layer.errors[0] !== undefined) throw new Error('Invalid better-sidebar bundle patch');
const loaders = (layer.toJS() ?? []).flatMap((row) => row?.insert ?? []).filter((row) => row?.name === 'dsh-better-sidebar');
if (loaders.length !== 1 || typeof loaders[0].id !== 'string') throw new Error('No single better-sidebar loader row');
const id = loaders[0].id;
const patchPath = '/data/home/profiles/web/cordis.patch.yml';
const parsed = existsSync(patchPath) ? load(readFileSync(patchPath, 'utf8')) ?? [] : [];
if (!Array.isArray(parsed)) throw new Error('Invalid profile patch');
const kept = parsed.length;
parsed.push({ id, config: { htmlViewerNoSandbox: true, htmlViewerDefaultUnsafe: true } });
const bytes = dump(parsed, { lineWidth: -1 });
${PROFILE_EDITOR_SERIALIZATION}
writeFileSync(patchPath, serializedProfile);
const written = load(readFileSync(patchPath, 'utf8'));
process.stdout.write(JSON.stringify({ id, kept, rows: written.length, last: written.at(-1) }));
`;

const PREVIEW_RESULT = {
  origin: 'null',
  parent: 'SecurityError',
  top: 'SecurityError',
  cookie: 'SecurityError',
  storage: 'SecurityError',
  fetch: 'TypeError',
  state: 'done',
};

/**
 * Every round's three loads stay opaque, whatever the iframe attribute or employee setting.
 * `secFetchSite` is evidence only: the test origin is not potentially trustworthy, so Chrome sends
 * no `Sec-Fetch-*` header. Whether a cookie was sent is the observed cause (null, never false,
 * when Chrome reported no request headers).
 */
function expectOpaqueRound(round: FrameRound) {
  expect(round.preview).toMatchObject({
    route: '/sidebar/html',
    cookie: true,
    status: 200,
    csp: HTML_PREVIEW_CSP,
    probe: true,
    ran: true,
    result: PREVIEW_RESULT,
  });
  // The opaque page's own navigation sends no cookie, so the gateway sends it to the login page
  // before DSH: the workspace file is never delivered and the probe script never runs.
  expect(round.self).toMatchObject({
    route: '/sidebar/file',
    cookie: false,
    status: 302,
    location: '/_platform/login',
    finalRoute: '/_platform/login',
    probe: false,
    ran: false,
    result: null,
  });
  // The browser's navigation sends the platform cookie and passes the fence: the file arrives but
  // its script never runs.
  expect(round.browser).toMatchObject({
    route: '/sidebar/file',
    cookie: true,
    status: 200,
    csp: 'sandbox',
    nosniff: 'nosniff',
    probe: true,
    ran: false,
    result: null,
  });
  expect(round.browser.blockedScripts).toBeGreaterThan(0);
  expect(round.preview.finalRoute).toBe('/sidebar/html');
  expect(round.browser.finalRoute).toBe('/sidebar/file');
  for (const load of [round.preview, round.browser])
    expect(load.originRead).toEqual(OPAQUE_ORIGIN_READ);
}

const SANDBOX_MARK = '沙箱开启 · 由管理员设定';

it('keeps the HTML preview opaque by default, after a temporary unlock and after the employee enables both sandbox keys, with both switches locked', async () => {
  await withSidebarEmployee(
    'html-sandbox',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({ sandboxed: true, rounds: 3, consoleErrors: 0 });
    },
    async ({ lifecycle, id, origin, cookie, host, evidence, restart }) => {
      await instanceExec(lifecycle, id, [
        'python3',
        '-c',
        writeText,
        SANDBOX_PROBE_PATH,
        SANDBOX_PROBE_HTML,
      ]);
      const browser = { origin, cookie, host, evidence, probe: SANDBOX_PROBE };
      const locked = await observeHtmlSandbox({
        ...browser,
        runtime: isolatedBrowserRuntime(lifecycle.runId),
        phase: 'default',
      });
      const edit: unknown = JSON.parse(
        await instanceExec(lifecycle, id, [
          'node',
          '--input-type=module',
          '-e',
          EMPLOYEE_SANDBOX_EDIT,
        ]),
      );
      await restart();
      const employee = await observeHtmlSandbox({
        ...browser,
        runtime: isolatedBrowserRuntime(lifecycle.runId),
        phase: 'employee',
      });
      await writeFile(
        join(evidence, 'evidence.json'),
        JSON.stringify({ locked, edit, employee }, null, 2),
        { mode: 0o600 },
      );

      // Phase 1: the default iframe is sandboxed and both switches show the managed lock.
      expect(locked.sandbox).toBe('allow-scripts allow-popups allow-downloads allow-modals');
      expect(locked.statusBar).toMatchObject({ unlock: true, restore: false });
      expect(locked.settings?.toggles).toHaveLength(2);
      for (const toggle of locked.settings?.toggles ?? []) {
        expect(toggle).toMatchObject({
          labelRects: 0,
          mark: 'html-sandbox',
          markText: SANDBOX_MARK,
        });
        expect(toggle.markRects).toBeGreaterThan(0);
      }
      // The temporary unlock removed the attribute; the reloaded frame is still opaque.
      expect(locked.unlock).toMatchObject({ sandbox: null, statusBar: { restore: true } });
      expect(locked.rounds).toHaveLength(2);
      // Phase 2: the employee's row kept every original row and set both keys.
      expect(edit).toMatchObject({
        id: expect.any(String) as string,
        last: { config: { htmlViewerNoSandbox: true, htmlViewerDefaultUnsafe: true } },
      });
      const { kept, rows } = edit as { kept: number; rows: number };
      expect(rows).toBe(kept + 1);
      // Either key alone drops the attribute at load; the restore action shows that
      // htmlViewerDefaultUnsafe started the local unlock.
      expect(employee.sandbox).toBeNull();
      expect(employee.statusBar).toMatchObject({ unlock: false, restore: true });
      // Restoring cleared the local unlock: the same frame stays without the attribute only
      // through htmlViewerNoSandbox, and the bar offers neither action.
      expect(employee.restore).toMatchObject({
        sandbox: null,
        sameFrame: true,
        statusBar: { unlock: false, restore: false },
      });
      expect(employee.rounds).toHaveLength(1);
      const rounds = [...locked.rounds, ...employee.rounds];
      for (const round of rounds) expectOpaqueRound(round);
      for (const observed of [locked, employee]) {
        expect(observed.probeConsoleErrors).toEqual([]);
        expect(observed.consoleErrors).toEqual([]);
        // A worker may end before its resume completes; the probed frame's target never may.
        expect(observed.attachFailures.filter(({ type }) => type === 'iframe')).toEqual([]);
      }
      return {
        summary: JSON.stringify({
          sandboxed: true,
          rounds: rounds.length,
          consoleErrors: locked.consoleErrors.length + employee.consoleErrors.length,
        }),
        report:
          `Docker HTML preview sandbox verified: rounds=${String(rounds.length)} ` +
          `selfFetchSite=${rounds.map((round) => round.self.secFetchSite ?? '-').join(',')} ` +
          `selfCookie=${rounds.map((round) => String(round.self.cookie)).join(',')} ` +
          `allowedFrameConsole=${String(locked.allowedFrameConsole.length + employee.allowedFrameConsole.length)}`,
      };
    },
  );
});

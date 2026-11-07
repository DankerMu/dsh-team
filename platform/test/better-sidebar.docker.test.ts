import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import {
  observeSidebarHandoff,
  observeWorkspaceDocument,
} from './better-sidebar-browser-fixture.mjs';
import { startBrowserPlatform, startEmployeeInstance } from './instance-browser-docker-fixture.ts';
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
      const id = await startEmployeeInstance(lifecycle, base, origin, database, user);
      const { summary, report } = await run({
        lifecycle,
        id,
        origin,
        cookie: user.cookie,
        host,
        evidence,
      });
      // A failed or over-limit read returns empty output, which must not pass the marker check.
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
      expect(observed.document.securityOrigin).not.toBe(origin);
      expect(observed.document.securityOrigin).not.toMatch(/^https?:\/\//);
      // Positive control: the same file and DOM reading, where the released route runs scripts.
      expect(observed.preview).toMatchObject({
        status: 200,
        csp: HTML_PREVIEW_CSP,
        probe: true,
        ran: '<pre id="ran">null</pre>',
      });
      expect(observed.probeConsoleErrors).toEqual([]);
      expect(observed.consoleErrors).toEqual([]);
      return {
        summary: JSON.stringify({ sandboxed: true, consoleErrors: observed.consoleErrors.length }),
        report:
          `Docker sidebar file document verified: csp=${observed.document.csp ?? '-'} ` +
          `origin=${JSON.stringify(observed.document.securityOrigin)} ` +
          `blockedScripts=${String(observed.blockedScripts.length)} image=${String(observed.image.naturalWidth)}`,
      };
    },
  );
});

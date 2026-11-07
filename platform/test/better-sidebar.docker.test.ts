import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isolatedBrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import { observeSidebarHandoff } from './better-sidebar-browser-fixture.mjs';
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

it('opens Markdown in better-sidebar and hands a docx from its file area to the released Office preview', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  isolatedBrowserRuntime();
  await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({ markdown: true, docx: true, consoleErrors: 0 });
    },
    undefined,
    async (lifecycle) => {
      const host = 'dsh-team-better-sidebar.invalid';
      const { app, database, base, origin } = await startBrowserPlatform(lifecycle, host);
      const evidence = resolve('.run/issue429', `better-sidebar-${lifecycle.runId}`);
      try {
        await mkdir(evidence, { recursive: true });
        // No model request is sent: this config only admits ordinary instance startup.
        configureInstanceModel(database);
        const employee = await registerInstanceUser(base, origin, 'better-sidebar@example.test');
        const id = await startEmployeeInstance(lifecycle, base, origin, database, employee);
        assertDocxReadback(await instanceExec(lifecycle, id, ['python3', '-c', offlineDocxScript]));
        await instanceExec(lifecycle, id, [
          'python3',
          '-c',
          'import sys, pathlib; pathlib.Path(sys.argv[1]).write_text(sys.argv[2], encoding="utf-8")',
          `/data/work/${MARKDOWN.name}`,
          `# ${MARKDOWN.heading}\n\n${MARKDOWN.paragraph}\n`,
        ]);

        const observed = await observeSidebarHandoff({
          origin,
          cookie: employee.cookie,
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
        // A failed or over-limit read returns empty output, which must not pass the marker check.
        const logs = await lifecycle.commandAsync(['logs', id], 30_000);
        if (logs.error !== undefined || logs.status !== 0)
          throw new Error('Sidebar instance logs unavailable');
        rejectPluginFailures(logs, 'Sidebar instance plugin load failed');
        process.stdout.write(
          `Docker better-sidebar handoff verified: run=${lifecycle.runId} preview=${observed.docx.state} ` +
            `code=${observed.docx.code ?? '-'} message=${JSON.stringify(observed.docx.message ?? '')} ` +
            `pages=${String(observed.docx.pages)} fontWarning=${String(observed.docx.fontWarning)} ` +
            `screenshots=${evidence}\n`,
        );
        return JSON.stringify({
          markdown: true,
          docx: true,
          consoleErrors: observed.consoleErrors.length,
        });
      } finally {
        await app.close();
        database.close();
      }
    },
  );
});

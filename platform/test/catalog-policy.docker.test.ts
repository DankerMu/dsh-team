import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { CATALOG_PLUGIN_PAGE, runCatalogPolicyScenario } from './catalog-policy-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';

const WEB_TOOLS = ['web_search', 'web_fetch'];

/** The plugin page as both starts must show it after the ONLYOFFICE off/on round trip. */
function expectPluginPage(pluginPage: unknown): void {
  expect(pluginPage).toMatchObject({
    list: { refresh: true, addButtons: 1, group: 'bundles', status: 'running', checked: true },
    detail: { uninstallButtons: 1, checked: true, disabled: false, title: null },
    off: { checked: false, status: 'disabled' },
    on: { checked: true, status: 'running' },
    cards: CATALOG_PLUGIN_PAGE.expected.map((entry) => ({
      package: entry.package,
      status: entry.enabled ? 'running' : 'disabled',
      checked: entry.enabled,
      locked: 'locked' in entry ? entry.locked : null,
    })),
    // The first locked card: never focused by Tab, unchanged by pointer/Enter/Space, locked detail.
    locked: {
      package: '@dsh-team/knowledge-base',
      focus: { roundTripSwitch: true },
      input: { checked: true, lock: 'forced-on' },
      detail: { lock: 'forced-on' },
    },
  });
  // list, locked, locked-detail, detail, off, on.
  expect((pluginPage as { screenshots: unknown[] }).screenshots).toHaveLength(6);
}

/** Preset id to whether it lists each web tool; only the four released presets remain. */
function webTools(presets: unknown): Record<string, boolean[]> {
  return Object.fromEntries(
    (presets as { id: string; toolNames: string[] }[]).map((preset) => [
      preset.id,
      WEB_TOOLS.map((name) => preset.toolNames.includes(name)),
    ]),
  );
}

it('locks forced catalog entries, keeps ONLYOFFICE the employee’s and switches web tools on restart', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      const { start, restart } = JSON.parse(summary) as Record<
        'start' | 'restart',
        { presets: unknown; pluginPage: unknown }
      >;
      expect(webTools(start.presets)).toEqual({
        standard: [false, false],
        ptc: [false, false],
        minimal: [false, false],
        cordis: [false, false],
      });
      // The global tool-web row stays disabled (dsh-web-app cordis.patch.yml:579): minimal has none.
      expect(webTools(restart.presets)).toEqual({
        standard: [true, true],
        ptc: [true, true],
        minimal: [false, false],
        cordis: [true, true],
      });
      expectPluginPage(start.pluginPage);
      expectPluginPage(restart.pluginPage);
    },
    undefined,
    runCatalogPolicyScenario,
  );
  process.stdout.write(
    `Docker catalog policy verified: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

import { arch, platform } from 'node:os';
import { expect, it } from 'vitest';
import { RESTART_CARDS, runInstallDialogScenario } from './install-dialog-fixture.ts';
import {
  METADATA_REQUEST,
  PROBE_PLUGIN,
  STAND_IN_REQUESTS,
  TARBALL_REQUEST,
} from './registry-stand-in.ts';
import { runUserImage } from './user-image-fixture.ts';

interface Stage {
  pluginPage: unknown;
  pluginManager: unknown;
  installed: unknown;
}

/** Both starts: the overlay's single source, probing off and the host probe's null answer. */
function expectSources(stage: Stage, registry: string): void {
  expect(stage.pluginPage).toEqual({ registryProbeEnabled: false, fastest: null });
  expect(stage.pluginManager).toEqual({ registry, fallbackRegistries: [] });
  expect(stage.installed).toEqual({
    selected: true,
    dependency: expect.stringContaining('1.0.0') as unknown,
  });
}

it('installs a package from the instance-local registry through the plugin page dialog and keeps it across a restart', async () => {
  if (platform() !== 'linux' || arch() !== 'x64') {
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  }
  const result = await runUserImage(
    'managed-policy',
    (summary) => {
      const { registry, start, restart } = JSON.parse(summary) as {
        registry: string;
        start: Stage & { requests: string[]; install: unknown };
        restart: Stage & { cards: unknown };
      };
      expectSources(start, registry);
      expectSources(restart, registry);
      // Load-bearing: the dialog asks the overlay's source only once `readRegistries` reconciled
      // it (client.js:1230,1519); otherwise pnpm asks npmjs and the stand-in logs nothing.
      expect(start.requests).toEqual(expect.arrayContaining([METADATA_REQUEST, TARBALL_REQUEST]));
      // Nothing else: no re-resolution of the preinstalled closure through the dialog's install.
      expect(STAND_IN_REQUESTS).toEqual(expect.arrayContaining(start.requests));
      expect(start.install).toEqual({
        package: PROBE_PLUGIN,
        card: { group: 'bundles', status: 'running', checked: true },
      });
      expect(restart.cards).toEqual(
        RESTART_CARDS.map((entry) => ({
          package: entry.package,
          status: entry.enabled ? 'running' : 'disabled',
          checked: entry.enabled,
          locked: 'locked' in entry ? entry.locked : null,
        })),
      );
    },
    undefined,
    runInstallDialogScenario,
  );
  process.stdout.write(
    `Docker install dialog verified: run=${result.runId} image=${result.image} ` +
      `readback=${result.stdout} cleanup=complete\n`,
  );
});

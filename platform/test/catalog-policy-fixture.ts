import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MappedHostAcceptResult,
  MappedHostPluginPageOptions,
} from '../../scripts/probe-mapped-host.mjs';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { catalogStates, readPluginCatalog } from '../src/plugin-catalog/index.ts';
import { createManagedPolicyEvidence } from './managed-policy-evidence.ts';
import type { ManagedPolicyStage } from './managed-policy-evidence.ts';
import {
  acceptManaged,
  collectComposition,
  execScript,
  installObserverScript,
  lifecycleWebNetwork,
  MANAGED_POLICY_EXPECTED,
  publishOverlay,
} from './managed-policy-fixture.ts';
import { parseManagedPolicyRuntime } from './managed-policy-oracle.ts';
import { createProfileRecorder } from './managed-policy-profile.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const INVALID = 'Invalid catalog policy observation';
const FORCED = { 'knowledge-base': 'forced-on', 'office-agents': 'forced-off' } as const;
// The generator reads a canonical patch for each forced manageable bundle.
const BUNDLE_IDS = Object.keys(FORCED);
const PLUGIN_CATALOG = catalogStates(readPluginCatalog(), { pluginCatalog: FORCED });

/** Office forced off: its two presets are disabled rows, the four released presets remain. */
const CATALOG_EXPECTED = {
  ...MANAGED_POLICY_EXPECTED,
  presetIds: ['standard', 'ptc', 'minimal', 'cordis'],
  officeNames: {},
};

/**
 * Explicit card table in catalog order. DSH's own status and switch reflect profile selection, so
 * both forced cards stay selected (plugins/platform-nav/README.md accepted residual). The
 * knowledge-base card is the first locked one: `verifyLocks` presses its mark and opens its detail;
 * the office card passes only the list-level lock check. ONLYOFFICE stays the employee's.
 */
export const CATALOG_PLUGIN_PAGE = {
  expected: [
    { package: 'dsh-better-sidebar', enabled: true },
    { package: 'dsh-sidebar-onlyoffice', enabled: true },
    { package: '@dsh-team/knowledge-base', enabled: true, locked: 'forced-on' },
    { package: '@dsh-team/office-agents', enabled: true, locked: 'forced-off' },
    { package: '@dsh-team/office-hints', enabled: false, locked: 'forced-on' },
    { package: '@dsh-team/permission-tiers', enabled: false, locked: 'forced-on' },
    { package: '@dsh-team/platform-nav', enabled: false, locked: 'forced-on' },
    { package: '@dsh-team/zh-locale', enabled: false, locked: 'forced-on' },
  ],
  roundTrip: { package: 'dsh-sidebar-onlyoffice', leaveEnabled: true },
} as const satisfies MappedHostPluginPageOptions;

// The image's seed profile manifest, shared by every new employee. The live copy is not compared:
// DSH re-appends a re-enabled bundle (dsh-plugin-manager lib/index.js:340), reordering the list.
const SEED_MANIFEST_SCRIPT = `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const bytes = readFileSync('/opt/dsh-team/profile-seed/web/package.json');
process.stdout.write(createHash('sha256').update(bytes).digest('hex'));
`;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stageSummary(observation: unknown, browser: MappedHostAcceptResult) {
  return {
    presets: parseManagedPolicyRuntime(observation).presets.map(({ id, toolNames }) => ({
      id,
      toolNames,
    })),
    pluginPage: browser.pluginPage,
  };
}

/**
 * #409 locked catalog states and web tools: office-agents forced off, knowledge-base forced on and
 * ONLYOFFICE round-tripped by the employee on the plugin page; the first start has web tools off,
 * the restart over the same volumes has them on. Each start republishes the overlay; the employee
 * round trip leaves its bytes unchanged.
 */
export async function runCatalogPolicyScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const evidence = createManagedPolicyEvidence(lifecycle);
  const profiles = createProfileRecorder(
    (phase, script) =>
      execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-profile-${phase}`, script),
    evidence,
  );
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-catalog-policy-'));
  let failedStage: ManagedPolicyStage | undefined;
  try {
    const runtime = isolatedBrowserRuntime(lifecycle.runId);
    const startedAt = Date.now();
    // Two plugin-page passes of five reloads each on top of the managed acceptance.
    const remaining = (): number => Math.max(1, 420_000 - (Date.now() - startedAt));
    mkdirSync(lifecycle.overlayDirectory, { recursive: true });
    const plugin = readFileSync(new URL('./managed-policy-observer.js', import.meta.url), 'utf8');
    execScript(
      lifecycle,
      `dsh-team-test-${lifecycle.runId}-observer`,
      installObserverScript(plugin),
    );
    const composition = await collectComposition(
      lifecycle,
      `dsh-team-test-${lifecycle.runId}-read`,
      BUNDLE_IDS,
    );
    const accept = async (label: 'start' | 'restart', webToolsEnabled: boolean) => {
      failedStage = label;
      const network = lifecycleWebNetwork(lifecycle, label);
      const overlay = await publishOverlay(lifecycle.overlayDirectory, composition, true, network, {
        webToolsEnabled,
        pluginCatalog: PLUGIN_CATALOG,
      });
      const published = sha256(overlay);
      const accepted = await acceptManaged(
        lifecycle,
        overlay,
        network,
        remaining,
        runtime,
        work,
        evidence,
        profiles,
        { ...CATALOG_EXPECTED, webToolsEnabled },
        label,
        CATALOG_PLUGIN_PAGE,
      );
      if (sha256(overlay) !== published) throw new Error(`${INVALID}: overlay changed`);
      return stageSummary(accepted.observation, accepted.browser);
    };
    const seed = execScript(
      lifecycle,
      `dsh-team-test-${lifecycle.runId}-seed`,
      SEED_MANIFEST_SCRIPT,
    );
    const start = await accept('start', false);
    const stopped = lifecycle.command(['stop', `dsh-team-test-${lifecycle.runId}-start`], 30_000);
    if (stopped.error !== undefined || stopped.status !== 0) throw new Error(`${INVALID}: stop`);
    const reread = `dsh-team-test-${lifecycle.runId}-seed-reread`;
    if (execScript(lifecycle, reread, SEED_MANIFEST_SCRIPT) !== seed) {
      throw new Error(`${INVALID}: seed manifest changed`);
    }
    const restart = await accept('restart', true);
    evidence.finish();
    return JSON.stringify({ start, restart, evidence: evidence.path });
  } catch (error) {
    evidence.fail(failedStage);
    throw error;
  } finally {
    await rescueChrome(join(work, 'chrome-start.receipt.json'));
    await rescueChrome(join(work, 'chrome-restart.receipt.json'));
    rmSync(work, { recursive: true, force: true });
  }
}

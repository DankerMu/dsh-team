import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  MappedHostAcceptResult,
  MappedHostPluginPageOptions,
} from '../../scripts/probe-mapped-host.mjs';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { catalogStates, readPluginCatalog } from '../src/plugin-catalog/index.ts';
import { createManagedPolicyEvidence } from './managed-policy-evidence.ts';
import type { ManagedPolicyStage } from './managed-policy-evidence.ts';
import { PROFILE_ROWS_READ } from './managed-policy-employee-edit.ts';
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
import { createProfileRecorder, PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';
import { profileManifests } from './profile-manifests.ts';
import type { ManagedComposition } from '../src/managed-config/index.ts';
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

/**
 * The employee's profile-patch rewrite (39.B). Each row matches a bundle-layer entry (the office
 * bundle's presets and preset default, dsh-base's plugin-manager); later overlay rows put each back.
 */
const EMPLOYEE_REWRITE = [
  { id: 'preset-office-general', disabled: false },
  { id: 'preset-office-writer', disabled: false },
  { id: 'agent-preset-registry', config: { default: 'office-general' } },
  { id: 'plugin-manager', config: { registry: 'http://127.0.0.1:8/', fallbackRegistries: [] } },
];
/**
 * Required entries are inserted only by the overlay, which applies after the profile, so this row
 * can match nothing. It is appended after the recompose: the composition reader rejects any
 * unmatched row (managed-config read.ts), so with it the platform would refuse to start at all.
 */
const REQUIRED_OFF = [{ id: 'zh-locale', disabled: true }];
const UNMATCHED_REQUIRED = ['patch: entry "zh-locale" not found'];

const ACTIVE = { present: true, enabled: true, fiberState: 2 };
// Disabled before boot: cordis-plugin-loader 1.0.6 Entry.refresh (lib/index.js:361-364) never
// creates its fiber.
const DISABLED = { present: true, enabled: false, fiberState: null };
/** Both starts: the overlay's values in effect, none of the employee rewrite. */
const OVERLAY_STATE = {
  pluginManager: {
    registry: 'https://registry.npmjs.org/',
    fallbackRegistries: ['https://registry.npmmirror.com/'],
  },
  presetRegistry: { default: 'standard', defaultId: 'standard' },
  entries: {
    'preset-office-general': DISABLED,
    'preset-office-writer': DISABLED,
    'knowledge-base': ACTIVE,
    'platform-nav': ACTIVE,
    'zh-locale': ACTIVE,
    'managed-permissions': ACTIVE,
  },
};

/**
 * Appends `rows` like managed-policy's stop edit (whole-file write in the config editor's dialect,
 * the observer insert kept), then reads them back and composes the profile without the overlay,
 * as the composition reader does, keeping its skip diagnostics.
 */
function rewriteScript(rows: readonly object[]): string {
  return `${PROFILE_ROWS_READ}
import { pathToFileURL } from 'node:url';
parsed.push(...${JSON.stringify(rows)});
const bytes = dump(parsed, { lineWidth: -1 });
${PROFILE_EDITOR_SERIALIZATION}
writeFileSync(profile, serializedProfile);
const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const loaded = boot.loadProfileDirectory('dsh', '/data/home/profiles/web', '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const home = boot.loadOptionalPatches('dsh', '/data/home/cordis.patch.yml') ?? [];
const warnings = [];
boot.composeEntries([...loaded.layers.map((layer) => layer.patches), loaded.patches, home], (message) => warnings.push(message));
const written = readFileSync(profile, 'utf8');
process.stdout.write(JSON.stringify({ written, rows: load(written).slice(-${String(rows.length)}), warnings }));
`;
}

/** Returns the written profile once the rows, the observer row and the skips are as expected. */
function employeeRewrite(
  lifecycle: UserImageLifecycle,
  name: string,
  rows: readonly object[],
  warnings: readonly string[],
): string {
  const edited = JSON.parse(execScript(lifecycle, name, rewriteScript(rows))) as Record<
    string,
    unknown
  >;
  if (typeof edited.written !== 'string') throw new Error(`${INVALID}: employee rewrite`);
  if (!isDeepStrictEqual(edited.rows, rows)) throw new Error(`${INVALID}: rewritten rows`);
  if (!edited.written.includes('@dsh-team/managed-policy-observer.js')) {
    throw new Error(`${INVALID}: observer row lost`);
  }
  if (!isDeepStrictEqual(edited.warnings, warnings)) throw new Error(`${INVALID}: skipped rows`);
  return edited.written;
}

function requireOverlayState(observation: unknown): void {
  const observed = observation as Record<string, unknown>;
  for (const [key, expected] of Object.entries(OVERLAY_STATE)) {
    if (!isDeepStrictEqual(observed[key], expected)) throw new Error(`${INVALID}: ${key}`);
  }
}

/** Bundles as a set: DSH re-appends a re-enabled one (dsh-plugin-manager lib/index.js:2280-2295). */
function selection(manifest: string): { dependencies: unknown; bundles: string[] } {
  const parsed = JSON.parse(manifest) as {
    dependencies?: unknown;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles = parsed.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error(`${INVALID}: profile bundles`);
  return { dependencies: parsed.dependencies, bundles: bundles.map(String).sort() };
}

/** The running instance's live profile manifest still selects and installs what the seed does. */
async function requireSeedSelection(lifecycle: UserImageLifecycle, name: string): Promise<void> {
  const { live, seed } = await profileManifests(lifecycle, name);
  if (!isDeepStrictEqual(selection(live), selection(seed))) {
    throw new Error(`${INVALID}: profile selection`);
  }
}

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
 * #409 locked catalog states, web tools and the employee rewrite: office-agents forced off,
 * knowledge-base forced on and ONLYOFFICE round-tripped by the employee on the plugin page; the
 * first start has web tools off. Stopped, the employee rewrites the profile patch; the restart over
 * the same volumes has web tools on and must show the overlay's values, none of the rewrite.
 */
export async function runCatalogPolicyScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const evidence = createManagedPolicyEvidence(lifecycle);
  const prefix = `dsh-team-test-${lifecycle.runId}`;
  const profiles = createProfileRecorder(
    (phase, script) => execScript(lifecycle, `${prefix}-profile-${phase}`, script),
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
    execScript(lifecycle, `${prefix}-observer`, installObserverScript(plugin));
    const composition = await collectComposition(lifecycle, `${prefix}-read`, BUNDLE_IDS);
    const accept = async (
      label: 'start' | 'restart',
      webToolsEnabled: boolean,
      composed: ManagedComposition,
    ) => {
      failedStage = label;
      const network = lifecycleWebNetwork(lifecycle, label);
      const overlay = await publishOverlay(lifecycle.overlayDirectory, composed, true, network, {
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
      // The overlay is mounted read-only: this only shows the start ran on the published bytes.
      if (sha256(overlay) !== published) throw new Error(`${INVALID}: overlay changed`);
      requireOverlayState(accepted.observation);
      await requireSeedSelection(lifecycle, `${prefix}-${label}`);
      return stageSummary(accepted.observation, accepted.browser);
    };
    const start = await accept('start', false, composition);
    const stopped = lifecycle.command(['stop', `${prefix}-start`], 30_000);
    if (stopped.error !== undefined || stopped.status !== 0) throw new Error(`${INVALID}: stop`);
    profiles.capture('start-stopped');
    failedStage = 'restart';
    employeeRewrite(lifecycle, `${prefix}-rewrite`, EMPLOYEE_REWRITE, []);
    // Like the platform before every start; the rewrite changes nothing it composes.
    const recomposed = await collectComposition(lifecycle, `${prefix}-reread`, BUNDLE_IDS);
    profiles.capture('recompose-read');
    if (!isDeepStrictEqual(recomposed, composition)) throw new Error(`${INVALID}: recomposed`);
    const written = employeeRewrite(
      lifecycle,
      `${prefix}-required`,
      REQUIRED_OFF,
      UNMATCHED_REQUIRED,
    );
    profiles.capture('employee-edited', written);
    const restart = await accept('restart', true, recomposed);
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

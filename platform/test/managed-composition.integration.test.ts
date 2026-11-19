import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManagedComposition } from '../src/managed-config/index.ts';
import type { ManagedComposition } from '../src/managed-config/index.ts';

const INVALID = 'Invalid managed composition';
// The reader's image anchor: the generated script resolves app-boot from it twice (createRequire
// and loadProfileDirectory); both must point at the fake or the host's global DSH could win.
const INSTALL_ANCHOR = JSON.stringify('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const CASE_MS = 20_000;
// The child is killed this long before the case timeout, so a hung script fails as this case.
const RESERVE_MS = 5000;
const PRESET_NAME = '@deepseek-ai/dsh-agent-preset';

/**
 * Stand-in for the released `@deepseek-ai/dsh-app-boot` (0.2.1-rc.2 lib/index.js `composeEntries`
 * :1084-1089 over `applyEntryPatches` :61-104): layers are flattened, cloned and applied in order;
 * each skipped row calls `warn` once with `%C` already replaced by `JSON.stringify` of its value.
 * Every message is also logged before `warn` runs, so a rejection shows which row caused it.
 */
const FAKE_APP_BOOT = `
import { appendFileSync, readFileSync } from 'node:fs';
const LAYERS = JSON.parse(readFileSync(new URL('./layers.json', import.meta.url), 'utf8'));
const LOG = new URL('./warnings.log', import.meta.url);
export function loadProfileDirectory() {
  return { layers: LAYERS.bundles.map((patches) => ({ patches })), patches: LAYERS.profile, skippedBundles: [] };
}
export function loadOptionalPatches() {
  return LAYERS.home;
}
export function loadOverlayPatches() {
  return LAYERS.locale;
}
export function bundlePatchPaths() {
  throw new Error('no manageable bundle is read in this test');
}
export function composeEntries(layers, warn) {
  const entries = [];
  const byId = new Map();
  const index = (list) => {
    for (const entry of list) {
      if (entry.id) byId.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) index(entry.config);
    }
  };
  const skip = (template, ...args) => {
    let next = 0;
    const message = template.replace(/%C/g, () => JSON.stringify(args[next++]));
    appendFileSync(LOG, JSON.stringify(message) + '\\n');
    warn(message);
  };
  for (const { id, insert, name, ...overrides } of structuredClone(layers.flat())) {
    if (insert) {
      if (id) {
        const target = byId.get(id);
        if (!target) { skip('patch insert: entry %C not found', id); continue; }
        if (!target.group) { skip('patch insert: entry %C is not a group', id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else entries.push(...insert);
      index(insert);
      continue;
    }
    if (!id) { skip('patch: id is required for non-insert patches'); continue; }
    const target = byId.get(id);
    if (!target) { skip('patch: entry %C not found', id); continue; }
    if (name && name !== target.name) {
      skip('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name);
      continue;
    }
    Object.assign(target, overrides);
  }
  return entries;
}
`;

function preset(id: string) {
  return {
    id: `preset-${id}`,
    name: PRESET_NAME,
    config: { id, plugins: [{ id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }] },
  };
}

const STANDARD = preset('standard');
const WRITER = preset('writer');
const LOCALE = [{ insert: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }] }];
const PLUGIN_MANAGER = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' };
/** dsh-base-like bundle layers: a root insert, then an override of a row it inserted. */
const BUNDLES = [
  [{ insert: [STANDARD, { id: 'tools', name: 'cordis:group', group: true, config: [] }] }],
  [{ insert: [PLUGIN_MANAGER] }, { id: 'plugin-manager', config: { fallbackRegistries: [] } }],
];
// Inserted only by the overlay, which DSH applies after the profile (#601).
const UNMATCHED = { id: 'zh-locale', disabled: true };
const NOT_FOUND = 'patch: entry "zh-locale" not found';

interface Layers {
  bundles: readonly (readonly object[])[];
  profile: readonly object[];
  home?: readonly object[];
}

interface Composed {
  outcome: unknown;
  anchors: number;
  child: SpawnSyncReturns<string> | undefined;
  warnings: string[];
}

/**
 * Runs the reader's generated script in its own Node process, as the image does, against the fake
 * app-boot in a temporary install root; no manageable bundle is read (its copies live under /opt).
 */
async function compose({ bundles, profile, home }: Layers): Promise<Composed> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-composition-'));
  try {
    const boot = join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
    mkdirSync(boot, { recursive: true });
    writeFileSync(
      join(boot, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', main: 'index.js' }),
    );
    writeFileSync(join(boot, 'index.js'), FAKE_APP_BOOT);
    writeFileSync(
      join(boot, 'layers.json'),
      JSON.stringify({ bundles, profile, home, locale: LOCALE }),
    );
    const anchor = JSON.stringify(
      join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    );
    let anchors = 0;
    let child: SpawnSyncReturns<string> | undefined;
    const outcome = await readManagedComposition((script) => {
      anchors = script.split(INSTALL_ANCHOR).length - 1;
      child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script.replaceAll(INSTALL_ANCHOR, anchor)],
        // Nothing inherited: NODE_OPTIONS or NODE_PATH would change what the script resolves.
        { env: {}, encoding: 'utf8', timeout: CASE_MS - RESERVE_MS, killSignal: 'SIGKILL' },
      );
      return child.status === 0
        ? Promise.resolve(child.stdout)
        : Promise.reject(new Error(child.stderr));
    }, []).catch((error: unknown) => error);
    const log = join(boot, 'warnings.log');
    const warnings = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string)
      : [];
    return { outcome, anchors, child, warnings };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function accepted(composed: Composed): { observed: unknown; composition: ManagedComposition } {
  expect(composed.anchors).toBe(2);
  expect(composed.child?.status).toBe(0);
  expect(composed.outcome).not.toBeInstanceOf(Error);
  return {
    observed: JSON.parse(composed.child?.stdout ?? ''),
    composition: composed.outcome as ManagedComposition,
  };
}

function rejected(composed: Composed, warnings: readonly string[]): void {
  expect(composed.anchors).toBe(2);
  expect(composed.outcome).toBeInstanceOf(Error);
  expect(composed.outcome).toHaveProperty('message', INVALID);
  expect(composed.child?.status).toBe(1);
  expect(composed.child?.stdout).toBe('');
  expect(composed.child?.stderr).toBe(`${INVALID}\n`);
  // The failure is the composition's own: its last skip is the row under test.
  expect(composed.warnings).toEqual(warnings);
}

describe('managed composition script', () => {
  it(
    'composes the bundle layers with no profile or home rows',
    async () => {
      const { composition } = accepted(await compose({ bundles: BUNDLES, profile: [] }));
      expect(composition).toEqual({ presets: [STANDARD], localePatch: LOCALE, bundles: [] });
    },
    CASE_MS * 2,
  );

  it.each([
    ['profile', { bundles: BUNDLES, profile: [UNMATCHED] }],
    ['home', { bundles: BUNDLES, profile: [], home: [UNMATCHED] }],
  ])(
    'skips a %s row whose target is absent, as DSH does',
    async (_layer, layers: Layers) => {
      const baseline = accepted(await compose({ bundles: BUNDLES, profile: [] }));
      const composed = await compose(layers);
      const { observed, composition } = accepted(composed);
      expect(composed.warnings).toEqual([NOT_FOUND]);
      expect(observed).toEqual(baseline.observed);
      expect(composition).toEqual(baseline.composition);
    },
    CASE_MS * 2,
  );

  it(
    'returns the composition of all layers, keeping profile rows that apply around a skipped one',
    async () => {
      const composed = await compose({
        bundles: BUNDLES,
        profile: [UNMATCHED, { insert: [WRITER] }],
      });
      const { composition } = accepted(composed);
      expect(composed.warnings).toEqual([NOT_FOUND]);
      expect(composition.presets).toEqual([STANDARD, WRITER]);
    },
    CASE_MS,
  );

  it.each([
    [
      'a name mismatch',
      [{ ...PLUGIN_MANAGER, name: '@other/plugin-manager', disabled: true }],
      [
        'patch: name mismatch for "plugin-manager" (expected "@deepseek-ai/dsh-plugin-manager", got "@other/plugin-manager"), skipping',
      ],
    ],
    [
      'an insert into an absent group',
      [{ id: 'absent-group', insert: [WRITER] }],
      ['patch insert: entry "absent-group" not found'],
    ],
    [
      'an insert into a non-group',
      [{ id: 'plugin-manager', insert: [WRITER] }],
      ['patch insert: entry "plugin-manager" is not a group'],
    ],
    ['a row without id', [{ disabled: true }], ['patch: id is required for non-insert patches']],
    ['a non-string absent id', [{ id: 5, disabled: true }], ['patch: entry 5 not found']],
    [
      'a name mismatch after a skipped absent row',
      [UNMATCHED, { ...PLUGIN_MANAGER, name: '@other/plugin-manager' }],
      [
        NOT_FOUND,
        'patch: name mismatch for "plugin-manager" (expected "@deepseek-ai/dsh-plugin-manager", got "@other/plugin-manager"), skipping',
      ],
    ],
  ])(
    'rejects a profile row with %s',
    async (_label, profile: readonly object[], warnings: readonly string[]) => {
      rejected(await compose({ bundles: BUNDLES, profile }), warnings);
    },
    CASE_MS,
  );

  it(
    'rejects a bundle-layer row whose target is absent',
    async () => {
      rejected(await compose({ bundles: [...BUNDLES, [UNMATCHED]], profile: [] }), [NOT_FOUND]);
    },
    CASE_MS,
  );
});

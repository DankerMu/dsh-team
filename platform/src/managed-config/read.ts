import type { ManagedConfigInput } from './generate.ts';

export type ManagedComposition = Pick<ManagedConfigInput, 'presets' | 'localePatch' | 'bundles'>;

type PresetEntry = ManagedConfigInput['presets'][number];

const INVALID_COMPOSITION = 'Invalid managed composition';
const PRESET_NAME = '@deepseek-ai/dsh-agent-preset';
const INSTALL_ANCHOR = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
const PROFILE_DIR = '/data/home/profiles/web';
const HOME_PATCH = '/data/home/cordis.patch.yml';
const CANONICAL_LOCALE_PATCH =
  '/opt/dsh-team/profile-seed/web/node_modules/@dsh-team/zh-locale/cordis.patch.yml';

// Installed-image ESM payload. app-boot is resolved from the image anchor at
// runtime; a static platform import would add a forbidden host dependency.
// Bundle ids are kebab-case catalog ids; canonical copies are root-only under /opt/dsh-team.
const managedCompositionCommand = (bundleIds: readonly string[]) => `\
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const FAIL = ${JSON.stringify(INVALID_COMPOSITION)};
const BUNDLE_IDS = ${JSON.stringify(bundleIds)};
function fail() {
  process.stderr.write(FAIL + '\\n');
  process.exit(1);
}
try {
  const require = createRequire(${JSON.stringify(INSTALL_ANCHOR)});
  const {
    loadProfileDirectory,
    composeEntries,
    loadOptionalPatches,
    loadOverlayPatches,
    bundlePatchPaths,
  } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const profile = loadProfileDirectory('dsh', ${JSON.stringify(PROFILE_DIR)}, ${JSON.stringify(INSTALL_ANCHOR)});
  const homePatch = loadOptionalPatches('dsh', ${JSON.stringify(HOME_PATCH)}) ?? [];
  const entries = composeEntries(
    [...profile.layers.map((layer) => layer.patches), profile.patches, homePatch],
    () => {
      throw new Error(FAIL);
    },
  );
  const localePatch = loadOverlayPatches('dsh', ${JSON.stringify(CANONICAL_LOCALE_PATCH)});
  const bundles = BUNDLE_IDS.map((id) => {
    const directory = '/opt/dsh-team/' + id;
    const manifest = JSON.parse(readFileSync(directory + '/package.json', 'utf8'));
    // A missing dsh.bundle or patch declaration throws here, like any unreadable file.
    const paths = bundlePatchPaths(directory, manifest.dsh?.bundle);
    return { id, patch: paths.flatMap((path) => loadOverlayPatches('dsh', path)) };
  });
  process.stdout.write(JSON.stringify({
    skippedBundles: profile.skippedBundles,
    entries,
    localePatch,
    bundles,
  }));
} catch {
  fail();
}
`;

function invalid(): never {
  throw new Error(INVALID_COMPOSITION);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid();
  }
  // JSON objects arrive untyped; field checks below are the contract.
  return value as Record<string, unknown>;
}

function requirePlugins(value: unknown): void {
  if (!Array.isArray(value)) {
    invalid();
  }
  for (const plugin of value) {
    const record = asObject(plugin);
    if (typeof record.name !== 'string' || record.name === '') {
      invalid();
    }
    if (record.group === true) {
      requirePlugins(record.config);
    }
  }
}

function requirePreset(entry: Record<string, unknown>): PresetEntry {
  if (typeof entry.id !== 'string' || entry.id === '') {
    invalid();
  }
  const config = asObject(entry.config);
  if (typeof config.id !== 'string' || config.id === '') {
    invalid();
  }
  requirePlugins(config.plugins);
  // Validated against the generator's preset input contract; JSON.parse cannot name PresetEntry.
  return entry as PresetEntry;
}

function collectHost(entries: readonly unknown[], seen: Set<string>, presets: PresetEntry[]): void {
  for (const value of entries) {
    const entry = asObject(value);
    if (Object.hasOwn(entry, 'id')) {
      if (typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) {
        invalid();
      }
      seen.add(entry.id);
    }
    if (entry.group === true) {
      if (!Array.isArray(entry.config)) {
        invalid();
      }
      collectHost(entry.config, seen, presets);
    }
    if (entry.name === PRESET_NAME) {
      presets.push(requirePreset(entry));
    }
  }
}

function bundleInsertIds(row: Record<string, unknown>): string[] {
  if (!Object.hasOwn(row, 'insert')) return [];
  if (!Array.isArray(row.insert)) invalid();
  return row.insert.map((value: unknown) => {
    const entry = asObject(value);
    if (typeof entry.id !== 'string' || entry.id === '') invalid();
    if (entry.name === PRESET_NAME) requirePreset(entry);
    return entry.id;
  });
}

function projectBundles(
  value: unknown,
  bundleIds: readonly string[],
  seen: ReadonlySet<string>,
): ManagedComposition['bundles'] {
  if (!Array.isArray(value) || value.length !== bundleIds.length) invalid();
  return bundleIds.map((id, index) => {
    const bundle = asObject(value[index]);
    if (bundle.id !== id || !Array.isArray(bundle.patch)) invalid();
    const ids = bundle.patch.flatMap((row: unknown) => bundleInsertIds(asObject(row)));
    const found = ids.filter((entry) => seen.has(entry)).length;
    // A partially composed bundle is neither safely re-insertable nor enabled.
    if (found !== 0 && found !== ids.length) invalid();
    // Rows were validated as JSON objects; the generator accepts arbitrary JSON rows.
    const patch = bundle.patch as ManagedComposition['bundles'][number]['patch'];
    return { id, patch, present: ids.length !== 0 && found === ids.length };
  });
}

function projectComposition(observed: unknown, bundleIds: readonly string[]): ManagedComposition {
  const record = asObject(observed);
  if (!Array.isArray(record.skippedBundles) || record.skippedBundles.length > 0) {
    invalid();
  }
  if (!Array.isArray(record.entries) || !Array.isArray(record.localePatch)) {
    invalid();
  }
  if (record.localePatch.length === 0) {
    invalid();
  }
  for (const row of record.localePatch) {
    asObject(row);
  }
  const presets: PresetEntry[] = [];
  const seen = new Set<string>();
  collectHost(record.entries, seen, presets);
  if (presets.length === 0) {
    invalid();
  }
  const bundles = projectBundles(record.bundles, bundleIds, seen);
  // Locale rows are validated as JSON objects; the generator accepts arbitrary JSON.
  return { presets, localePatch: record.localePatch as ManagedComposition['localePatch'], bundles };
}

/** `bundleIds` are only the forced-state manageable catalog ids; `employee` bundles are never read. */
export async function readManagedComposition(
  execute: (script: string) => Promise<string>,
  bundleIds: readonly string[],
): Promise<ManagedComposition> {
  let raw: string;
  try {
    raw = await execute(managedCompositionCommand(bundleIds));
  } catch {
    invalid();
  }
  let observed: unknown;
  try {
    observed = JSON.parse(raw);
  } catch {
    invalid();
  }
  return projectComposition(observed, bundleIds);
}

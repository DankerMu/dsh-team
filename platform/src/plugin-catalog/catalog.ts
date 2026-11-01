import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogState, Settings } from '../db/index.ts';

/** Source tree, build output and platform image all place images/ three levels above this module. */
const DEFAULT_CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'images',
  'dsh-user',
  'catalog.json',
);
const KEBAB_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_RULES: Readonly<Record<string, (value: unknown) => boolean>> = {
  id: (value) => typeof value === 'string' && KEBAB_ID.test(value),
  package: (value) => typeof value === 'string' && value.trim() !== '',
  name: (value) => typeof value === 'string' && value.trim() !== '',
  category: (value) => value === 'required' || value === 'manageable',
  imageDefaultEnabled: (value) => typeof value === 'boolean',
};
const FIELD_NAMES = Object.keys(FIELD_RULES);

interface CatalogEntry {
  readonly id: string;
  readonly package: string;
  readonly name: string;
  readonly category: 'required' | 'manageable';
  readonly imageDefaultEnabled: boolean;
}
export interface PluginCatalog {
  readonly entries: readonly CatalogEntry[];
}
interface CatalogEntryState extends CatalogEntry {
  readonly state: CatalogState;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseEntries(raw: unknown, fail: (detail: string) => Error): CatalogEntry[] {
  if (!isPlainObject(raw)) throw fail('must be an object');
  if (Object.keys(raw).some((key) => key !== 'version' && key !== 'entries'))
    throw fail('has an unknown key');
  if (raw.version !== 1) throw fail('version must be 1');
  if (!Array.isArray(raw.entries)) throw fail('entries must be an array');
  const claimed = { id: new Set<unknown>(), package: new Set<unknown>() };
  return raw.entries.map((item: unknown, index) => {
    const label = `entry ${String(index)}`;
    if (!isPlainObject(item)) throw fail(`${label} must be an object`);
    const keys = Object.keys(item);
    if (keys.length !== FIELD_NAMES.length || !FIELD_NAMES.every((key) => keys.includes(key)))
      throw fail(`${label} key set must be exactly ${FIELD_NAMES.join(', ')}`);
    for (const key of FIELD_NAMES)
      if (FIELD_RULES[key]?.(item[key]) !== true) throw fail(`${label} field ${key} is invalid`);
    for (const key of ['id', 'package'] as const) {
      if (claimed[key].has(item[key])) throw fail(`${label} repeats ${key}`);
      claimed[key].add(item[key]);
    }
    return item as unknown as CatalogEntry;
  });
}

/** Read and shape-check the image plugin catalog; errors name the path and position, never content. */
export function readPluginCatalog(path = DEFAULT_CATALOG_PATH): PluginCatalog {
  const fail = (detail: string) => new Error(`Plugin catalog ${path} ${detail}`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : 'unknown';
    throw fail(`cannot be read (${code})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw fail('is not JSON');
  }
  return { entries: parseEntries(raw, fail) };
}

/** Effective administrator state per catalog entry; ids absent from the catalog are ignored. */
export function catalogStates(
  catalog: PluginCatalog,
  settings: Pick<Settings, 'pluginCatalog'>,
): CatalogEntryState[] {
  return catalog.entries.map((entry) => {
    if (entry.category === 'required') return { ...entry, state: 'forced-on' };
    const stored = Object.hasOwn(settings.pluginCatalog, entry.id)
      ? settings.pluginCatalog[entry.id]
      : undefined;
    return { ...entry, state: stored ?? 'employee' };
  });
}

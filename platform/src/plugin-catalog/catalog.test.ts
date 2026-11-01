import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_STATES, catalogStates, readPluginCatalog } from './index.ts';

const REPOSITORY_CATALOG = new URL('../../../images/dsh-user/catalog.json', import.meta.url);
const SENTINEL = 'CATALOG_CONTENT_SENTINEL';
const entry = (id: string, category: 'required' | 'manageable' = 'manageable') => ({
  id,
  package: `@${SENTINEL}/${id}`,
  name: `${SENTINEL} ${id}`,
  category,
  imageDefaultEnabled: true,
});
const VALID = { version: 1, entries: [entry('alpha'), entry('beta', 'required')] };
const withEntry = (change: Record<string, unknown>, drop?: string) => {
  const first: Record<string, unknown> = { ...entry('alpha'), ...change };
  if (drop !== undefined) Reflect.deleteProperty(first, drop);
  return { version: 1, entries: [first, VALID.entries[1]] };
};

describe('readPluginCatalog', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-catalog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (content: string) => {
    const path = join(dir, 'catalog.json');
    writeFileSync(path, content);
    return path;
  };

  it('reads the image catalog from the module-relative default path in file order', () => {
    const shipped = JSON.parse(readFileSync(REPOSITORY_CATALOG, 'utf8')) as {
      entries: unknown[];
    };

    const catalog = readPluginCatalog();

    expect(catalog.entries.map(({ id }) => id)).toEqual([
      'office-agents',
      'permission-tiers',
      'platform-nav',
      'zh-locale',
    ]);
    expect(catalog.entries).toEqual(shipped.entries);
    expect(readPluginCatalog(REPOSITORY_CATALOG.pathname)).toEqual(catalog);
  });

  it('reads a valid catalog from an explicit path', () => {
    expect(readPluginCatalog(write(JSON.stringify(VALID)))).toEqual({ entries: VALID.entries });
  });

  it('names only the path when the catalog file is missing', () => {
    const path = join(dir, 'absent.json');
    expect(() => readPluginCatalog(path)).toThrow(`Plugin catalog ${path} cannot be read`);
  });

  it.each([
    ['non-JSON', `{"${SENTINEL}":`, 'is not JSON'],
    ['an array', `["${SENTINEL}"]`, 'must be an object'],
    ['version 2', JSON.stringify({ ...VALID, version: 2 }), 'version must be 1'],
    ['an unknown top-level key', JSON.stringify({ ...VALID, [SENTINEL]: 1 }), 'unknown key'],
    ['non-array entries', JSON.stringify({ version: 1, entries: SENTINEL }), 'entries'],
    ['a non-object entry', JSON.stringify({ version: 1, entries: [SENTINEL] }), 'entry 0'],
    ['a missing key', JSON.stringify(withEntry({}, 'imageDefaultEnabled')), 'entry 0 key'],
    ['an extra key', JSON.stringify(withEntry({ [SENTINEL]: true })), 'entry 0 key'],
    ['a malformed id', JSON.stringify(withEntry({ id: `${SENTINEL}!` })), 'entry 0 field id'],
    ['an empty package', JSON.stringify(withEntry({ package: '' })), 'entry 0 field package'],
    ['a blank name', JSON.stringify(withEntry({ name: '  ' })), 'entry 0 field name'],
    ['an open category', JSON.stringify(withEntry({ category: SENTINEL })), 'field category'],
    [
      'a string default',
      JSON.stringify(withEntry({ imageDefaultEnabled: 'true' })),
      'field imageDefaultEnabled',
    ],
    ['a duplicate id', JSON.stringify(withEntry({ id: 'beta' })), 'entry 1 repeats id'],
    [
      'a duplicate package',
      JSON.stringify(withEntry({ package: VALID.entries[1]?.package })),
      'entry 1 repeats package',
    ],
  ])('rejects %s without echoing file contents', (_label, content, message) => {
    const path = write(content);
    let error: unknown;
    try {
      readPluginCatalog(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`Plugin catalog ${path}`);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain(SENTINEL);
  });
});

describe('catalogStates', () => {
  const catalog = {
    entries: [entry('alpha'), entry('beta', 'required'), entry('constructor'), entry('gamma')],
  };

  it('forces required entries on, reads stored manageable states and defaults the rest to employee', () => {
    const states = catalogStates(catalog, {
      pluginCatalog: { alpha: 'forced-off', beta: 'forced-off', retired: 'forced-on' },
    });

    expect(states).toEqual([
      { ...catalog.entries[0], state: 'forced-off' },
      { ...catalog.entries[1], state: 'forced-on' },
      { ...catalog.entries[2], state: 'employee' },
      { ...catalog.entries[3], state: 'employee' },
    ]);
  });

  it('exposes the closed frozen state set', () => {
    expect(CATALOG_STATES).toEqual(['employee', 'forced-on', 'forced-off']);
    expect(Object.isFrozen(CATALOG_STATES)).toBe(true);
  });
});

import { ok } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CatalogEntryState } from '../plugin-catalog/index.ts';
import { generateManagedConfig } from './index.ts';
import type { ManagedConfigInput } from './index.ts';

const PRESET_NAME = '@deepseek-ai/dsh-agent-preset';
const WEB_TOOL = '@deepseek-ai/dsh-tool-web';
const DSH_DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'];
const LOCALE_ROW = { insert: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }] };

function entry(
  id: string,
  category: CatalogEntryState['category'],
  state: CatalogEntryState['state'],
): CatalogEntryState {
  return { id, package: `@dsh-team/${id}`, name: id, category, imageDefaultEnabled: true, state };
}

const REQUIRED = entry('platform-nav', 'required', 'forced-on');

/** A canonical bundle preset carrying web tools at top level and in a nested group. */
function bundlePreset(id: string, webTools: boolean) {
  const web = webTools ? [{ id: 'renamed-web', name: WEB_TOOL }] : [];
  const nestedWeb = webTools ? [{ id: 'nested-web', name: WEB_TOOL }] : [];
  return {
    id: `preset-${id}`,
    name: PRESET_NAME,
    disabled: false,
    config: {
      id,
      plugins: [
        {
          id: 'skill-filesystem',
          name: '@deepseek-ai/dsh-skill-filesystem',
          config: {
            customSkillDirs: [{ __jsExpr: "require('node:path').join(baseUrl, 'skills')" }],
          },
        },
        ...web,
        {
          id: 'planning',
          name: 'cordis:group',
          group: true,
          config: [...nestedWeb, { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }],
        },
      ],
    },
  };
}

function officePatch(webTools: boolean): ManagedConfigInput['bundles'][number]['patch'] {
  return [
    { id: 'agent-preset-registry', config: { default: 'office-general' } },
    { insert: [bundlePreset('office-general', webTools), bundlePreset('office-writer', webTools)] },
  ];
}

const STANDARD: ManagedConfigInput['presets'][number] = {
  id: 'preset-standard',
  name: PRESET_NAME,
  config: {
    id: 'standard',
    plugins: [
      { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' },
      { id: 'tool-web', name: WEB_TOOL },
      {
        id: 'delegation',
        name: 'cordis:group',
        group: true,
        config: [{ id: 'web-fetch', name: WEB_TOOL }],
      },
    ],
  },
};

const BASE: ManagedConfigInput = {
  admin: false,
  instanceAddress: '172.30.0.2',
  modelSettings: {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DMXAPI_KEY',
    apiKeyConfigured: true,
    models: [{ name: 'alpha' }],
    defaultModel: 'alpha',
  },
  defaultPermissionTier: 'approval',
  presets: [STANDARD],
  localePatch: [LOCALE_ROW],
  webToolsEnabled: false,
  pluginRegistries: DSH_DEFAULT_REGISTRIES,
  registryProbeEnabled: true,
  pluginCatalog: [REQUIRED],
  bundles: [],
};

function content(input: ManagedConfigInput): string {
  const generated = generateManagedConfig(input);
  ok(generated.outcome === 'configured');
  return generated.content;
}

function rows(input: ManagedConfigInput): unknown[] {
  const parsed: unknown = JSON.parse(content(input));
  ok(Array.isArray(parsed));
  return parsed;
}

const hasId = (id: string) => (row: unknown) =>
  typeof row === 'object' && row !== null && 'id' in row && row.id === id;

/** Rows written between the canonical locale rows and the plugin source row: the catalog rows. */
function catalogSegment(input: ManagedConfigInput): unknown[] {
  const all = rows(input);
  const start = all.findIndex((row) => isDeepStrictEqual(row, LOCALE_ROW)) + 1;
  return all.slice(start, all.findIndex(hasId('plugin-manager')));
}

function forced(state: 'forced-on' | 'forced-off', present: boolean): ManagedConfigInput {
  return {
    ...BASE,
    presets: present
      ? [STANDARD, bundlePreset('office-general', true), bundlePreset('office-writer', true)]
      : [STANDARD],
    pluginCatalog: [REQUIRED, entry('office-agents', 'manageable', state)],
    bundles: [{ id: 'office-agents', patch: officePatch(true), present }],
  };
}

const FORCED_OFF_ROWS = [
  { id: 'agent-preset-registry', config: { default: 'standard' } },
  { id: 'preset-office-general', disabled: true },
  { id: 'preset-office-writer', disabled: true },
];

describe('generateManagedConfig web tools switch', () => {
  it.each([
    [false, []],
    [true, ['web-fetch']],
  ])(
    'with web tools enabled=%s keeps the nested tools %j and the plugin manager without mutating input',
    (webToolsEnabled, nested) => {
      const input = { ...BASE, webToolsEnabled };
      const snapshot = structuredClone(input);

      const all = rows(input);
      const standard = all.find(hasId('preset-standard'));

      expect(input).toEqual(snapshot);
      expect(standard).toEqual({
        ...STANDARD,
        config: {
          id: 'standard',
          plugins: [
            { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' },
            ...(webToolsEnabled ? [{ id: 'tool-web', name: WEB_TOOL }] : []),
            {
              id: 'delegation',
              name: 'cordis:group',
              group: true,
              config: nested.map((id) => ({ id, name: WEB_TOOL })),
            },
          ],
        },
      });
      expect(all.filter(hasId('tool-web'))).toEqual(
        webToolsEnabled ? [] : [{ id: 'tool-web', disabled: true }],
      );
    },
  );
});

describe('generateManagedConfig plugin sources', () => {
  it('writes the DSH default sources with the probe on for initial settings', () => {
    const all = rows(BASE);

    expect(all.filter(hasId('plugin-manager'))).toEqual([
      {
        id: 'plugin-manager',
        config: {
          registry: 'https://registry.npmjs.org/',
          fallbackRegistries: ['https://registry.npmmirror.com/'],
        },
      },
    ]);
    expect(all.filter(hasId('ui-plugin-manager'))).toEqual([
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: true } },
    ]);
    expect(JSON.stringify(all.find(hasId('preset-standard')))).toContain('tool-plugin-manager');
  });

  it('writes exactly two intranet sources in order with the probe off', () => {
    const all = rows({
      ...BASE,
      pluginRegistries: ['http://npm-b.intranet:4873/', 'http://npm-a.intranet:4873/'],
      registryProbeEnabled: false,
    });

    expect(all.filter(hasId('plugin-manager'))).toEqual([
      {
        id: 'plugin-manager',
        config: {
          registry: 'http://npm-b.intranet:4873/',
          fallbackRegistries: ['http://npm-a.intranet:4873/'],
        },
      },
    ]);
    expect(all.filter(hasId('ui-plugin-manager'))).toEqual([
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: false } },
    ]);
    expect(JSON.stringify(all.find(hasId('preset-standard')))).toContain('tool-plugin-manager');
  });

  it('splits [A, B, C] into registry A and fallbacks [B, C] without normalising values', () => {
    const registries = ['http://A.intranet/npm', 'https://u:p@b.intranet', 'http://c.intranet//'];

    expect(rows({ ...BASE, pluginRegistries: registries }).filter(hasId('plugin-manager'))).toEqual(
      [
        {
          id: 'plugin-manager',
          config: { registry: registries[0], fallbackRegistries: registries.slice(1) },
        },
      ],
    );
  });

  it('rejects an empty source list', () => {
    expect(() => generateManagedConfig({ ...BASE, pluginRegistries: [] })).toThrow(TypeError);
  });

  it.each([
    ['webToolsEnabled', undefined],
    ['webToolsEnabled', 'false'],
    ['registryProbeEnabled', undefined],
    ['registryProbeEnabled', 1],
    ['pluginRegistries', undefined],
  ])('rejects %s=%j from untyped callers', (key, value) => {
    const malformed = { ...BASE, [key]: value };

    expect(() => generateManagedConfig(malformed)).toThrow(TypeError);
  });
});

describe('generateManagedConfig plugin catalog', () => {
  it.each(['employee', 'forced-off'] as const)('rejects a required entry in state %s', (state) => {
    const input = { ...BASE, pluginCatalog: [entry('platform-nav', 'required', state)] };

    expect(() => generateManagedConfig(input)).toThrow(TypeError);
  });

  it('writes no row for an employee entry and keeps its observed presets whole', () => {
    const observed = bundlePreset('office-general', true);
    const input = {
      ...BASE,
      presets: [STANDARD, observed],
      pluginCatalog: [REQUIRED, entry('office-agents', 'manageable', 'employee')],
    };

    const document = content(input);

    expect(document).toBe(content({ ...input, pluginCatalog: [REQUIRED] }));
    expect(catalogSegment(input)).toEqual([]);
    // The observed preset passes through the ordinary web tool filter, nothing else.
    expect(rows(input).filter(hasId('preset-office-general'))).toEqual([
      bundlePreset('office-general', false),
    ]);
  });

  it('enables every inserted row of a forced-on bundle that is present', () => {
    expect(catalogSegment(forced('forced-on', true))).toEqual([
      { id: 'preset-office-general', disabled: false },
      { id: 'preset-office-writer', disabled: false },
    ]);
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    'writes every canonical row of an absent forced-on bundle in order (web tools enabled=%s keeps them %s)',
    (webToolsEnabled, kept) => {
      const segment = catalogSegment({ ...forced('forced-on', false), webToolsEnabled });

      expect(segment).toEqual(officePatch(kept));
    },
  );

  it.each([true, false])(
    'disables a forced-off bundle and restores the release default preset when present=%s',
    (present) => {
      const input = forced('forced-off', present);

      const all = rows(input);

      expect(catalogSegment(input)).toEqual(FORCED_OFF_ROWS);
      expect(all.filter(hasId('preset-office-general'))).toEqual([FORCED_OFF_ROWS[1]]);
      expect(all.filter(hasId('preset-office-writer'))).toEqual([FORCED_OFF_ROWS[2]]);
    },
  );

  it('writes the same forced-off overlay whether or not the bundle is present', () => {
    expect(content(forced('forced-off', true))).toBe(content(forced('forced-off', false)));
  });

  it('writes required, employee, forced-on and forced-off entries from one catalog', () => {
    const insert = (id: string) => ({ insert: [bundlePreset(id, false)] });
    const input: ManagedConfigInput = {
      ...BASE,
      presets: [
        STANDARD,
        bundlePreset('alpha', false),
        bundlePreset('beta', false),
        bundlePreset('gamma', false),
      ],
      pluginCatalog: [
        REQUIRED,
        entry('alpha', 'manageable', 'employee'),
        entry('beta', 'manageable', 'forced-on'),
        entry('gamma', 'manageable', 'forced-off'),
      ],
      bundles: [
        { id: 'beta', patch: [insert('beta')], present: true },
        {
          id: 'gamma',
          patch: [{ id: 'agent-preset-registry', config: { default: 'gamma' } }, insert('gamma')],
          present: true,
        },
      ],
    };

    const all = rows(input);

    expect(catalogSegment(input)).toEqual([
      { id: 'preset-beta', disabled: false },
      { id: 'agent-preset-registry', config: { default: 'standard' } },
      { id: 'preset-gamma', disabled: true },
    ]);
    expect(all.filter(hasId('preset-alpha'))).toEqual([bundlePreset('alpha', false)]);
    expect(all.filter(hasId('preset-beta'))).toEqual([
      bundlePreset('beta', false),
      { id: 'preset-beta', disabled: false },
    ]);
    expect(all.filter(hasId('preset-gamma'))).toEqual([{ id: 'preset-gamma', disabled: true }]);
  });

  it.each(['forced-on', 'forced-off'] as const)(
    'rejects a %s entry whose canonical patch is empty or missing',
    (state) => {
      const input = forced(state, false);

      expect(() =>
        generateManagedConfig({
          ...input,
          bundles: [{ id: 'office-agents', patch: [], present: false }],
        }),
      ).toThrow(TypeError);
      expect(() => generateManagedConfig({ ...input, bundles: [] })).toThrow(TypeError);
    },
  );

  it('rejects a forced-off canonical patch that overrides a row other than the preset registry', () => {
    const input = forced('forced-off', true);
    const patch = [{ id: 'tool-fs', config: {} }, ...officePatch(true).slice(1)];

    expect(() =>
      generateManagedConfig({ ...input, bundles: [{ id: 'office-agents', patch, present: true }] }),
    ).toThrow(TypeError);
  });

  it('generates byte-identical catalog overlays for identical input', () => {
    const input = forced('forced-on', false);

    expect(content(structuredClone(input))).toBe(content(input));
  });

  it('orders locale, catalog, plugin source, probe and auto-review rows', () => {
    const all = rows(forced('forced-on', true));
    const source = all.findIndex(hasId('plugin-manager'));

    expect(all.slice(source - 3, source + 3)).toEqual([
      LOCALE_ROW,
      { id: 'preset-office-general', disabled: false },
      { id: 'preset-office-writer', disabled: false },
      all[source],
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: true } },
      { id: 'auto-review', disabled: true },
    ]);
  });
});

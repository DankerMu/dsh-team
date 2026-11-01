import { describe, expect, it } from 'vitest';
import { readManagedComposition } from './index.ts';
import type { ManagedComposition, ManagedConfigInput } from './index.ts';

const PRESET_NAME = '@deepseek-ai/dsh-agent-preset';
const SECRET = 'sk-injected-credential';
const protoKey = '__proto__';

const ROOT_PRESET: ManagedConfigInput['presets'][number] = {
  id: 'preset-root-writer',
  name: PRESET_NAME,
  config: {
    id: 'writer',
    title: 'Root writer',
    plugins: [{ id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }],
  },
};

const GROUPED_PRESET = {
  id: 'preset-grouped-brief',
  name: PRESET_NAME,
  [protoKey]: 'brief-own-meta',
  config: {
    id: 'brief',
    greeting: { __jsExpr: 'ctx.locale.tag' },
    plugins: [
      { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: {
          lookalike: [{ id: 'preset-lookalike', name: PRESET_NAME, config: { plugins: [] } }],
        },
      },
    ],
  },
};

const CANONICAL_LOCALE_PATCH: ManagedConfigInput['localePatch'] = [
  { id: 'ui-settings-models', disabled: true },
  { insert: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }] },
];

function completeObservation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    skippedBundles: [],
    entries: [ROOT_PRESET],
    localePatch: CANONICAL_LOCALE_PATCH,
    bundles: [],
    ...overrides,
  });
}

const INVALID = 'Invalid managed composition';

async function expectInvalid(raw: string, bundleIds: readonly string[] = []): Promise<void> {
  await expect(readManagedComposition(() => Promise.resolve(raw), bundleIds)).rejects.toThrow(
    INVALID,
  );
}

function officePreset(id: string) {
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
          config: { customSkillDirs: [{ __jsExpr: "require('node:path').join(baseUrl, 'x')" }] },
        },
      ],
    },
  };
}

const OFFICE_PATCH: ManagedConfigInput['bundles'][number]['patch'] = [
  { id: 'agent-preset-registry', config: { default: 'office-general' } },
  { insert: [officePreset('office-general'), officePreset('office-writer')] },
];

function bundleObservation(entries: readonly unknown[], patch: unknown = OFFICE_PATCH): string {
  return completeObservation({
    entries: [ROOT_PRESET, ...entries],
    bundles: [{ id: 'office-agents', patch }],
  });
}

describe('readManagedComposition', () => {
  it('rejects a skipped bundle even when presets and canonical locale rows are otherwise complete', async () => {
    const observation = completeObservation({
      skippedBundles: [{ packageName: '@deepseek-ai/dsh-base', reason: 'unreadable bundle' }],
      entries: [ROOT_PRESET],
    });

    await expect(readManagedComposition(() => Promise.resolve(observation), [])).rejects.toThrow();
  });

  it.each([
    ['malformed JSON', `{skippedBundles:[],entries:[${SECRET}`],
    ['truncated JSON', '{"skippedBundles":[],"entries":['],
    ['empty payload', ''],
    ['non-object envelope', '[]'],
    ['null envelope', 'null'],
    [
      'missing skippedBundles',
      JSON.stringify({ entries: [ROOT_PRESET], localePatch: CANONICAL_LOCALE_PATCH }),
    ],
    [
      'missing entries',
      JSON.stringify({ skippedBundles: [], localePatch: CANONICAL_LOCALE_PATCH }),
    ],
    ['missing localePatch', JSON.stringify({ skippedBundles: [], entries: [ROOT_PRESET] })],
    [
      'empty preset inventory',
      completeObservation({ entries: [{ id: 'webserver', config: { host: '172.30.0.2' } }] }),
    ],
    ['empty localePatch', completeObservation({ localePatch: [] })],
    ['non-object locale row', completeObservation({ localePatch: ['zh'] })],
    [
      'malformed group config',
      completeObservation({
        entries: [{ id: 'office-group', group: true, config: { id: 'not-entries' } }, ROOT_PRESET],
      }),
    ],
    [
      'preset missing plugins',
      completeObservation({
        entries: [{ id: 'preset-broken', name: PRESET_NAME, config: { id: 'broken' } }],
      }),
    ],
    [
      'nested group missing plugin list',
      completeObservation({
        entries: [
          {
            id: 'preset-nested',
            name: PRESET_NAME,
            config: {
              id: 'nested',
              plugins: [
                { id: 'planning', name: 'cordis:group', group: true, config: { id: 'not-list' } },
              ],
            },
          },
        ],
      }),
    ],
    [
      'preset missing config.id',
      completeObservation({
        entries: [
          {
            id: 'preset-no-config-id',
            name: PRESET_NAME,
            config: { plugins: [{ id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }] },
          },
        ],
      }),
    ],
    [
      'child plugin missing nonempty name',
      completeObservation({
        entries: [
          {
            id: 'preset-unnamed-child',
            name: PRESET_NAME,
            config: {
              id: 'unnamed',
              plugins: [
                { id: 'planning', name: 'cordis:group', group: true, config: [{ id: 'fs' }] },
              ],
            },
          },
        ],
      }),
    ],
  ])('rejects %s', async (_label, raw) => {
    await expectInvalid(raw);
  });

  it('rejects duplicate targeted host ids rather than compose the later row', async () => {
    await expectInvalid(
      completeObservation({
        entries: [
          ROOT_PRESET,
          {
            id: 'desk-group',
            name: 'cordis:group',
            group: true,
            config: [{ ...ROOT_PRESET, id: 'preset-root-writer' }],
          },
        ],
      }),
    );
  });

  it('rejects executor failures without echoing credential-bearing diagnostics', async () => {
    try {
      await readManagedComposition(() => Promise.reject(new Error(`docker: ${SECRET}`)), []);
      throw new Error('must reject executor failure');
    } catch (error) {
      expect(error).toMatchObject({ message: INVALID });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it('projects only nested host-group presets in document order and ignores plugin-owned lookalikes', async () => {
    const observation = completeObservation({
      entries: [
        { id: 'webserver', config: { host: '172.30.0.2', port: 3080 } },
        ROOT_PRESET,
        { id: 'desk-group', name: 'cordis:group', group: true, config: [GROUPED_PRESET] },
      ],
    });

    const composition: ManagedComposition = await readManagedComposition(
      () => Promise.resolve(observation),
      [],
    );

    expect(composition.presets.map((preset) => preset.id)).toEqual([
      'preset-root-writer',
      'preset-grouped-brief',
    ]);
    expect(composition.presets[0]).toEqual(ROOT_PRESET);
    expect(composition.presets[1]).toEqual(GROUPED_PRESET);
    expect(composition.localePatch).toEqual(CANONICAL_LOCALE_PATCH);
    expect(composition.bundles).toEqual([]);
  });

  it.each([
    [[], 'const BUNDLE_IDS = [];'],
    [['office-agents'], 'const BUNDLE_IDS = ["office-agents"];'],
  ])('asks the image to read only the requested bundles %j', async (bundleIds, line) => {
    const scripts: string[] = [];
    const bundles = bundleIds.map((id) => ({ id, patch: [] }));

    await readManagedComposition((script) => {
      scripts.push(script);
      return Promise.resolve(completeObservation({ bundles }));
    }, bundleIds);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(line);
    // String and list `dsh.bundle.patch` forms both go through DSH's own resolver, in order.
    expect(scripts[0]).toContain('bundlePatchPaths(directory, manifest.dsh?.bundle)');
    expect(scripts[0]).toContain("'/opt/dsh-team/' + id");
    expect(scripts[0]).not.toContain('bundle.patch');
  });

  it.each([
    ['present', [officePreset('office-general'), officePreset('office-writer')], true],
    ['absent', [], false],
  ])(
    'projects a requested %s bundle with its canonical patch unchanged',
    async (_label, observed, present) => {
      const composition = await readManagedComposition(
        () => Promise.resolve(bundleObservation(observed)),
        ['office-agents'],
      );

      expect(composition.bundles).toEqual([{ id: 'office-agents', patch: OFFICE_PATCH, present }]);
      expect(JSON.stringify(composition.bundles)).toContain('{"__jsExpr":');
    },
  );

  it('reports an empty canonical patch as absent', async () => {
    const composition = await readManagedComposition(
      () => Promise.resolve(bundleObservation([], [])),
      ['office-agents'],
    );

    expect(composition.bundles).toEqual([{ id: 'office-agents', patch: [], present: false }]);
  });

  it.each([
    ['a partially present bundle', bundleObservation([officePreset('office-general')])],
    ['a non-array patch', bundleObservation([], { insert: [] })],
    ['a non-object patch row', bundleObservation([], ['row'])],
    ['an insert list that is not an array', bundleObservation([], [{ insert: {} }])],
    ['an inserted row without an id', bundleObservation([], [{ insert: [{ name: 'x' }] }])],
    [
      'an inserted preset without plugins',
      bundleObservation([], [{ insert: [{ id: 'p', name: PRESET_NAME, config: { id: 'p' } }] }]),
    ],
    ['missing bundles', completeObservation({ bundles: undefined })],
    ['a missing requested bundle', completeObservation()],
    ['a different bundle id', completeObservation({ bundles: [{ id: 'other', patch: [] }] })],
  ])('rejects %s', async (_label, raw) => {
    await expectInvalid(raw, ['office-agents']);
  });

  it('rejects a bundle that was not requested', async () => {
    await expectInvalid(bundleObservation([]), []);
  });
});

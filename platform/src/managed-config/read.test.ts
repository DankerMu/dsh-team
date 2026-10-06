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
    ...overrides,
  });
}

const INVALID = 'Invalid managed composition';

async function expectInvalid(raw: string): Promise<void> {
  await expect(readManagedComposition(() => Promise.resolve(raw))).rejects.toThrow(INVALID);
}

describe('readManagedComposition', () => {
  it('rejects a skipped bundle even when presets and canonical locale rows are otherwise complete', async () => {
    const observation = completeObservation({
      skippedBundles: [{ packageName: '@deepseek-ai/dsh-base', reason: 'unreadable bundle' }],
      entries: [ROOT_PRESET],
    });

    await expect(readManagedComposition(() => Promise.resolve(observation))).rejects.toThrow();
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
      completeObservation({ entries: [{ id: 'webserver', config: { host: '0.0.0.0' } }] }),
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
      await readManagedComposition(() => Promise.reject(new Error(`docker: ${SECRET}`)));
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
        { id: 'webserver', config: { host: '0.0.0.0', port: 3080 } },
        ROOT_PRESET,
        { id: 'desk-group', name: 'cordis:group', group: true, config: [GROUPED_PRESET] },
      ],
    });

    const composition: ManagedComposition = await readManagedComposition(() =>
      Promise.resolve(observation),
    );

    expect(composition.presets.map((preset) => preset.id)).toEqual([
      'preset-root-writer',
      'preset-grouped-brief',
    ]);
    expect(composition.presets[0]).toEqual(ROOT_PRESET);
    expect(composition.presets[1]).toEqual(GROUPED_PRESET);
    expect(composition.localePatch).toEqual(CANONICAL_LOCALE_PATCH);
  });
});

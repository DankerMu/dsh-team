import { ok, throws } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { generateManagedConfig } from './index.ts';
import type { ManagedConfigInput } from './index.ts';

const INPUT: ManagedConfigInput = {
  modelSettings: {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DMXAPI_KEY',
    apiKeyConfigured: true,
    models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
    defaultModel: 'beta',
  },
  defaultPermissionTier: 'yolo',
  presets: [
    {
      id: 'preset-office',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'office',
        order: 1,
        plugins: [
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
          {
            id: 'planning',
            name: 'cordis:group',
            group: true,
            config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }],
          },
          { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
        ],
      },
    },
  ],
  localePatch: [
    { id: 'ui-settings-models', disabled: true },
    { insert: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }] },
  ],
};

const EXPECTED_MODEL_ROWS = [
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        intranet: {
          displayName: '内网模型',
          apiKeyEnv: 'DMXAPI_KEY',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [
            { id: 'alpha', name: 'alpha', contextWindow: 500000 },
            { id: 'beta', name: 'beta' },
          ],
        },
      },
    },
  },
  {
    id: 'agent-default-model',
    config: {
      provider: 'intranet',
      model: 'beta',
    },
  },
];

function rowsWithIds(document: string, ids: readonly string[]): unknown[] {
  const overlay: unknown = JSON.parse(document);
  if (!Array.isArray(overlay)) {
    return [];
  }
  return overlay.filter((row: unknown) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return false;
    }
    return ids.includes('id' in row ? String(row.id) : '');
  });
}

const NETWORK_POLICY_INPUT: ManagedConfigInput = {
  ...INPUT,
  presets: [
    {
      id: 'preset-ledger',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'ledger',
        order: 7,
        description: 'Keep this metadata',
        plugins: [
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { sample: true } },
          {
            id: 'renamed-web',
            name: '@deepseek-ai/dsh-tool-web',
            config: { fetch: true, searchTimeoutMs: 60000 },
          },
          { id: 'tool-web', name: '@deepseek-ai/dsh-tool-present' },
          {
            id: 'planning',
            name: 'cordis:group',
            group: true,
            isolate: { planMode: true },
            config: [
              { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
              { id: 'nested-web', name: '@deepseek-ai/dsh-tool-web' },
              { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
            ],
          },
          {
            id: 'persona',
            name: '@deepseek-ai/dsh-persona',
            config: {
              prefix: 'Keep plugin-owned JSON',
              lookalike: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }],
            },
          },
        ],
      },
    },
    {
      id: 'preset-custom-office',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'custom-office',
        order: 9,
        plugins: [
          { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
          { id: 'web-fetch', name: '@deepseek-ai/dsh-tool-web' },
          { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
        ],
      },
    },
  ],
};

const EXPECTED_NETWORK_POLICY_ROWS = [
  {
    id: 'preset-ledger',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'ledger',
      order: 7,
      description: 'Keep this metadata',
      plugins: [
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { sample: true } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-present' },
        {
          id: 'planning',
          name: 'cordis:group',
          group: true,
          isolate: { planMode: true },
          config: [
            { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
            { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
          ],
        },
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: {
            prefix: 'Keep plugin-owned JSON',
            lookalike: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }],
          },
        },
      ],
    },
  },
  {
    id: 'preset-custom-office',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'custom-office',
      order: 9,
      plugins: [
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      ],
    },
  },
];

describe('generateManagedConfig', () => {
  it('writes two intranet models with one contextWindow and credential reference only', () => {
    const generated = generateManagedConfig(INPUT);
    ok(generated.outcome === 'configured');

    expect(rowsWithIds(generated.content, ['llm-pi-ai', 'agent-default-model'])).toEqual(
      EXPECTED_MODEL_ROWS,
    );
  });

  it('keeps quote newline YAML-looking model scalars as JSON data without extra secret fields', () => {
    const quoted = 'alpha "quoted"\n- id: leaked';
    const input = {
      ...INPUT,
      modelSettings: Object.freeze({
        baseURL: 'http://127.0.0.1:9/v1?q="x"\\y',
        apiKeyEnv: 'DMXAPI_KEY',
        apiKeyConfigured: true,
        apiKey: 'sk-not-a-credential',
        models: Object.freeze([
          Object.freeze({ name: quoted, contextWindow: 500000 }),
          Object.freeze({ name: 'beta' }),
        ]),
        defaultModel: quoted,
      }),
    };
    const snapshot = structuredClone(input);

    const generated = generateManagedConfig(input);
    ok(generated.outcome === 'configured');
    const overlay: unknown = JSON.parse(generated.content);
    const text = JSON.stringify(overlay);

    expect(input).toEqual(snapshot);
    expect(text.includes('sk-not-a-credential')).toBe(false);
    expect(rowsWithIds(JSON.stringify(overlay), ['llm-pi-ai', 'agent-default-model'])).toEqual([
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            intranet: {
              displayName: '内网模型',
              apiKeyEnv: 'DMXAPI_KEY',
              api: 'openai-completions',
              baseURL: 'http://127.0.0.1:9/v1?q="x"\\y',
              models: [
                { id: quoted, name: quoted, contextWindow: 500000 },
                { id: 'beta', name: 'beta' },
              ],
            },
          },
        },
      },
      { id: 'agent-default-model', config: { provider: 'intranet', model: quoted } },
    ]);
  });

  it('removes renamed nested network tools from every supplied preset without mutating input', () => {
    const snapshot = structuredClone(NETWORK_POLICY_INPUT);

    const generated = generateManagedConfig(NETWORK_POLICY_INPUT);
    ok(generated.outcome === 'configured');

    expect(NETWORK_POLICY_INPUT).toEqual(snapshot);
    expect(rowsWithIds(generated.content, ['preset-ledger', 'preset-custom-office'])).toEqual(
      EXPECTED_NETWORK_POLICY_ROWS,
    );
  });

  it('preserves own __proto__ metadata on a transformed group preset', () => {
    const protoKey = '__proto__';
    const group = {
      id: 'planning',
      name: 'cordis:group',
      group: true as const,
      [protoKey]: 'own-group-meta',
      config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
        { id: 'nested-web', name: '@deepseek-ai/dsh-tool-web' },
      ],
    };
    const preset = {
      id: 'preset-proto',
      name: '@deepseek-ai/dsh-agent-preset',
      [protoKey]: 'own-preset-meta',
      config: {
        id: 'proto',
        plugins: [group, { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }],
      },
    };
    const snapshot = structuredClone({ ...INPUT, presets: [preset] });

    const generated = generateManagedConfig({ ...INPUT, presets: [preset] });
    ok(generated.outcome === 'configured');

    expect({ ...INPUT, presets: [preset] }).toEqual(snapshot);
    expect(rowsWithIds(generated.content, ['preset-proto'])).toEqual([
      {
        id: 'preset-proto',
        name: '@deepseek-ai/dsh-agent-preset',
        [protoKey]: 'own-preset-meta',
        config: {
          id: 'proto',
          plugins: [
            {
              id: 'planning',
              name: 'cordis:group',
              group: true,
              [protoKey]: 'own-group-meta',
              config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }],
            },
            { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
          ],
        },
      },
    ]);
  });
  it.each([
    ['approval', 'approval'],
    ['auto', 'auto-review'],
    ['yolo', 'danger-full-access'],
  ] as const)('projects administrator %s into the immutable three-tier catalog', (tier, preset) => {
    const generated = generateManagedConfig({
      ...INPUT,
      defaultPermissionTier: tier,
      localePatch: [
        ...INPUT.localePatch,
        { id: 'permission', disabled: true, config: {} },
        { id: 'agent-loop', disabled: true, inject: [] },
        { id: 'auto-review', disabled: false },
      ],
    });
    ok(generated.outcome === 'configured');

    expect(rowsWithIds(generated.content, ['permission']).at(-1)).toEqual({
      id: 'permission',
      disabled: false,
      config: {
        presets: {
          approval: { sandbox: 'danger-full-access', approval: 'ask', name: '人工批准' },
          'auto-review': { sandbox: 'danger-full-access', approval: 'ask', name: 'Auto' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Yolo' },
        },
        defaultPreset: preset,
      },
    });
    expect(rowsWithIds(generated.content, ['agent-loop']).at(-1)).toEqual({
      id: 'agent-loop',
      disabled: false,
      inject: ['managedPermissions'],
    });
    expect(rowsWithIds(generated.content, ['auto-review']).at(-1)).toEqual({
      id: 'auto-review',
      disabled: true,
    });
  });

  it.each([
    ['empty address', { baseURL: '' }],
    ['unavailable actual key', { apiKeyConfigured: false }],
    ['empty model list', { models: [] }],
    ['empty default model', { defaultModel: '' }],
    ['undefined address', { baseURL: undefined }],
    ['undefined model list', { models: undefined }],
    ['undefined default model', { defaultModel: undefined }],
    ['whitespace address', { baseURL: '   ' }],
    ['whitespace default model', { defaultModel: '\t' }],
    ['empty credential reference', { apiKeyEnv: '' }],
    ['whitespace credential reference', { apiKeyEnv: '  ' }],
  ] as const)(
    'returns unconfigured without a document when %s and the other fields are valid',
    (_label, missing) => {
      const modelSettings = {
        ...INPUT.modelSettings,
        ...missing,
      };

      expect(generateManagedConfig({ ...INPUT, modelSettings })).toStrictEqual({
        outcome: 'unconfigured',
      });
    },
  );

  it('returns unconfigured when address, model list, or default model is omitted', () => {
    const withoutAddress: ManagedConfigInput['modelSettings'] = {
      apiKeyEnv: INPUT.modelSettings.apiKeyEnv,
      apiKeyConfigured: true,
      models: INPUT.modelSettings.models,
      defaultModel: INPUT.modelSettings.defaultModel,
    };
    const withoutModels: ManagedConfigInput['modelSettings'] = {
      baseURL: INPUT.modelSettings.baseURL,
      apiKeyEnv: INPUT.modelSettings.apiKeyEnv,
      apiKeyConfigured: true,
      defaultModel: INPUT.modelSettings.defaultModel,
    };
    const withoutDefault: ManagedConfigInput['modelSettings'] = {
      baseURL: INPUT.modelSettings.baseURL,
      apiKeyEnv: INPUT.modelSettings.apiKeyEnv,
      apiKeyConfigured: true,
      models: INPUT.modelSettings.models,
    };

    expect(generateManagedConfig({ ...INPUT, modelSettings: withoutAddress })).toStrictEqual({
      outcome: 'unconfigured',
    });
    expect(generateManagedConfig({ ...INPUT, modelSettings: withoutModels })).toStrictEqual({
      outcome: 'unconfigured',
    });
    expect(generateManagedConfig({ ...INPUT, modelSettings: withoutDefault })).toStrictEqual({
      outcome: 'unconfigured',
    });
  });

  it('keeps surrounding whitespace on configured address, credential reference, and default model scalars', () => {
    const generated = generateManagedConfig({
      ...INPUT,
      modelSettings: {
        ...INPUT.modelSettings,
        baseURL: ' http://127.0.0.1:9/v1 ',
        apiKeyEnv: ' DMXAPI_KEY ',
        defaultModel: ' beta ',
      },
    });
    ok(generated.outcome === 'configured');

    expect(rowsWithIds(generated.content, ['llm-pi-ai', 'agent-default-model'])).toEqual([
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            intranet: {
              displayName: '内网模型',
              apiKeyEnv: ' DMXAPI_KEY ',
              api: 'openai-completions',
              baseURL: ' http://127.0.0.1:9/v1 ',
              models: [
                { id: 'alpha', name: 'alpha', contextWindow: 500000 },
                { id: 'beta', name: 'beta' },
              ],
            },
          },
        },
      },
      { id: 'agent-default-model', config: { provider: 'intranet', model: ' beta ' } },
    ]);
  });

  it('does not compose unconfigured input and propagates configured-path composition errors', () => {
    const compositionError = new Error('preset composition failed');
    const presets: ManagedConfigInput['presets'] = [
      {
        id: 'preset-office',
        get config(): never {
          throw compositionError;
        },
      },
    ];

    expect(
      generateManagedConfig({
        ...INPUT,
        modelSettings: { ...INPUT.modelSettings, baseURL: '' },
        presets,
      }),
    ).toStrictEqual({ outcome: 'unconfigured' });
    throws(
      () => generateManagedConfig({ ...INPUT, presets }),
      (error: unknown) => error === compositionError,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { generateManagedConfig } from './index.ts';
import type { ManagedConfigInput } from './index.ts';

const INPUT: ManagedConfigInput = {
  modelSettings: {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DMXAPI_KEY',
    models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
    defaultModel: 'beta',
  },
  permission: {
    presets: {
      'danger-full-access': {
        sandbox: 'danger-full-access',
        approval: 'never',
        name: 'Yolo',
        description: 'Do not ask before writes or commands',
      },
    },
    defaultPreset: 'danger-full-access',
  },
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
    const document = generateManagedConfig(INPUT);

    expect(rowsWithIds(document, ['llm-pi-ai', 'agent-default-model'])).toEqual(
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
        apiKey: 'sk-not-a-credential',
        models: Object.freeze([
          Object.freeze({ name: quoted, contextWindow: 500000 }),
          Object.freeze({ name: 'beta' }),
        ]),
        defaultModel: quoted,
      }),
    };
    const snapshot = structuredClone(input);

    const overlay: unknown = JSON.parse(generateManagedConfig(input));
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

    const document = generateManagedConfig(NETWORK_POLICY_INPUT);

    expect(NETWORK_POLICY_INPUT).toEqual(snapshot);
    expect(rowsWithIds(document, ['preset-ledger', 'preset-custom-office'])).toEqual(
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

    const document = generateManagedConfig({ ...INPUT, presets: [preset] });

    expect({ ...INPUT, presets: [preset] }).toEqual(snapshot);
    expect(rowsWithIds(document, ['preset-proto'])).toEqual([
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
  it('emits webserver host-web disable permission and canonical locale rows in one document', () => {
    const permission = {
      presets: {
        'workspace-write': {
          sandbox: 'workspace-write' as const,
          approval: 'ask' as const,
          name: '人工批准',
        },
        'danger-full-access': {
          sandbox: 'danger-full-access' as const,
          approval: 'never' as const,
          name: 'Yolo',
        },
      },
      defaultPreset: 'workspace-write',
    };
    const document = generateManagedConfig({ ...INPUT, permission });
    const overlay: unknown = JSON.parse(document);
    const rows = Array.isArray(overlay) ? overlay : [];

    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'webserver', config: { host: '0.0.0.0', port: 3080 } },
        { id: 'tool-web', disabled: true },
        { id: 'permission', config: permission },
        { id: 'ui-settings-models', disabled: true },
        { insert: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }] },
      ]),
    );
  });
});

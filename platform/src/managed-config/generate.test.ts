import { ok, throws } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { generateManagedConfig } from './index.ts';
import type { ManagedConfigInput } from './index.ts';

const INPUT: ManagedConfigInput = {
  admin: false,
  instanceAddress: '172.30.0.2',
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
  webToolsEnabled: false,
  pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  registryProbeEnabled: true,
  pluginCatalog: [],
  bundles: [],
};

const CREDENTIAL_REALM = { credentials: 'dsh-team-platform' };

const PLATFORM_CREDENTIAL_STORE = {
  id: 'dsh-team-platform-credentials',
  name: '@deepseek-ai/dsh-credentials-local',
  disabled: false,
  isolate: CREDENTIAL_REALM,
  config: { path: '/opt/dsh-team/credentials/platform.yaml', dshHome: '/data/home', watch: false },
};

/** The whole managed provider row, bound to the platform credential realm. */
function providerRow(apiKeyEnv: string, baseURL: string, models: readonly unknown[]): unknown {
  return {
    id: 'llm-pi-ai',
    isolate: CREDENTIAL_REALM,
    config: {
      providers: {
        intranet: {
          displayName: '内网模型',
          apiKeyEnv,
          api: 'openai-completions',
          baseURL,
          models,
        },
      },
    },
  };
}

const EXPECTED_MODEL_ROWS = [
  providerRow('DMXAPI_KEY', 'http://127.0.0.1:9/v1', [
    { id: 'alpha', name: 'alpha', contextWindow: 500000 },
    { id: 'beta', name: 'beta' },
  ]),
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
          { id: 'renamed-plugins', name: '@deepseek-ai/dsh-plugin-manager/tools' },
          { id: 'tool-web', name: '@deepseek-ai/dsh-tool-present' },
          {
            id: 'planning',
            name: 'cordis:group',
            group: true,
            isolate: { planMode: true },
            config: [
              { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
              { id: 'nested-web', name: '@deepseek-ai/dsh-tool-web' },
              {
                id: 'nested-plugins',
                name: '@deepseek-ai/dsh-plugin-manager/tools',
                disabled: false,
              },
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
          { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' },
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
        { id: 'renamed-plugins', name: '@deepseek-ai/dsh-plugin-manager/tools' },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-present' },
        {
          id: 'planning',
          name: 'cordis:group',
          group: true,
          isolate: { planMode: true },
          config: [
            { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
            {
              id: 'nested-plugins',
              name: '@deepseek-ai/dsh-plugin-manager/tools',
              disabled: false,
            },
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
        { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      ],
    },
  },
];

// 0.2.1-rc.2 rows that differ from 0.2.0-rc.2, verbatim from the released dsh-web-app
// presets/standard.patch.yml and presets/minimal.patch.yml (ptc/cordis add the same three rows).
const RELEASE_STANDARD_PRESET = {
  id: 'preset-standard',
  name: '@deepseek-ai/dsh-agent-preset',
  config: {
    id: 'standard',
    order: 1,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
      {
        id: 'delegation',
        name: 'cordis:group',
        group: true,
        isolate: { workflowEngine: true },
        config: [
          {
            id: 'tool-subagent',
            name: '@deepseek-ai/dsh-tool-subagent',
            config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
          },
          // Employee edit: the network tool moved into a nested group.
          { id: 'nested-web', name: '@deepseek-ai/dsh-tool-web' },
        ],
      },
      {
        id: 'tool-web',
        name: '@deepseek-ai/dsh-tool-web',
        config: { fetch: true, searchTimeoutMs: 60000 },
      },
      // Employee edit: the network tool under a renamed id.
      { id: 'web-fetch', name: '@deepseek-ai/dsh-tool-web' },
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
      { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
    ],
  },
} as const;

const RELEASE_MINIMAL_PRESET = {
  id: 'preset-minimal',
  name: '@deepseek-ai/dsh-agent-preset',
  config: {
    id: 'minimal',
    order: 3,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs',
        config: { read: false, readImage: true, write: false, edit: false },
      },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
    ],
  },
} as const;

type Disposition = 'retained' | 'removed' | 'absent';

/**
 * Every 0.2.1 row delta (web profile, presets, dsh-base) and its overlay disposition.
 * Profile and dsh-base rows are never generator input: `retained` means the overlay emits no
 * row overriding the released one, `absent` means upstream deleted it and the overlay never
 * re-adds it. Preset rows: `retained` survives unchanged and in order, `removed` is filtered.
 */
const RELEASE_ROW_DISPOSITIONS: readonly (readonly [string, string, Disposition])[] = [
  ['web profile', 'schedule', 'retained'],
  ['web profile', 'harness-dev-context', 'retained'],
  ['web profile', 'ui-secret-mask', 'retained'],
  ['web profile', 'ui-schedule', 'retained'],
  ['web profile', 'ui-deepseek-model-label-1017', 'retained'],
  ['web profile', 'tool-ralph', 'absent'],
  ['dsh-base', 'remote-access', 'retained'],
  ['dsh-base', 'working-directory', 'retained'],
  ['dsh-base', 'tool-working-directory', 'retained'],
  ['dsh-base', 'web-deepseek-api', 'retained'],
  ['dsh-base', 'skill-badge', 'absent'],
  ['preset-standard', 'time-context', 'retained'],
  ['preset-standard', 'tool-schedule', 'retained'],
  ['preset-standard', 'tool-plugin-market', 'retained'],
  ['preset-standard', 'tool-web', 'removed'],
  ['preset-standard', 'nested-web', 'removed'],
  ['preset-standard', 'web-fetch', 'removed'],
  ['preset-standard', 'tool-subagent-codex', 'absent'],
  ['preset-standard', 'tool-subagent-claude-code', 'absent'],
  ['preset-standard', 'tool-ralph', 'absent'],
  ['preset-minimal', 'tool-fs', 'retained'],
  ['preset-minimal', 'compaction', 'retained'],
];

function pluginIds(plugins: readonly unknown[]): string[] {
  return plugins.flatMap((plugin) => {
    ok(typeof plugin === 'object' && plugin !== null && 'id' in plugin);
    const nested =
      'group' in plugin &&
      plugin.group === true &&
      'config' in plugin &&
      Array.isArray(plugin.config)
        ? pluginIds(plugin.config)
        : [];
    return [String(plugin.id), ...nested];
  });
}

describe('generateManagedConfig', () => {
  it('writes two intranet models with one contextWindow and credential reference only', () => {
    const generated = generateManagedConfig(INPUT);
    ok(generated.outcome === 'configured');

    expect(rowsWithIds(generated.content, ['llm-pi-ai', 'agent-default-model'])).toEqual(
      EXPECTED_MODEL_ROWS,
    );
  });

  it.each(['172.30.0.2', '10.1.2.34', '0.0.0.2', '255.255.255.242'])(
    'binds the instance web carrier only to the supplied fixed address %s with DSH gzip compression',
    (instanceAddress) => {
      const generated = generateManagedConfig({ ...INPUT, instanceAddress });
      ok(generated.outcome === 'configured');

      expect(rowsWithIds(generated.content, ['webserver'])).toEqual([
        { id: 'webserver', config: { host: instanceAddress, port: 3080, compression: 'gzip' } },
      ]);
    },
  );

  it.each([
    ['the IPv4 wildcard', '0.0.0.0'],
    ['the IPv6 wildcard', '::'],
    ['an IPv6 address', 'fd00::2'],
    ['a truncated address', '172.30.0'],
    ['surrounding whitespace', ' 172.30.0.2'],
    ['a trailing newline', '172.30.0.2\n'],
    ['a zero-padded octet', '172.030.0.2'],
    ['a hostname', 'instance.invalid'],
    ['an empty value', ''],
    ['a non-+2 address', '172.30.0.5'],
    ['the gateway of a /28', '172.30.0.1'],
    ['the platform address of a /28', '172.30.0.3'],
    ['the +2 of a misaligned block', '172.30.0.10'],
    ['a non-string', 2886729730],
    ['an omitted value', undefined],
  ])(
    'rejects %s as the instance address even when model settings are incomplete',
    (_label, instanceAddress) => {
      const malformed = { ...INPUT, instanceAddress } as unknown as ManagedConfigInput;
      const unconfigured = {
        ...malformed,
        modelSettings: { ...INPUT.modelSettings, baseURL: '' },
      };
      for (const input of [malformed, unconfigured]) {
        expect(() => generateManagedConfig(input)).toThrow(TypeError);
        expect(() => generateManagedConfig(input)).toThrow(
          'Managed overlay instance address must be the fixed container address of an aligned /28',
        );
      }
    },
  );

  it('generates byte-identical overlays for identical input', () => {
    const first = generateManagedConfig(INPUT);
    const second = generateManagedConfig(structuredClone(INPUT));
    ok(first.outcome === 'configured' && second.outcome === 'configured');

    expect(Buffer.from(second.content, 'utf8').equals(Buffer.from(first.content, 'utf8'))).toBe(
      true,
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
      providerRow('DMXAPI_KEY', 'http://127.0.0.1:9/v1?q="x"\\y', [
        { id: quoted, name: quoted, contextWindow: 500000 },
        { id: 'beta', name: 'beta' },
      ]),
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

  it.each([true, false])(
    'writes the administrator registry probe value %s in exactly one whole-config row',
    (registryProbeEnabled) => {
      const generated = generateManagedConfig({ ...INPUT, registryProbeEnabled });
      ok(generated.outcome === 'configured');

      expect(rowsWithIds(generated.content, ['ui-plugin-manager'])).toEqual([
        { id: 'ui-plugin-manager', config: { registryProbeEnabled } },
      ]);
    },
  );

  it('places the source and probe rows after profile and locale rows that try to replace them', () => {
    const reenable = { id: 'ui-plugin-manager', config: { registryProbeEnabled: true } };
    const generated = generateManagedConfig({
      ...INPUT,
      registryProbeEnabled: false,
      localePatch: [...INPUT.localePatch, reenable],
    });
    ok(generated.outcome === 'configured');
    const rows: unknown = JSON.parse(generated.content);
    ok(Array.isArray(rows));
    const probe = rows.findLastIndex(
      (row: unknown) =>
        typeof row === 'object' && row !== null && 'id' in row && row.id === 'ui-plugin-manager',
    );

    expect(rows.slice(probe - 2, probe + 2)).toEqual([
      reenable,
      {
        id: 'plugin-manager',
        config: {
          registry: 'https://registry.npmjs.org/',
          fallbackRegistries: ['https://registry.npmmirror.com/'],
        },
      },
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: false } },
      { id: 'auto-review', disabled: true },
    ]);
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
      providerRow(' DMXAPI_KEY ', ' http://127.0.0.1:9/v1 ', [
        { id: 'alpha', name: 'alpha', contextWindow: 500000 },
        { id: 'beta', name: 'beta' },
      ]),
      { id: 'agent-default-model', config: { provider: 'intranet', model: ' beta ' } },
    ]);
  });

  it.each([true, false])(
    'inserts the read-only platform entry after the permission plugin for admin=%s',
    (admin) => {
      const generated = generateManagedConfig({ ...INPUT, admin });
      ok(generated.outcome === 'configured');
      const rows: unknown = JSON.parse(generated.content);
      ok(Array.isArray(rows));

      expect(rows.slice(-2)).toEqual([
        {
          insert: [
            {
              id: 'managed-permissions',
              name: '/opt/dsh-team/permission-tiers/index.js',
              disabled: false,
            },
            {
              id: 'platform-nav',
              name: '/opt/dsh-team/platform-nav/index.js',
              disabled: false,
              config: { admin },
            },
            PLATFORM_CREDENTIAL_STORE,
          ],
        },
        { id: 'agent-loop', disabled: false, inject: ['managedPermissions'] },
      ]);
    },
  );

  it('resolves the managed provider only from the read-only platform credential store realm', () => {
    const generated = generateManagedConfig(INPUT);
    ok(generated.outcome === 'configured');
    const rows: unknown = JSON.parse(generated.content);
    ok(Array.isArray(rows));
    const entries = rows.flatMap((row: unknown): unknown[] =>
      typeof row === 'object' && row !== null && 'insert' in row && Array.isArray(row.insert)
        ? row.insert
        : [row],
    );
    // Every row joining a credentials realm: exactly the provider and the platform store.
    const realms = entries.flatMap((row: unknown) => {
      ok(typeof row === 'object' && row !== null && 'id' in row);
      return 'isolate' in row ? [[row.id, row.isolate]] : [];
    });
    const store = entries.find(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        row.id === 'dsh-team-platform-credentials',
    );

    expect(realms).toEqual([
      ['llm-pi-ai', { credentials: 'dsh-team-platform' }],
      ['dsh-team-platform-credentials', { credentials: 'dsh-team-platform' }],
    ]);
    // The store file never exists: its image directory is root 0555, so the realm falls back to
    // the platform-injected process environment and never needs a watcher.
    ok(typeof store === 'object' && store !== null && 'config' in store);
    expect(store.config).toEqual({
      path: '/opt/dsh-team/credentials/platform.yaml',
      dshHome: '/data/home',
      watch: false,
    });
  });

  it('differs between roles only in the platform entry flag', () => {
    const employee = generateManagedConfig({ ...INPUT, admin: false });
    const administrator = generateManagedConfig({ ...INPUT, admin: true });
    ok(employee.outcome === 'configured' && administrator.outcome === 'configured');

    expect(
      administrator.content.replace('"config":{"admin":true}', '"config":{"admin":false}'),
    ).toBe(employee.content);
    expect(administrator.content.split('"admin":').length).toBe(2);
  });

  it.each([undefined, null, 'true', 1, 0, {}])(
    'rejects a non-boolean administrator flag %j before any composition',
    (admin) => {
      const malformed = { ...INPUT, admin };
      const unconfigured = {
        ...malformed,
        modelSettings: { ...INPUT.modelSettings, baseURL: '' },
      };

      // The untyped fixture callers can omit the field; the runtime check is the guard.
      expect(() => generateManagedConfig(malformed as unknown as ManagedConfigInput)).toThrow(
        'Managed overlay administrator flag must be boolean',
      );
      expect(() => generateManagedConfig(unconfigured as unknown as ManagedConfigInput)).toThrow(
        'Managed overlay administrator flag must be boolean',
      );
    },
  );

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

  describe('disposes every 0.2.1 row delta', () => {
    const generated = generateManagedConfig({
      ...INPUT,
      presets: [RELEASE_STANDARD_PRESET, RELEASE_MINIMAL_PRESET],
    });
    ok(generated.outcome === 'configured');
    const rows: unknown = JSON.parse(generated.content);
    ok(Array.isArray(rows));
    const overlayIds = pluginIds(
      rows.flatMap((row: unknown): unknown[] =>
        typeof row === 'object' && row !== null && 'insert' in row && Array.isArray(row.insert)
          ? row.insert
          : [row],
      ),
    );
    const presetIds = new Map(
      rowsWithIds(generated.content, ['preset-standard', 'preset-minimal']).map((row) => {
        ok(typeof row === 'object' && row !== null && 'id' in row && 'config' in row);
        const config = row.config;
        ok(typeof config === 'object' && config !== null && 'plugins' in config);
        ok(Array.isArray(config.plugins));
        return [String(row.id), pluginIds(config.plugins)];
      }),
    );

    it.each(RELEASE_ROW_DISPOSITIONS)('%s row %s is %s', (scope, id, disposition) => {
      const present = scope.startsWith('preset-')
        ? (presetIds.get(scope) ?? []).includes(id)
        : overlayIds.includes(id);

      expect(present).toBe(disposition === 'retained' && scope.startsWith('preset-'));
    });

    it('keeps the retained preset rows verbatim and in their released order', () => {
      expect(rowsWithIds(generated.content, ['preset-standard', 'preset-minimal'])).toEqual([
        {
          ...RELEASE_STANDARD_PRESET,
          config: {
            ...RELEASE_STANDARD_PRESET.config,
            plugins: [
              { id: 'persona', name: '@deepseek-ai/dsh-persona' },
              { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
              { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
              { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
              {
                id: 'delegation',
                name: 'cordis:group',
                group: true,
                isolate: { workflowEngine: true },
                config: [
                  {
                    id: 'tool-subagent',
                    name: '@deepseek-ai/dsh-tool-subagent',
                    config: {
                      provider: 'spawn',
                      toolName: 'subagent',
                      modelSelectionSettings: true,
                    },
                  },
                ],
              },
              { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
              {
                id: 'tool-plugin-manager',
                name: '@deepseek-ai/dsh-plugin-manager/tools',
                disabled: true,
              },
              {
                id: 'tool-plugin-market',
                name: '@deepseek-ai/dsh-plugin-market/tools',
                disabled: true,
              },
            ],
          },
        },
        RELEASE_MINIMAL_PRESET,
      ]);
    });

    it.each([
      [false, [{ id: 'tool-web', disabled: true }]],
      [true, []],
    ])(
      'with web tools enabled=%s writes the profile-level network tool row %j',
      (webToolsEnabled, expected) => {
        const switched = generateManagedConfig({ ...INPUT, webToolsEnabled });
        ok(switched.outcome === 'configured');

        expect(rowsWithIds(switched.content, ['tool-web'])).toEqual(expected);
      },
    );
  });
});

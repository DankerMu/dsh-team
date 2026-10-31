import { isIPv4 } from 'node:net';
import type { Settings } from '../db/index.ts';

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

interface PluginEntry {
  readonly id?: string;
  readonly name?: string;
  readonly group?: boolean;
  readonly config?: Json | readonly PluginEntry[];
  readonly [key: string]: Json | readonly PluginEntry[] | undefined;
}

interface GroupPlugin extends PluginEntry {
  readonly group: true;
  readonly config: readonly PluginEntry[];
}

function isGroupPlugin(plugin: PluginEntry): plugin is GroupPlugin {
  return plugin.group === true && Array.isArray(plugin.config);
}

interface PresetConfig {
  readonly plugins: readonly PluginEntry[];
  readonly [key: string]: Json | readonly PluginEntry[];
}

interface PresetEntry {
  readonly id: string;
  readonly name?: string;
  readonly config: PresetConfig;
  readonly [key: string]: Json | PresetConfig | undefined;
}

export interface ManagedConfigInput {
  /** Whether the account was an administrator when this overlay was generated. */
  readonly admin: boolean;
  /** The employee container's fixed address (base+2 of its aligned /28); DSH binds only it. */
  readonly instanceAddress: string;
  readonly modelSettings: {
    readonly baseURL?: string | undefined;
    readonly apiKeyEnv: string;
    /**
     * Trusted callers own deriving this from the actual stored/injected
     * credential slot. A nonempty `apiKeyEnv` reference name is not availability.
     */
    readonly apiKeyConfigured: boolean;
    readonly models?: readonly Settings['models'][number][] | undefined;
    readonly defaultModel?: string | undefined;
  };
  readonly defaultPermissionTier: Settings['defaultPermissionTier'];
  readonly presets: readonly PresetEntry[];
  readonly localePatch: readonly Json[];
}

export type ManagedConfigResult =
  { outcome: 'configured'; content: string } | { outcome: 'unconfigured' };

// Matched by package name: row ids are employee-renamable, names are what load.
const REMOVED_TOOLS: ReadonlySet<string> = new Set(['@deepseek-ai/dsh-tool-web']);

const PERMISSION_PRESETS = {
  approval: { sandbox: 'danger-full-access', approval: 'ask', name: '人工批准' },
  'auto-review': { sandbox: 'danger-full-access', approval: 'ask', name: 'Auto' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Yolo' },
};
const PERMISSION_DEFAULTS = {
  approval: 'approval',
  auto: 'auto-review',
  yolo: 'danger-full-access',
};

function filterPlugins(plugins: readonly PluginEntry[]): PluginEntry[] {
  const filtered: PluginEntry[] = [];
  for (const plugin of plugins) {
    if (plugin.name !== undefined && REMOVED_TOOLS.has(plugin.name)) {
      continue;
    }
    if (isGroupPlugin(plugin)) {
      filtered.push({ ...plugin, config: filterPlugins(plugin.config) });
      continue;
    }
    filtered.push(plugin);
  }
  return filtered;
}

function transformPreset(preset: PresetEntry): PresetEntry {
  return {
    ...preset,
    config: { ...preset.config, plugins: filterPlugins(preset.config.plugins) },
  };
}

function serializeModels(models: readonly Settings['models'][number][]): Json {
  const rows: Json[] = [];
  for (const model of models) {
    if (Object.hasOwn(model, 'contextWindow') && model.contextWindow !== undefined) {
      rows.push({ id: model.name, name: model.name, contextWindow: model.contextWindow });
    } else {
      rows.push({ id: model.name, name: model.name });
    }
  }
  return rows;
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

type CompleteModelSettings = ManagedConfigInput['modelSettings'] & {
  readonly baseURL: string;
  readonly models: readonly Settings['models'][number][];
  readonly defaultModel: string;
};

export function hasCompleteModelSettings(
  modelSettings: ManagedConfigInput['modelSettings'],
): modelSettings is CompleteModelSettings {
  const { baseURL, apiKeyEnv, apiKeyConfigured, models, defaultModel } = modelSettings;
  return (
    isPresent(baseURL) &&
    apiKeyConfigured &&
    isPresent(apiKeyEnv) &&
    models !== undefined &&
    models.length > 0 &&
    isPresent(defaultModel)
  );
}

function isInstanceAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isIPv4(value) &&
    value.split('.').map(Number).join('.') === value &&
    value !== '0.0.0.0' &&
    Number(value.split('.')[3]) % 16 === 2
  );
}

export function generateManagedConfig(input: ManagedConfigInput): ManagedConfigResult {
  // Untyped fixture callers can omit the flag; never default it to either role.
  if (typeof input.admin !== 'boolean') {
    throw new TypeError('Managed overlay administrator flag must be boolean');
  }
  // DSH 0.2.1 rejects wildcard binds; a wrong concrete address would never announce or serve.
  if (!isInstanceAddress(input.instanceAddress)) {
    throw new TypeError(
      'Managed overlay instance address must be the fixed container address of an aligned /28',
    );
  }
  if (!hasCompleteModelSettings(input.modelSettings)) {
    return { outcome: 'unconfigured' };
  }
  const { baseURL, apiKeyEnv, models, defaultModel } = input.modelSettings;
  return {
    outcome: 'configured',
    content: JSON.stringify([
      {
        id: 'webserver',
        config: { host: input.instanceAddress, port: 3080, compression: 'gzip' },
      },
      { id: 'tool-web', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            intranet: {
              displayName: '内网模型',
              apiKeyEnv,
              api: 'openai-completions',
              baseURL,
              models: serializeModels(models),
            },
          },
        },
      },
      {
        id: 'agent-default-model',
        config: {
          provider: 'intranet',
          model: defaultModel,
        },
      },
      ...input.presets.map(transformPreset),
      ...input.localePatch,
      // Security policy is last: profile/home/locale edits cannot replace it.
      // The plugin page has no upstream config; a row's config is whole, so this is all of it.
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: false } },
      { id: 'auto-review', disabled: true },
      {
        id: 'permission',
        disabled: false,
        config: {
          presets: PERMISSION_PRESETS,
          defaultPreset: PERMISSION_DEFAULTS[input.defaultPermissionTier],
        },
      },
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
            config: { admin: input.admin },
          },
        ],
      },
      { id: 'agent-loop', disabled: false, inject: ['managedPermissions'] },
    ]),
  };
}

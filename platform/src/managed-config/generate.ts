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
  readonly permission: {
    readonly presets: Readonly<
      Record<
        string,
        {
          readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
          readonly approval: 'ask' | 'never';
          readonly name?: string;
          readonly description?: string;
        }
      >
    >;
    readonly defaultPreset: string;
  };
  readonly presets: readonly PresetEntry[];
  readonly localePatch: readonly Json[];
}

export type ManagedConfigResult =
  { outcome: 'configured'; content: string } | { outcome: 'unconfigured' };

const NETWORK_TOOL = '@deepseek-ai/dsh-tool-web';

function filterPlugins(plugins: readonly PluginEntry[]): PluginEntry[] {
  const filtered: PluginEntry[] = [];
  for (const plugin of plugins) {
    if (plugin.name === NETWORK_TOOL) {
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

export function generateManagedConfig(input: ManagedConfigInput): ManagedConfigResult {
  if (!hasCompleteModelSettings(input.modelSettings)) {
    return { outcome: 'unconfigured' };
  }
  const { baseURL, apiKeyEnv, models, defaultModel } = input.modelSettings;
  return {
    outcome: 'configured',
    content: JSON.stringify([
      {
        id: 'webserver',
        config: { host: '0.0.0.0', port: 3080 },
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
      {
        id: 'permission',
        config: input.permission,
      },
      ...input.presets.map(transformPreset),
      ...input.localePatch,
    ]),
  };
}

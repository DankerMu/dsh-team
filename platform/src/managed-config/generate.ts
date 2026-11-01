import { isIPv4 } from 'node:net';
import type { Settings } from '../db/index.ts';
import type { CatalogEntryState } from '../plugin-catalog/index.ts';

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
  readonly webToolsEnabled: boolean;
  /** First item is DSH's `registry`, the rest its `fallbackRegistries`; written verbatim. */
  readonly pluginRegistries: readonly string[];
  readonly registryProbeEnabled: boolean;
  /** `catalogStates` projection, in catalog file order; that order is the output order. */
  readonly pluginCatalog: readonly CatalogEntryState[];
  /** Canonical patch and observed presence of each forced-state manageable bundle. */
  readonly bundles: readonly ManagedBundle[];
}

interface ManagedBundle {
  readonly id: string;
  readonly patch: readonly Json[];
  readonly present: boolean;
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

const PRESET_NAME = '@deepseek-ai/dsh-agent-preset';
const PRESET_REGISTRY = 'agent-preset-registry';
// The released default selection: dsh-web-app 0.2.1-rc.2 cordis.patch.yml:586-589.
const RELEASE_DEFAULT_PRESET = 'standard';

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

function transformPreset(preset: PresetEntry, webToolsEnabled: boolean): PresetEntry {
  if (webToolsEnabled) return preset;
  return {
    ...preset,
    config: { ...preset.config, plugins: filterPlugins(preset.config.plugins) },
  };
}

type PatchRow = { readonly insert?: readonly PluginEntry[] } & PluginEntry;

function forcedBundle(
  entry: CatalogEntryState,
  bundles: readonly ManagedBundle[],
): { readonly rows: readonly PatchRow[]; readonly present: boolean } {
  const bundle = bundles.find((candidate) => candidate.id === entry.id);
  // Silently ignoring an administrator's forced state would be misconfiguration.
  if (bundle === undefined || bundle.patch.length === 0) {
    throw new TypeError(`Managed overlay forced catalog entry ${entry.id} has no canonical patch`);
  }
  // The composition reader validated every row as an object with id-bearing insert entries.
  return { rows: bundle.patch as PatchRow[], present: bundle.present };
}

function insertIds(rows: readonly PatchRow[]): string[] {
  return rows.flatMap((row) => (row.insert ?? []).map((plugin) => String(plugin.id)));
}

/** Absent rows are re-inserted verbatim: insert is not idempotent, so a present bundle is only enabled. */
function forcedOnRows(
  rows: readonly PatchRow[],
  present: boolean,
  webToolsEnabled: boolean,
): Json[] {
  if (present) return insertIds(rows).map((id) => ({ id, disabled: false }));
  return rows.map((row) => {
    // PatchRow is a view of the reader's JSON row; writing it back keeps it JSON.
    if (row.insert === undefined) return row as Json;
    const insert = row.insert.map((plugin) =>
      // Reader-validated preset entries carry config.plugins.
      plugin.name === PRESET_NAME
        ? transformPreset(plugin as PresetEntry, webToolsEnabled)
        : plugin,
    );
    return { ...row, insert } as Json;
  });
}

/** Written regardless of presence: DSH re-appends the overlay when it recomposes at runtime. */
function forcedOffRows(entry: CatalogEntryState, rows: readonly PatchRow[]): Json[] {
  return rows.flatMap((row): Json[] => {
    if (row.insert !== undefined) return insertIds([row]).map((id) => ({ id, disabled: true }));
    if (row.id !== PRESET_REGISTRY) {
      throw new TypeError(
        `Managed overlay forced-off catalog entry ${entry.id} overrides ${String(row.id)}`,
      );
    }
    // Otherwise the registry retains a disabled default preset and new Sessions fail.
    return [{ id: PRESET_REGISTRY, config: { default: RELEASE_DEFAULT_PRESET } }];
  });
}

function catalogRows(input: ManagedConfigInput): { rows: Json[]; disabled: Set<string> } {
  const rows: Json[] = [];
  const disabled = new Set<string>();
  for (const entry of input.pluginCatalog) {
    if (entry.category === 'required') {
      // Required activation is the fixed insert/locale rows below; only forced-on is coherent.
      if (entry.state !== 'forced-on') {
        throw new TypeError(`Managed overlay required catalog entry ${entry.id} must be forced-on`);
      }
      continue;
    }
    if (entry.state === 'employee') continue;
    const bundle = forcedBundle(entry, input.bundles);
    if (entry.state === 'forced-on') {
      rows.push(...forcedOnRows(bundle.rows, bundle.present, input.webToolsEnabled));
      continue;
    }
    for (const id of insertIds(bundle.rows)) disabled.add(id);
    rows.push(...forcedOffRows(entry, bundle.rows));
  }
  return { rows, disabled };
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

/**
 * F18: the managed provider resolves `apiKeyEnv` only inside this labelled credentials realm.
 * Its store file never exists (the image directory is root 0555), so resolution falls back to
 * the platform-injected process environment; the employee's global store is never consulted.
 */
const PLATFORM_CREDENTIALS = { credentials: 'dsh-team-platform' };

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
  if (
    typeof input.webToolsEnabled !== 'boolean' ||
    typeof input.registryProbeEnabled !== 'boolean'
  ) {
    throw new TypeError('Managed overlay web tools and registry probe flags must be boolean');
  }
  // Untyped fixture callers can omit the list; checking an unknown view keeps the string type.
  const registries: unknown = input.pluginRegistries;
  const [registry, ...fallbackRegistries] = Array.isArray(registries) ? input.pluginRegistries : [];
  if (registry === undefined) {
    throw new TypeError('Managed overlay plugin registries must be a nonempty list');
  }
  if (!hasCompleteModelSettings(input.modelSettings)) {
    return { outcome: 'unconfigured' };
  }
  const { baseURL, apiKeyEnv, models, defaultModel } = input.modelSettings;
  const catalog = catalogRows(input);
  return {
    outcome: 'configured',
    content: JSON.stringify([
      {
        id: 'webserver',
        config: { host: input.instanceAddress, port: 3080, compression: 'gzip' },
      },
      ...(input.webToolsEnabled ? [] : [{ id: 'tool-web', disabled: true }]),
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      {
        id: 'llm-pi-ai',
        isolate: PLATFORM_CREDENTIALS,
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
      ...input.presets
        .filter((preset) => !catalog.disabled.has(preset.id))
        .map((preset) => transformPreset(preset, input.webToolsEnabled)),
      ...input.localePatch,
      // Managed policy is last: profile/home/locale edits cannot replace it.
      ...catalog.rows,
      // Neither upstream row has a config; a row's config is whole, so this is all of it.
      { id: 'plugin-manager', config: { registry, fallbackRegistries } },
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: input.registryProbeEnabled } },
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
          {
            id: 'dsh-team-platform-credentials',
            name: '@deepseek-ai/dsh-credentials-local',
            disabled: false,
            isolate: PLATFORM_CREDENTIALS,
            // The path never changes and never exists, so no watcher is needed.
            config: {
              path: '/opt/dsh-team/credentials/platform.yaml',
              dshHome: '/data/home',
              watch: false,
            },
          },
        ],
      },
      { id: 'agent-loop', disabled: false, inject: ['managedPermissions'] },
    ]),
  };
}

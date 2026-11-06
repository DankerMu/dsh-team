import type Database from 'better-sqlite3';

type PermissionTier = 'approval' | 'auto' | 'yolo';

const STATES: Record<string, true> = { employee: true, 'forced-on': true, 'forced-off': true };
/** Closed administrator states of one catalog entry. */
export const CATALOG_STATES = Object.freeze(Object.keys(STATES)) as readonly CatalogState[];
export type CatalogState = 'employee' | 'forced-on' | 'forced-off';
/** DSH plugin-manager's own registry URL rule. */
export const REGISTRY_URL = /^https?:\/\/\S+$/;

const MAX_RAGFLOW_BASE_URL = 2048;
// Rejects whitespace, C0 controls and DEL anywhere: URL parsing would silently strip them.
// eslint-disable-next-line no-control-regex -- the control-character range is the rule itself.
const RAGFLOW_BASE_URL_CHARACTERS = /^[^\s\x00-\x1f\x7f]+$/;
/**
 * RAGFlow base-address rule, checked on the raw string before parsing: URL parsing silently
 * drops an empty query, fragment or userinfo, so appending an API path stays inside the path.
 */
export function isRagflowBaseUrl(value: string): boolean {
  if (
    value.length > MAX_RAGFLOW_BASE_URL ||
    !RAGFLOW_BASE_URL_CHARACTERS.test(value) ||
    /[?#@\\]/.test(value)
  )
    return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // Only the URL constructor throws here: an unparseable address is not a RAGFlow address.
    return false;
  }
}

/** A stored external address selects the external Document Server; otherwise the bundled one. */
export function documentServerMode(settings: Settings): 'bundled' | 'external' {
  return settings.documentServerUrl === '' ? 'bundled' : 'external';
}

interface ModelSetting {
  readonly name: string;
  readonly contextWindow?: number;
}
export interface Settings {
  readonly idleMinutes: number;
  readonly cpuCores: number;
  readonly memoryMiB: number;
  readonly maxRunningInstances: number;
  readonly defaultPermissionTier: PermissionTier;
  readonly models: ModelSetting[];
  readonly modelBaseUrl: string;
  readonly modelApiKey: string;
  readonly defaultModel: string;
  /** Manageable catalog ids only; required entries are never stored. */
  readonly pluginCatalog: Readonly<Record<string, CatalogState>>;
  /** First item is the install registry, the rest are fallbacks. */
  readonly pluginRegistries: readonly string[];
  readonly registryProbeEnabled: boolean;
  readonly webToolsEnabled: boolean;
  /** `''` until configured, otherwise an `isRagflowBaseUrl` address stored verbatim. */
  readonly ragflowBaseUrl: string;
  readonly ragflowApiKey: string;
  /** Returned chunk count (RAGFlow `page_size`), 1..100. */
  readonly retrievalTopK: number;
  readonly retrievalSimilarityThreshold: number;
  readonly retrievalKeywordsWeight: number;
  /** Empty for no reranking. */
  readonly retrievalRerankId: string;
  /** `''` selects the bundled Document Server, otherwise an `isRagflowBaseUrl` address stored verbatim. */
  readonly documentServerUrl: string;
  /** External Document Server JWT; empty exactly when `documentServerUrl` is empty. */
  readonly documentServerJwtSecret: string;
}
const UPSERT_SETTING =
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

const TIERS: Record<string, true> = { approval: true, auto: true, yolo: true };
export const PERMISSION_TIERS = Object.freeze(Object.keys(TIERS));

const DEFAULT_SETTINGS: Settings = {
  idleMinutes: 30,
  cpuCores: 2,
  memoryMiB: 4096,
  maxRunningInstances: 60,
  defaultPermissionTier: 'yolo',
  models: [],
  modelBaseUrl: '',
  modelApiKey: '',
  defaultModel: '',
  pluginCatalog: {},
  pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  registryProbeEnabled: true,
  webToolsEnabled: false,
  ragflowBaseUrl: '',
  ragflowApiKey: '',
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
  documentServerUrl: '',
  documentServerJwtSecret: '',
};
interface SettingRow {
  key: string;
  value: string;
}

export class SettingsValidationError extends Error {}

function fieldError(field: string): Error {
  return new SettingsValidationError(`Invalid settings field ${JSON.stringify(field)}`);
}
function requirePositiveSafeInteger(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw fieldError(field);
  }
  return value;
}

function requireTopK(value: unknown): number {
  const topK = requirePositiveSafeInteger('retrievalTopK', value);
  if (topK > 100) throw fieldError('retrievalTopK');
  return topK;
}

function parseModels(value: unknown): ModelSetting[] {
  if (!Array.isArray(value)) {
    throw fieldError('models');
  }
  const models: ModelSetting[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw fieldError('models');
    }
    // Model entries arrive as unknown JSON or patch objects; fields are checked below.
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw fieldError('models');
    }
    const model: { name: string; contextWindow?: number } = { name: record.name };
    if (Object.hasOwn(record, 'contextWindow')) {
      model.contextWindow = requirePositiveSafeInteger('models', record.contextWindow);
    }
    models.push(model);
  }
  return models;
}

function parsePluginCatalog(value: unknown): Record<string, CatalogState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fieldError('pluginCatalog');
  }
  const entries = Object.entries(value);
  if (!entries.every(([, state]) => typeof state === 'string' && Object.hasOwn(STATES, state))) {
    throw fieldError('pluginCatalog');
  }
  // fromEntries defines data properties, so an own "__proto__" id cannot replace the prototype.
  return Object.fromEntries(entries);
}

function parseRegistries(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((url) => typeof url === 'string' && REGISTRY_URL.test(url))
  ) {
    throw fieldError('pluginRegistries');
  }
  return [...(value as string[])];
}

/** Document Server keys; any other key is not an owned setting. */
function parseDocumentServerSetting(key: string, value: unknown): unknown {
  switch (key) {
    case 'documentServerUrl':
      if (typeof value !== 'string' || (value !== '' && !isRagflowBaseUrl(value))) {
        throw fieldError(key);
      }
      return value;
    case 'documentServerJwtSecret':
      if (typeof value !== 'string') throw fieldError(key);
      return value;
    default:
      throw fieldError(key);
  }
}

/** RAGFlow connection and retrieval keys; other keys continue to the Document Server keys. */
function parseRagflowSetting(key: string, value: unknown): unknown {
  switch (key) {
    case 'ragflowBaseUrl':
      if (typeof value !== 'string' || (value !== '' && !isRagflowBaseUrl(value))) {
        throw fieldError(key);
      }
      return value;
    case 'ragflowApiKey':
    case 'retrievalRerankId':
      if (typeof value !== 'string') throw fieldError(key);
      return value;
    case 'retrievalTopK':
      return requireTopK(value);
    case 'retrievalSimilarityThreshold':
    case 'retrievalKeywordsWeight':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw fieldError(key);
      }
      return value;
    default:
      return parseDocumentServerSetting(key, value);
  }
}

/** Plugin-catalog, plugin-source and web-tool keys; other keys continue to the RAGFlow keys. */
function parsePluginSetting(key: string, value: unknown): unknown {
  switch (key) {
    case 'pluginCatalog':
      return parsePluginCatalog(value);
    case 'pluginRegistries':
      return parseRegistries(value);
    case 'registryProbeEnabled':
    case 'webToolsEnabled':
      if (typeof value !== 'boolean') throw fieldError(key);
      return value;
    default:
      return parseRagflowSetting(key, value);
  }
}

const STRING_FIELDS = ['modelBaseUrl', 'modelApiKey', 'defaultModel'];

function parseOwned(key: string, value: unknown): unknown {
  if (STRING_FIELDS.includes(key)) {
    if (typeof value !== 'string') throw fieldError(key);
    return value;
  }
  switch (key) {
    case 'idleMinutes':
    case 'memoryMiB':
    case 'maxRunningInstances':
      return requirePositiveSafeInteger(key, value);
    case 'cpuCores':
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw fieldError(key);
      }
      return value;
    case 'defaultPermissionTier':
      if (typeof value !== 'string' || !Object.hasOwn(TIERS, value)) {
        throw fieldError(key);
      }
      return value;
    case 'models':
      return parseModels(value);
    default:
      return parsePluginSetting(key, value);
  }
}

function validateDefault(settings: Settings): void {
  if (
    settings.defaultModel !== '' &&
    !settings.models.some((model) => model.name === settings.defaultModel)
  ) {
    throw new SettingsValidationError(
      'Invalid settings field "defaultModel": default model must be in the model list',
    );
  }
}

export function readSettings(db: Database.Database): Settings {
  const settings = {
    ...DEFAULT_SETTINGS,
    models: [] as ModelSetting[],
    pluginCatalog: {},
    pluginRegistries: [...DEFAULT_SETTINGS.pluginRegistries],
  };
  const rows = db.prepare<[], SettingRow>('SELECT key, value FROM settings').all();
  for (const row of rows) {
    // The defaults enumerate exactly the owned keys; other stored rows are left unread.
    if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value) as unknown;
    } catch {
      throw fieldError(row.key);
    }
    Object.assign(settings, { [row.key]: parseOwned(row.key, parsed) });
  }
  validateDefault(settings);
  return settings;
}

export function writeSettings(db: Database.Database, patch: unknown): void {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new SettingsValidationError('Invalid settings patch');
  }
  // HTTP/admin callers supply untyped objects; field validation below is the type boundary.
  const record = patch as Record<string, unknown>;
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(record)) {
    entries.push([key, parseOwned(key, value)]);
  }
  if (entries.length === 0) {
    return;
  }

  const upsert = db.prepare(UPSERT_SETTING);
  const persist = db.transaction(() => {
    const merged = readSettings(db);
    for (const [key, value] of entries) Object.assign(merged, { [key]: value });
    validateDefault(merged);
    for (const [key, value] of entries) {
      upsert.run(key, JSON.stringify(value));
    }
  });
  persist();
}

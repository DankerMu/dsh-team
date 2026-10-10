import type Database from 'better-sqlite3';

type PermissionTier = 'approval' | 'auto' | 'yolo';

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
      throw fieldError(key);
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
  const settings = { ...DEFAULT_SETTINGS, models: [] as ModelSetting[] };
  const rows = db.prepare<[], SettingRow>('SELECT key, value FROM settings').all();
  for (const row of rows) {
    switch (row.key) {
      case 'idleMinutes':
      case 'cpuCores':
      case 'memoryMiB':
      case 'maxRunningInstances':
      case 'defaultPermissionTier':
      case 'models':
      case 'modelBaseUrl':
      case 'modelApiKey':
      case 'defaultModel':
        break;
      default:
        continue;
    }
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

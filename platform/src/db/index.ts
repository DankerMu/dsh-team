export { applyMigrations } from './migrate.ts';
export { openDatabase } from './open.ts';
export type { DatabaseHandle } from './open.ts';
export { hasBoundedEmailLength, assertCompatibleAccountEmails } from './email.ts';
export {
  readSettings,
  writeSettings,
  SettingsValidationError,
  PERMISSION_TIERS,
  CATALOG_STATES,
} from './settings.ts';
export type { CatalogState, Settings } from './settings.ts';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const MIGRATION_FILE = /^(\d+)-.+\.sql$/;
const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationFile {
  version: number;
  sql: string;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function listSqlNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.sql'));
}

function readMigrationFiles(directory: string, names: string[]): MigrationFile[] {
  const byVersion = new Map<number, string>();

  for (const name of names) {
    if (MIGRATION_FILE.exec(name) === null) {
      throw new Error(`Malformed SQL migration filename "${name}"`);
    }
    const version = Number(name.slice(0, name.indexOf('-')));
    const previous = byVersion.get(version);
    if (previous !== undefined) {
      throw new Error(`Duplicate migration number ${String(version)}: "${previous}" and "${name}"`);
    }
    byVersion.set(version, name);
  }

  return [...byVersion.entries()]
    .sort(([left], [right]) => left - right)
    .map(([version, filename]) => ({
      version,
      sql: readFileSync(join(directory, filename), 'utf8'),
    }));
}

function loadMigrationFiles(directory: string | undefined): MigrationFile[] {
  const explicit = directory !== undefined;
  const target = explicit ? directory : DEFAULT_MIGRATIONS_DIR;

  let names: string[];
  try {
    names = listSqlNames(target);
  } catch (error) {
    if (!explicit && isErrno(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  return readMigrationFiles(target, names);
}

function appliedVersions(db: Database.Database): Set<number> {
  const exists = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (exists === undefined) {
    return new Set();
  }
  const rows = db.prepare<[], { version: number }>('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((row) => row.version));
}

/**
 * Apply pending numbered SQL files in one transaction with their ledger rows.
 * Caller owns the database handle; already committed versions are left unchanged on failure.
 */
export function applyMigrations(db: Database.Database, directory?: string): void {
  const files = loadMigrationFiles(directory);
  const applied = appliedVersions(db);
  const pending = files.filter((file) => !applied.has(file.version));
  if (pending.length === 0) {
    return;
  }

  const run = db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (const file of pending) {
      db.exec(file.sql);
      record.run(file.version);
    }
  });
  run();
}

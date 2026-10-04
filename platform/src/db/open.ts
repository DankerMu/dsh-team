import Database from 'better-sqlite3';
import { preparePrivateDatabaseFile, tightenSqliteFiles } from './private-file.ts';

export type DatabaseHandle = Database.Database;

/**
 * Open a SQLite database by filename (`:memory:` for unit tests).
 * File connections use WAL, foreign keys, and mode 0600 before writes.
 * Filenames that would change under driver trim() are rejected before any filesystem work.
 */
export function openDatabase(filename: string): DatabaseHandle {
  if (filename !== filename.trim()) {
    throw new Error(
      `Database filename must not have leading or trailing whitespace, got ${JSON.stringify(filename)}`,
    );
  }

  preparePrivateDatabaseFile(filename);
  tightenSqliteFiles(filename);
  const db = new Database(filename);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    tightenSqliteFiles(filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

import Database from 'better-sqlite3';
import { preparePrivateDatabaseFile, tightenSqliteFiles } from './private-file.ts';

/**
 * Open a SQLite database by filename (`:memory:` for unit tests).
 * File connections use WAL, foreign keys, and mode 0600 before writes.
 */
export function openDatabase(filename: string): Database.Database {
  preparePrivateDatabaseFile(filename);
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

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.ts';

describe('openDatabase on a file', () => {
  let dir = '';

  afterEach(() => {
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('creates a 0600 database file before application writes under a permissive umask', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'platform.db');
    const previous = process.umask(0o000);

    try {
      const db = openDatabase(dbPath);

      try {
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
        db.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      } finally {
        db.close();
      }
    } finally {
      process.umask(previous);
    }
  });

  it('opens a file database in WAL mode with 0600 sidecars while open', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'platform.db');
    const db = openDatabase(dbPath);

    try {
      db.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      // better-sqlite3 Statement.get() is untyped; PRAGMA journal_mode returns one named column.
      const pragma = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };

      expect(pragma.journal_mode).toBe('wal');
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('reopens the same file and reads a previously written sentinel', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'platform.db');
    const first = openDatabase(dbPath);

    try {
      first.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      first.prepare('INSERT INTO sentinel (value) VALUES (?)').run('keep-me');
    } finally {
      first.close();
    }

    const second = openDatabase(dbPath);

    try {
      // better-sqlite3 Statement.get() is untyped; the query returns one named column.
      const row = second.prepare('SELECT value FROM sentinel').get() as { value: string };

      expect(row.value).toBe('keep-me');
    } finally {
      second.close();
    }
  });

  it('creates missing parent directories then opens the database', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'nested', 'platform.db');
    const db = openDatabase(dbPath);

    try {
      expect(statSync(dbPath).isFile()).toBe(true);
    } finally {
      db.close();
    }
  });

  it('tightens a preexisting 0644 database file to 0600', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'platform.db');
    writeFileSync(dbPath, '');
    chmodSync(dbPath, 0o644);
    const db = openDatabase(dbPath);

    try {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('propagates an error when the path is an existing directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'not-a-db');
    mkdirSync(dbPath);

    expect(() => openDatabase(dbPath)).toThrow();
  });
});

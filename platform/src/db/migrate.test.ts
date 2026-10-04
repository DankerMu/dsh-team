import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { applyMigrations, openDatabase } from './index.ts';

type ListSqlNames = (directory: string) => string[];
type ReadSqlFile = (path: string, encoding: 'utf8') => string;
interface NodeFs {
  readdirSync: ListSqlNames;
  readFileSync: ReadSqlFile;
}
const fsFault = vi.hoisted(() => ({
  missingDefaultDir: false,
  unreadableDefaultFile: undefined as string | undefined,
  listedFileError: undefined as NodeJS.ErrnoException | undefined,
  listSqlNames: undefined as ListSqlNames | undefined,
  readSqlFile: undefined as ReadSqlFile | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFs>();
  fsFault.listSqlNames = (directory) => actual.readdirSync(directory);
  fsFault.readSqlFile = (path, encoding) => actual.readFileSync(path, encoding);
  return {
    ...actual,
    readdirSync(directory: string): string[] {
      if (fsFault.missingDefaultDir && directory.endsWith(join('db', 'migrations'))) {
        const error = new Error(
          `ENOENT: no such file or directory, scandir '${directory}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      if (
        fsFault.unreadableDefaultFile !== undefined &&
        directory.endsWith(join('db', 'migrations'))
      ) {
        return [fsFault.unreadableDefaultFile];
      }
      const list = fsFault.listSqlNames;
      if (list === undefined) {
        throw new Error('node:fs readdirSync mock is not initialized');
      }
      return list(directory);
    },
    readFileSync(path: string, encoding: 'utf8'): string {
      if (
        fsFault.listedFileError !== undefined &&
        fsFault.unreadableDefaultFile !== undefined &&
        path.endsWith(join('migrations', fsFault.unreadableDefaultFile))
      ) {
        throw fsFault.listedFileError;
      }
      const read = fsFault.readSqlFile;
      if (read === undefined) {
        throw new Error('node:fs readFileSync mock is not initialized');
      }
      return read(path, encoding);
    },
  };
});

function writeSqlDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

function userTables(db: Database.Database): unknown {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
}

function resetFsFault(): void {
  fsFault.missingDefaultDir = false;
  fsFault.unreadableDefaultFile = undefined;
  fsFault.listedFileError = undefined;
}

describe('applyMigrations', () => {
  let dir = '';
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    resetFsFault();
  });

  afterEach(() => {
    db.close();
    resetFsFault();
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('applies numbered SQL in numeric order and records the ledger', () => {
    dir = writeSqlDir({
      '10-second.sql': 'INSERT INTO ordered (n) VALUES (10);',
      '2-first.sql':
        'CREATE TABLE ordered (n INTEGER NOT NULL); INSERT INTO ordered (n) VALUES (2);',
    });

    applyMigrations(db, dir);

    expect(db.prepare('SELECT n FROM ordered ORDER BY rowid').all()).toEqual([{ n: 2 }, { n: 10 }]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 2 },
      { version: 10 },
    ]);
  });

  it('does not apply already recorded migrations again', () => {
    dir = writeSqlDir({
      '2-once.sql':
        'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items (id) VALUES (1);',
    });

    applyMigrations(db, dir);
    applyMigrations(db, dir);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 2 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
  });

  it('rolls back pending schema and data while preserving earlier committed migrations', () => {
    dir = writeSqlDir({
      '1-base.sql':
        'CREATE TABLE kept (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO kept (id, n) VALUES (1, 1);',
    });
    applyMigrations(db, dir);
    writeFileSync(
      join(dir, '2-ok.sql'),
      'UPDATE kept SET n = 2 WHERE id = 1; CREATE TABLE pending (id INTEGER PRIMARY KEY);',
    );
    writeFileSync(join(dir, '3-bad.sql'), 'THIS IS NOT SQL;');

    expect(() => {
      applyMigrations(db, dir);
    }).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'kept' }, { name: 'schema_migrations' }]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
    ]);
    expect(db.prepare('SELECT id, n FROM kept').get()).toEqual({ id: 1, n: 1 });
  });

  it('treats a missing default migrations directory as an empty initial set', () => {
    fsFault.missingDefaultDir = true;

    try {
      applyMigrations(db);

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      fsFault.missingDefaultDir = false;
    }
  });

  it('propagates ENOENT when a listed default migration file cannot be read', () => {
    const missing = new Error(
      'ENOENT: no such file or directory, open 2-broken.sql',
    ) as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    fsFault.unreadableDefaultFile = '2-broken.sql';
    fsFault.listedFileError = missing;

    try {
      expect(() => {
        applyMigrations(db);
      }).toThrow(missing);
      expect(userTables(db)).toEqual([]);
    } finally {
      fsFault.unreadableDefaultFile = undefined;
      fsFault.listedFileError = undefined;
    }
  });

  it('rejects an explicit missing migrations directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-mig-'));

    expect(() => {
      applyMigrations(db, join(dir, 'absent'));
    }).toThrow();
  });

  it('rejects duplicate migration numbers before applying any pending file', () => {
    dir = writeSqlDir({
      '2-a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '2-b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
    });

    expect(() => {
      applyMigrations(db, dir);
    }).toThrow();
    expect(userTables(db)).toEqual([]);
  });

  it('rejects a malformed SQL filename before applying any pending file', () => {
    dir = writeSqlDir({
      '2-ok.sql': 'CREATE TABLE ok (id INTEGER PRIMARY KEY);',
      'notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY);',
    });

    expect(() => {
      applyMigrations(db, dir);
    }).toThrow();
    expect(userTables(db)).toEqual([]);
  });
});

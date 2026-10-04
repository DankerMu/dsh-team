import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  applyMigrations,
  openDatabase,
  readSettings,
  writeSettings,
  type DatabaseHandle,
} from '../src/db/index.ts';

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

  it.each([
    { kind: 'direct directory', viaAlias: false },
    { kind: 'symlink to a directory', viaAlias: true },
  ])('rejects $kind without changing mode or child access', ({ viaAlias }) => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const destination = join(dir, 'not-a-db');
    mkdirSync(destination, { mode: 0o750 });
    chmodSync(destination, 0o750);
    const child = join(destination, 'sentinel.txt');
    writeFileSync(child, 'keep-me');
    const requested = viaAlias ? join(dir, 'alias.db') : destination;
    if (viaAlias) {
      symlinkSync(destination, requested);
    }

    try {
      expect(() => {
        openDatabase(requested);
      }).toThrow();
      expect(statSync(destination).isDirectory()).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o750);
      expect(readFileSync(child, 'utf8')).toBe('keep-me');
    } finally {
      chmodSync(destination, 0o750);
    }
  });

  it('rejects a relative filename whose spelling the driver would trim', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const previous = process.cwd();
    let leaked: ReturnType<typeof openDatabase> | undefined;

    try {
      process.chdir(dir);
      try {
        leaked = openDatabase(' platform.db');
      } catch {
        leaked = undefined;
      }
      leaked?.close();
      expect(leaked).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      leaked?.close();
      process.chdir(previous);
    }
  });

  it('opens a filename whose internal basename contains whitespace', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const dbPath = join(dir, 'platform db.sqlite');
    const db = openDatabase(dbPath);

    try {
      expect(statSync(dbPath).isFile()).toBe(true);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('rejects a padded filename without mutating a preexisting trimmed database', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const trimmed = join(dir, 'platform.db');
    const first = openDatabase(trimmed);

    try {
      first.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      first.prepare('INSERT INTO sentinel (value) VALUES (?)').run('keep-me');
    } finally {
      first.close();
    }

    chmodSync(trimmed, 0o644);
    const snapshot = readFileSync(trimmed);
    const requested = `${trimmed} `;
    let leaked: ReturnType<typeof openDatabase> | undefined;

    try {
      leaked = openDatabase(requested);
    } catch {
      leaked = undefined;
    }
    leaked?.close();

    expect(leaked).toBeUndefined();
    expect(() => {
      statSync(requested);
    }).toThrow(/ENOENT/);
    expect(statSync(trimmed).mode & 0o777).toBe(0o644);
    expect(readFileSync(trimmed)).toEqual(snapshot);
    const verify = openDatabase(trimmed);

    try {
      const row = verify.prepare('SELECT value FROM sentinel').get() as { value: string };
      expect(row.value).toBe('keep-me');
    } finally {
      verify.close();
    }
  });

  it('secures target WAL and SHM when opening through a symlink alias', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const target = join(dir, 'target.db');
    const alias = join(dir, 'alias.db');
    const first = openDatabase(target);

    try {
      first.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      first.prepare('INSERT INTO sentinel (value) VALUES (?)').run('keep-me');
      chmodSync(target, 0o644);
      chmodSync(`${target}-wal`, 0o644);
      chmodSync(`${target}-shm`, 0o644);
      symlinkSync(target, alias);
      const second = openDatabase(alias);

      try {
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(statSync(`${target}-wal`).mode & 0o777).toBe(0o600);
        expect(statSync(`${target}-shm`).mode & 0o777).toBe(0o600);
        const row = second.prepare('SELECT value FROM sentinel').get() as { value: string };
        expect(row.value).toBe('keep-me');
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it('secures a trailing-space target opened through a canonical alias', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-'));
    const seed = join(dir, 'seed.db');
    const paddedTarget = join(dir, 'target.db ');
    const alias = join(dir, 'alias.db');
    const first = openDatabase(seed);

    try {
      first.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
      first.prepare('INSERT INTO sentinel (value) VALUES (?)').run('keep-me');
      copyFileSync(seed, paddedTarget);
      copyFileSync(`${seed}-wal`, `${paddedTarget}-wal`);
      copyFileSync(`${seed}-shm`, `${paddedTarget}-shm`);
      chmodSync(paddedTarget, 0o644);
      chmodSync(`${paddedTarget}-wal`, 0o644);
      chmodSync(`${paddedTarget}-shm`, 0o644);
      symlinkSync(paddedTarget, alias);
      const second = openDatabase(alias);

      try {
        expect(statSync(paddedTarget).mode & 0o777).toBe(0o600);
        expect(statSync(`${paddedTarget}-wal`).mode & 0o777).toBe(0o600);
        expect(statSync(`${paddedTarget}-shm`).mode & 0o777).toBe(0o600);
        expect(() => {
          statSync(join(dir, 'target.db'));
        }).toThrow(/ENOENT/);
        const row = second.prepare('SELECT value FROM sentinel').get() as { value: string };
        expect(row.value).toBe('keep-me');
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });
});

describe('platform startup on a real database file', () => {
  let dir = '';
  let live: DatabaseHandle | undefined;

  afterEach(() => {
    if (live?.open === true) {
      live.close();
    }
    live = undefined;
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('closes the acquired handle on app shutdown and keeps settings after reopen', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-startup-'));
    const dbPath = join(dir, 'platform.db');
    const db = openDatabase(dbPath);
    live = db;
    applyMigrations(db);
    writeSettings(db, { idleMinutes: 15 });
    expect(db.open).toBe(true);

    const app = await buildApp(
      {
        host: '127.0.0.1',
        port: 0,
        logLevel: 'silent',
        dataDir: dir,
        publicUrl: 'http://127.0.0.1',
        authority: '127.0.0.1',
        cookieSecure: false,
        trustedProxies: [],
      },
      db,
    );
    await app.close();

    expect(db.open).toBe(false);

    const reopened = openDatabase(dbPath);
    try {
      applyMigrations(reopened);
      expect(readSettings(reopened).idleMinutes).toBe(15);
      expect(
        reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      reopened.close();
    }
  });
});

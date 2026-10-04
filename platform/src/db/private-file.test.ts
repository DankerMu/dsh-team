import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateDatabaseFile, tightenSqliteFiles } from './private-file.ts';

describe('private sqlite files', () => {
  let dir = '';

  afterEach(() => {
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('creates a missing database file as 0600 including parent directories', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'nested', 'platform.db');

    preparePrivateDatabaseFile(filename);

    expect(statSync(filename).isFile()).toBe(true);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing database file to 0600', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'platform.db');
    writeFileSync(filename, '');
    chmodSync(filename, 0o644);

    preparePrivateDatabaseFile(filename);

    expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it('does not turn a directory path into a 0600 file', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    mkdirSync(join(dir, 'not-a-db'));
    const before = statSync(join(dir, 'not-a-db')).mode;

    preparePrivateDatabaseFile(join(dir, 'not-a-db'));

    expect(statSync(join(dir, 'not-a-db')).isDirectory()).toBe(true);
    expect(statSync(join(dir, 'not-a-db')).mode).toBe(before);
  });

  it('does not chmod a directory when tightening sqlite files', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const destination = join(dir, 'not-a-db');
    mkdirSync(destination, { mode: 0o750 });
    chmodSync(destination, 0o750);
    const child = join(destination, 'sentinel.txt');
    writeFileSync(child, 'keep-me');

    try {
      expect(() => {
        tightenSqliteFiles(destination);
      }).toThrow();
      expect(statSync(destination).isDirectory()).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o750);
      expect(readFileSync(child, 'utf8')).toBe('keep-me');
    } finally {
      chmodSync(destination, 0o750);
    }
  });

  it('propagates a filesystem error for a self-referential symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'loop.db');
    symlinkSync(filename, filename);

    expect(() => {
      preparePrivateDatabaseFile(filename);
    }).toThrow(/ELOOP/);
  });

  it('tightens WAL and SHM sidecars when they exist and ignores missing ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'platform.db');
    writeFileSync(filename, '');
    writeFileSync(`${filename}-wal`, '');
    chmodSync(filename, 0o644);
    chmodSync(`${filename}-wal`, 0o644);

    tightenSqliteFiles(filename);

    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(statSync(`${filename}-wal`).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${filename}-shm`)).toThrow(/ENOENT/);
  });

  it('leaves a sidecar that is not a regular file unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'platform.db');
    writeFileSync(filename, '');
    mkdirSync(`${filename}-wal`);
    const before = statSync(`${filename}-wal`).mode;

    tightenSqliteFiles(filename);

    expect(statSync(`${filename}-wal`).isDirectory()).toBe(true);
    expect(statSync(`${filename}-wal`).mode).toBe(before);
  });

  it('propagates a filesystem error when tightening a self-referential sidecar', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const filename = join(dir, 'platform.db');
    writeFileSync(filename, '');
    symlinkSync(`${filename}-wal`, `${filename}-wal`);

    expect(() => {
      tightenSqliteFiles(filename);
    }).toThrow(/ELOOP/);
  });

  it('tightens sidecars of the resolved main file, not the alias spelling', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-db-file-'));
    const target = join(dir, 'target.db');
    const alias = join(dir, 'alias.db');
    writeFileSync(target, '');
    writeFileSync(`${target}-wal`, '');
    writeFileSync(`${target}-shm`, '');
    chmodSync(target, 0o644);
    chmodSync(`${target}-wal`, 0o644);
    chmodSync(`${target}-shm`, 0o644);
    symlinkSync(target, alias);

    tightenSqliteFiles(alias);

    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(`${target}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${target}-shm`).mode & 0o777).toBe(0o600);
  });
});

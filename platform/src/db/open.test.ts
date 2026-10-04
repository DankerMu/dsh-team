import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from './index.ts';

describe('openDatabase', () => {
  it('rejects a foreign-key violation in an in-memory database', () => {
    const db = openDatabase(':memory:');

    try {
      db.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id));
      `);

      expect(() => {
        db.prepare('INSERT INTO children (parent_id) VALUES (1)').run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('closes the acquired handle when initialization fails', () => {
    const handles: Database.Database[] = [];
    const failure = new Error('pragma refused');
    const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(function (
      this: Database.Database,
    ) {
      handles.push(this);
      throw failure;
    });

    try {
      expect(() => {
        openDatabase(':memory:');
      }).toThrow(failure);
      expect(handles[0]?.open).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a padded :memory: filename without creating a cwd-relative file', () => {
    const previous = process.cwd();
    const owned = mkdtempSync(join(tmpdir(), 'dsh-team-db-unit-'));
    let leaked: Database.Database | undefined;

    try {
      process.chdir(owned);
      try {
        leaked = openDatabase(' :memory: ');
      } catch {
        leaked = undefined;
      }
      leaked?.close();
      expect(leaked).toBeUndefined();
      expect(readdirSync(owned)).toEqual([]);
    } finally {
      leaked?.close();
      process.chdir(previous);
      rmSync(owned, { recursive: true, force: true });
    }
  });
});

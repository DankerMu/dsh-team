import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { applyMigrations, openDatabase, readSettings, writeSettings } from './index.ts';
import type { Settings } from './index.ts';

const DEFAULTS: Settings = {
  idleMinutes: 30,
  cpuCores: 2,
  memoryMiB: 4096,
  maxRunningInstances: 60,
  defaultPermissionTier: 'yolo',
  models: [],
};

const UNSAFE_INTEGER = 2 ** 53;
const INTEGER_FIELDS = ['idleMinutes', 'memoryMiB', 'maxRunningInstances'] as const;
const BAD_INTEGERS = [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '15', UNSAFE_INTEGER];
const FULL_PATCH: Settings = {
  idleMinutes: 15,
  cpuCores: 0.5,
  memoryMiB: 8192,
  maxRunningInstances: 2,
  defaultPermissionTier: 'approval',
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
};
const AFTER_PARTIAL: Settings = {
  ...FULL_PATCH,
  idleMinutes: 45,
  defaultPermissionTier: 'auto',
};
const PRIOR = { ...DEFAULTS, idleMinutes: 15 };
describe('settings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });
  describe('readSettings', () => {
    it('returns defaults without persisting rows when no settings are stored', () => {
      expect(readSettings(db)).toEqual(DEFAULTS);
      expect(db.prepare('SELECT key, value FROM settings').all()).toEqual([]);
    });

    it('returns independent models arrays so caller mutation cannot change later reads', () => {
      const first = readSettings(db);
      first.models.push({ name: 'mutated' });
      expect(readSettings(db)).toEqual(DEFAULTS);

      writeSettings(db, { models: [{ name: 'alpha' }] });
      const stored = readSettings(db);
      stored.models.push({ name: 'mutated' });
      expect(readSettings(db)).toEqual({ ...DEFAULTS, models: [{ name: 'alpha' }] });
    });
  });
  describe('writeSettings', () => {
    it('persists a valid patch, overwrites supplied fields, and leaves omitted fields unchanged', () => {
      writeSettings(db, FULL_PATCH);
      expect(readSettings(db)).toEqual(FULL_PATCH);

      writeSettings(db, { defaultPermissionTier: 'auto', idleMinutes: 45 });
      expect(readSettings(db)).toEqual(AFTER_PARTIAL);

      writeSettings(db, {});
      expect(readSettings(db)).toEqual(AFTER_PARTIAL);
    });

    it('leaves unowned stored keys untouched and omitted from the read result', () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('legacyKey', '"legacy"');

      writeSettings(db, { idleMinutes: 10 });

      expect(readSettings(db)).toEqual({ ...DEFAULTS, idleMinutes: 10 });
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('legacyKey')).toEqual({
        value: '"legacy"',
      });
    });
  });
  describe('writeSettings validation', () => {
    it.each(
      INTEGER_FIELDS.flatMap((field) => BAD_INTEGERS.map((value) => [field, value] as const)),
    )('rejects %s with an invalid value and leaves prior rows unchanged', (field, value) => {
      writeSettings(db, { idleMinutes: 15 });

      expect(() => {
        writeSettings(db, { [field]: value });
      }).toThrow(new RegExp(field));
      expect(readSettings(db)).toEqual(PRIOR);
    });

    it.each([
      ['cpuCores', 0],
      ['cpuCores', -0.5],
      ['cpuCores', Number.NaN],
      ['cpuCores', Number.POSITIVE_INFINITY],
      ['cpuCores', '2'],
      ['defaultPermissionTier', 'admin'],
      ['defaultPermissionTier', ''],
      ['defaultPermissionTier', 5],
      ['models', 'x'],
      ['models', 5],
      ['models', {}],
      ['models', [null]],
      ['models', [5]],
      ['models', [[]]],
      ['models', [{ name: '' }]],
      ['models', [{ name: '   ' }]],
      ['models', [{ name: 5 }]],
      ['models', [{ name: null }]],
      ['models', [{ name: 'alpha', contextWindow: 0 }]],
      ['models', [{ name: 'alpha', contextWindow: -1 }]],
      ['models', [{ name: 'alpha', contextWindow: 1.5 }]],
      ['models', [{ name: 'alpha', contextWindow: null }]],
      ['models', [{ name: 'alpha', contextWindow: undefined }]],
      ['models', [{ name: 'alpha', contextWindow: 'x' }]],
      ['models', [{ name: 'alpha', contextWindow: UNSAFE_INTEGER }]],
    ])('rejects %s with an invalid value and leaves prior rows unchanged', (field, value) => {
      writeSettings(db, { idleMinutes: 15 });

      expect(() => {
        writeSettings(db, { [field]: value });
      }).toThrow(new RegExp(field));
      expect(readSettings(db)).toEqual(PRIOR);
    });

    it.each(['unknownKey', 'toString'])(
      'rejects unknown patch field %s before mutation',
      (field) => {
        writeSettings(db, { idleMinutes: 15 });

        expect(() => {
          writeSettings(db, { [field]: 1 });
        }).toThrow(new RegExp(field));
        expect(readSettings(db)).toEqual(PRIOR);
      },
    );

    it.each([
      [null, 'patch'],
      [[], 'patch'],
      [5, 'patch'],
    ])('rejects a non-object patch and names the patch', (patch, label) => {
      writeSettings(db, { idleMinutes: 15 });

      expect(() => {
        writeSettings(db, patch);
      }).toThrow(new RegExp(label));
      expect(readSettings(db)).toEqual(PRIOR);
    });
  });
  describe('readSettings corruption', () => {
    it.each([
      ['idleMinutes', '"abc"'],
      ['memoryMiB', '1.5'],
      ['maxRunningInstances', '0'],
      ['cpuCores', 'true'],
      ['defaultPermissionTier', '"admin"'],
      ['models', '"x"'],
      ['models', '[{"name":""}]'],
      ['models', '[null]'],
      ['idleMinutes', '{not-json-CORRUPT_SENTINEL'],
    ])('rejects stored %s corruption without echoing the raw sentinel', (field, stored) => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(field, stored);

      expect(() => {
        readSettings(db);
      }).toThrow(new RegExp(field));
      try {
        readSettings(db);
      } catch (error) {
        expect(String(error)).not.toContain('CORRUPT_SENTINEL');
      }
    });

    it('ignores unowned malformed JSON and still reads a valid owned row', () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'legacyKey',
        '{not-json-UNOWNED_SENTINEL',
      );
      writeSettings(db, { idleMinutes: 15 });

      expect(readSettings(db)).toEqual(PRIOR);
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('legacyKey')).toEqual({
        value: '{not-json-UNOWNED_SENTINEL',
      });
    });
  });
  describe('writeSettings atomicity', () => {
    it.each(['toString', 'constructor'])(
      'rejects prototype-inherited permission tier %s and leaves prior rows unchanged',
      (tier) => {
        writeSettings(db, { idleMinutes: 15 });

        expect(() => {
          writeSettings(db, { defaultPermissionTier: tier });
        }).toThrow(/defaultPermissionTier/);
        expect(readSettings(db)).toEqual(PRIOR);
      },
    );

    it('rejects a later invalid field without writing a preceding valid field', () => {
      writeSettings(db, { idleMinutes: 15 });

      expect(() => {
        writeSettings(db, { cpuCores: 0.5, memoryMiB: 0 });
      }).toThrow(/memoryMiB/);
      expect(readSettings(db)).toEqual(PRIOR);
    });

    it('rolls back an earlier upsert when a later SQLite constraint aborts the transaction', () => {
      writeSettings(db, { idleMinutes: 15, cpuCores: 0.5 });
      const before = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
      db.exec(`
        CREATE TRIGGER abort_later_upsert
        BEFORE INSERT ON settings
        WHEN NEW.key = 'memoryMiB'
        BEGIN
          SELECT RAISE(ABORT, 'forced abort');
        END;
      `);

      expect(() => {
        writeSettings(db, { maxRunningInstances: 3, memoryMiB: 256 });
      }).toThrow(/forced abort/);
      expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(before);
      expect(readSettings(db)).toEqual({ ...DEFAULTS, idleMinutes: 15, cpuCores: 0.5 });
    });
  });
});

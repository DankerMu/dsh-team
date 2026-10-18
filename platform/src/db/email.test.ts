import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from './index.ts';
import { assertCompatibleAccountEmails, hasBoundedEmailLength } from './email.ts';

it.each(['a', '\u{10000}', '\ud800', '\0'])('bounds persisted email code points for %j', (unit) => {
  expect(hasBoundedEmailLength(unit.repeat(254))).toBe(true);
  expect(hasBoundedEmailLength(unit.repeat(255))).toBe(false);
  expect(hasBoundedEmailLength('')).toBe(true);
});

it.each(['active', 'disabled'])(
  'refuses an over-limit %s account without changing history',
  (status) => {
    const database = openDatabase(':memory:');
    try {
      applyMigrations(database);
      database
        .prepare("INSERT INTO users VALUES ('oldaccount01', ?, 'unused', 'employee', ?, 1)")
        .run(`a\0${'x'.repeat(251)}@b`, status);
      const before = database.prepare('SELECT * FROM users').all();

      expect(() => {
        assertCompatibleAccountEmails(database);
      }).toThrow(
        'Account email exceeds 254 Unicode code points; correct accounts offline before startup',
      );
      expect(database.prepare('SELECT * FROM users').all()).toEqual(before);

      const email = `${'\u{10000}'.repeat(252)}@b`;
      database.prepare('UPDATE users SET email = ?').run(email);
      database
        .prepare(
          "INSERT INTO audit_events (created_at, event_type, details, actor_email) VALUES (1, 'login.failed', '{}', ?)",
        )
        .run('history'.repeat(100));
      const audits = database.prepare('SELECT * FROM audit_events').all();
      assertCompatibleAccountEmails(database);
      expect(database.prepare('SELECT email, status FROM users').all()).toEqual([
        { email, status },
      ]);
      expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
    } finally {
      database.close();
    }
  },
);

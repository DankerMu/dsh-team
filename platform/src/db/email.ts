import { hasCodePointLength } from '../unicode.ts';
import type { DatabaseHandle } from './open.ts';

export function hasBoundedEmailLength(email: string): boolean {
  return hasCodePointLength(email, 0, 254);
}

export function assertCompatibleAccountEmails(database: DatabaseHandle): void {
  for (const row of database.prepare<[], { email: string }>('SELECT email FROM users').iterate()) {
    if (!hasBoundedEmailLength(row.email)) {
      throw new Error(
        'Account email exceeds 254 Unicode code points; correct accounts offline before startup',
      );
    }
  }
}

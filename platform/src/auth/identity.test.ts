import { describe, expect, it } from 'vitest';
import { generateUserId, normalizeEmail } from './identity.ts';

describe('account identity policy', () => {
  it.each([
    ['  User@Example.com  ', 'user@example.com'],
    ['a@b', 'a@b'],
    ['员工@EXAMPLE.COM', '员工@example.com'],
  ])('canonicalizes email %s', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it.each(['', '   ', '@example.com', 'user@', 'user@@example.com', 'user @example.com', 'a@b\nc'])(
    'rejects invalid email without returning supplied content: %s',
    (raw) => {
      expect(normalizeEmail(raw)).toBeNull();
    },
  );

  it('creates a twelve-character lowercase alphanumeric account identity', () => {
    expect(generateUserId()).toMatch(/^[a-z0-9]{12}$/);
  });
});

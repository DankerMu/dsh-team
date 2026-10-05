import { describe, expect, it } from 'vitest';
import { formatSessionCookie, readSessionCookie } from './session-cookie.ts';

const TOKEN = 'a'.repeat(64);

describe('formatSessionCookie', () => {
  it('serializes Path, HttpOnly, and SameSite=Lax without Secure or Domain by default', () => {
    const header = formatSessionCookie(TOKEN, false);
    const attributes = header
      .split(';')
      .slice(1)
      .map((part) => part.trim())
      .sort();

    expect(header.startsWith(`platform_session=${TOKEN};`)).toBe(true);
    expect(attributes).toEqual(['HttpOnly', 'Path=/', 'SameSite=Lax']);
    expect(header).not.toContain('Secure');
    expect(header).not.toContain('Domain=');
  });

  it('appends Secure when cookieSecure is true and still omits Domain', () => {
    const header = formatSessionCookie(TOKEN, true);
    const attributes = header
      .split(';')
      .slice(1)
      .map((part) => part.trim())
      .sort();

    expect(header.startsWith(`platform_session=${TOKEN};`)).toBe(true);
    expect(attributes).toEqual(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']);
    expect(header).not.toContain('Domain=');
  });

  it.each([false, true] as const)(
    'clears an empty platform_session cookie with Max-Age=0 when cookieSecure is %s',
    (cookieSecure) => {
      const header = formatSessionCookie(null, cookieSecure);
      const attributes = header
        .split(';')
        .slice(1)
        .map((part) => part.trim())
        .sort();
      const expected = cookieSecure
        ? ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Lax', 'Secure']
        : ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Lax'];

      expect(header.startsWith('platform_session=;')).toBe(true);
      expect(attributes).toEqual(expected);
      expect(header).not.toContain('Domain=');
    },
  );
});

describe('readSessionCookie', () => {
  it('returns the exact platform_session token when unrelated cookies coexist', () => {
    expect(readSessionCookie(`theme=dark; platform_session=${TOKEN}; locale=en`)).toBe(TOKEN);
  });

  it('returns null when the cookie header is absent', () => {
    expect(readSessionCookie(undefined)).toBeNull();
  });

  it('returns null when the exact cookie name is absent among other cookies', () => {
    expect(readSessionCookie('theme=dark; other_session=abc')).toBeNull();
  });

  it('returns null for duplicate platform_session cookies even when the values match', () => {
    expect(readSessionCookie(`platform_session=${TOKEN}; platform_session=${TOKEN}`)).toBeNull();
  });

  it('returns null for a malformed token value', () => {
    expect(readSessionCookie(`platform_session=${'a'.repeat(63)}g`)).toBeNull();
  });

  it('returns null for an uppercase token value', () => {
    expect(readSessionCookie(`platform_session=${'A'.repeat(64)}`)).toBeNull();
  });

  it('returns null for a percent-encoded token value', () => {
    expect(readSessionCookie(`platform_session=%61${TOKEN.slice(1)}`)).toBeNull();
  });
});

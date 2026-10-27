import { describe, expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { cookieForms, sessionHealCookies, shadowPaths } from './session-heal.ts';

const SESSION = `platform_session=${'a'.repeat(64)}`;
const SHADOW = `platform_session=${'b'.repeat(64)}`;

describe('cookieForms', () => {
  it.each(['127.0.0.1', '10.1.2.3', '[::1]', '[2001:db8::1]'])(
    'gives an IP literal %s the host-only form only',
    (hostname) => {
      expect(cookieForms(hostname, false)).toEqual(['']);
    },
  );

  it('adds the hostname and each parent domain except the last label for a DNS name', () => {
    expect(cookieForms('dsh.corp.example', false)).toEqual([
      '',
      '; Domain=dsh.corp.example',
      '; Domain=corp.example',
    ]);
  });

  it('gives a single-label DNS name no Domain form', () => {
    expect(cookieForms('localhost', false)).toEqual(['']);
  });

  it('adds Secure and Partitioned; Secure variants of every form for HTTPS', () => {
    expect(cookieForms('corp.example', true)).toEqual([
      '',
      '; Secure',
      '; Partitioned; Secure',
      '; Domain=corp.example',
      '; Domain=corp.example; Secure',
      '; Domain=corp.example; Partitioned; Secure',
    ]);
    expect(cookieForms('127.0.0.1', true)).toEqual(['', '; Secure', '; Partitioned; Secure']);
  });
});

describe('shadowPaths', () => {
  const login = [
    '/_platform',
    '/_platform/',
    '/_platform/api',
    '/_platform/api/',
    '/_platform/api/login',
    '/_platform/api/login/',
  ];

  it('lists every non-root ancestor with and without a trailing slash', () => {
    expect(shadowPaths('/_platform/api/login')).toEqual(login);
  });

  it('ignores the query and a trailing slash', () => {
    expect(shadowPaths('/_platform/api/login/?x=1')).toEqual(login);
  });

  it('gives the root no non-root path', () => {
    expect(shadowPaths('/')).toEqual([]);
    expect(shadowPaths('/?x=1')).toEqual([]);
  });

  it('gives a one-segment path itself with and without a trailing slash', () => {
    expect(shadowPaths('/foo')).toEqual(['/foo', '/foo/']);
  });

  it('gives a target that is not origin-form no path', () => {
    expect(shadowPaths('*')).toEqual([]);
  });
});

describe('sessionHealCookies', () => {
  it.each([undefined, '', 'theme=dark', SESSION, `theme=dark; ${SESSION}`])(
    'heals nothing without a duplicate session cookie in %j',
    (header) => {
      expect(sessionHealCookies(header, '/_platform/api/login', 'dsh.corp.example', true)).toEqual(
        [],
      );
    },
  );

  it('expires every shadowing path host-only for an IP host and never Path=/', () => {
    expect(sessionHealCookies(`${SESSION}; ${SHADOW}`, '/foo/bar', '127.0.0.1', false)).toEqual([
      'platform_session=; Path=/foo; Max-Age=0',
      'platform_session=; Path=/foo/; Max-Age=0',
      'platform_session=; Path=/foo/bar; Max-Age=0',
      'platform_session=; Path=/foo/bar/; Max-Age=0',
    ]);
  });

  it('heals a credential request that carries any session pair, including a single one', () => {
    const expected = [
      'platform_session=; Path=/x; Max-Age=0',
      'platform_session=; Path=/x/; Max-Age=0',
    ];

    expect(sessionHealCookies(SHADOW, '/x', '127.0.0.1', false, true)).toEqual(expected);
    expect(sessionHealCookies('platform_session', '/x', '127.0.0.1', false, true)).toEqual([
      ...expected,
      'platform_session; Path=/x; Max-Age=0',
      'platform_session; Path=/x/; Max-Age=0',
      'platform_session; Path=/; Max-Age=0',
    ]);
    expect(sessionHealCookies('theme=dark', '/x', '127.0.0.1', false, true)).toEqual([]);
    expect(sessionHealCookies(undefined, '/x', '127.0.0.1', false, true)).toEqual([]);
  });

  it('expires a bare fragment in nameless form at every heal path and the root', () => {
    expect(sessionHealCookies(`${SESSION}; platform_session`, '/x', '127.0.0.1', false)).toEqual([
      'platform_session=; Path=/x; Max-Age=0',
      'platform_session=; Path=/x/; Max-Age=0',
      'platform_session; Path=/x; Max-Age=0',
      'platform_session; Path=/x/; Max-Age=0',
      'platform_session; Path=/; Max-Age=0',
    ]);
  });

  it('expires a bare fragment in every form, including the Domain forms at the root', () => {
    const cookies = sessionHealCookies('platform_session', '/x', 'corp.example', true, true);

    expect(cookies.filter((cookie) => cookie.startsWith('platform_session;'))).toEqual(
      ['/x', '/x/', '/'].flatMap((path) =>
        ['', '; Domain=corp.example'].flatMap((form) =>
          [form, `${form}; Secure`, `${form}; Partitioned; Secure`].map(
            (variant) => `platform_session; Path=${path}${variant}; Max-Age=0`,
          ),
        ),
      ),
    );
  });

  it('adds Path=/ only in Domain forms and the host-only partitioned form for an HTTPS DNS host', () => {
    const cookies = sessionHealCookies(`${SESSION}; ${SHADOW}`, '/x', 'dsh.corp.example', true);

    expect(cookies).toHaveLength(2 * 9 + 7);
    const roots = cookies.filter((cookie) => cookie.includes('Path=/;'));
    expect(roots).toEqual([
      'platform_session=; Path=/; Domain=dsh.corp.example; Max-Age=0',
      'platform_session=; Path=/; Domain=dsh.corp.example; Secure; Max-Age=0',
      'platform_session=; Path=/; Domain=dsh.corp.example; Partitioned; Secure; Max-Age=0',
      'platform_session=; Path=/; Domain=corp.example; Max-Age=0',
      'platform_session=; Path=/; Domain=corp.example; Secure; Max-Age=0',
      'platform_session=; Path=/; Domain=corp.example; Partitioned; Secure; Max-Age=0',
      'platform_session=; Path=/; Partitioned; Secure; Max-Age=0',
    ]);
    expect(cookies).toContain('platform_session=; Path=/x/; Partitioned; Secure; Max-Age=0');
  });

  it('adds only the host-only partitioned root expiry for an HTTPS IP host', () => {
    expect(
      sessionHealCookies(`${SESSION}; ${SHADOW}`, '/x', '127.0.0.1', true).filter((cookie) =>
        cookie.includes('Path=/;'),
      ),
    ).toEqual(['platform_session=; Path=/; Partitioned; Secure; Max-Age=0']);
  });

  it.each([
    ['512 characters', `/${'a'.repeat(511)}`, 2],
    ['16 segments', '/a'.repeat(16), 32],
    ['a long query', `/x?${'q'.repeat(4096)}`, 2],
  ])('heals a path within the bounds: %s', (_name, target, count) => {
    expect(sessionHealCookies(`${SESSION}; ${SHADOW}`, target, '127.0.0.1', false)).toHaveLength(
      count,
    );
  });

  it.each([
    ['513 characters', `/${'a'.repeat(512)}`],
    ['17 segments', '/a'.repeat(17)],
    ['thousands of slashes', '/'.repeat(16200)],
    ['a semicolon attribute injection', '/z/;Path=/'],
    ['a control character', '/a\u0001b'],
    ['a non-ASCII character', '/caf\u00e9'],
  ])('emits nothing outside the bounds: %s', (_name, target) => {
    for (const header of [`${SESSION}; ${SHADOW}`, `${SESSION}; platform_session`])
      expect(sessionHealCookies(header, target, 'dsh.corp.example', true, true)).toEqual([]);
  });
});

describe('installSessionHeal', () => {
  it('appends the expiries to a platform answer and leaves admission anonymous', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        url: '/_platform/api/session',
        headers: { cookie: `${SESSION}; ${SHADOW}` },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toEqual(
        [
          '/_platform',
          '/_platform/',
          '/_platform/api',
          '/_platform/api/',
          '/_platform/api/session',
          '/_platform/api/session/',
        ].map((path) => `platform_session=; Path=${path}; Max-Age=0`),
      );
    });
  });
});

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

  it('adds only a Partitioned; Secure variant of every form for HTTPS', () => {
    expect(cookieForms('corp.example', true)).toEqual([
      '',
      '; Partitioned; Secure',
      '; Domain=corp.example',
      '; Domain=corp.example; Partitioned; Secure',
    ]);
    expect(cookieForms('127.0.0.1', true)).toEqual(['', '; Partitioned; Secure']);
  });
});

describe('shadowPaths', () => {
  const login = [
    '/_platform/api/login/',
    '/_platform/api/login',
    '/_platform/api/',
    '/_platform/api',
    '/_platform/',
    '/_platform',
  ];

  it('lists every non-root ancestor with and without a trailing slash, deepest first', () => {
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
    expect(shadowPaths('/foo')).toEqual(['/foo/', '/foo']);
  });

  it('gives a target that is not origin-form no path', () => {
    expect(shadowPaths('*')).toEqual([]);
  });
});

const named = (path: string, form = '') => `platform_session=; Path=${path}${form}; Max-Age=0`;
const nameless = (path: string, form = '') => `platform_session; Path=${path}${form}; Max-Age=0`;
const PARTITIONED = '; Partitioned; Secure';
const LOGIN_DEEPEST_FIRST = [
  '/_platform/api/login/',
  '/_platform/api/login',
  '/_platform/api/',
  '/_platform/api',
  '/_platform/',
  '/_platform',
];

function bytes(cookies: readonly string[]): number {
  return cookies.reduce((total, cookie) => total + cookie.length, 0);
}

describe('sessionHealCookies', () => {
  it.each([undefined, '', 'theme=dark', SESSION, `theme=dark; ${SESSION}`])(
    'heals nothing without a duplicate session cookie in %j',
    (header) => {
      expect(sessionHealCookies(header, '/_platform/api/login', 'dsh.corp.example', true)).toEqual(
        [],
      );
    },
  );

  it('expires every shadowing path host-only, deepest first, for an IP host and never Path=/', () => {
    expect(sessionHealCookies(`${SESSION}; ${SHADOW}`, '/foo/bar', '127.0.0.1', false)).toEqual([
      named('/foo/bar/'),
      named('/foo/bar'),
      named('/foo/'),
      named('/foo'),
    ]);
  });

  it('heals a credential request that carries any session pair, including a single one', () => {
    expect(sessionHealCookies(SHADOW, '/x', '127.0.0.1', false, true)).toEqual([
      named('/x/'),
      named('/x'),
    ]);
    expect(sessionHealCookies('platform_session', '/x', '127.0.0.1', false, true)).toEqual([
      named('/x/'),
      named('/x'),
      nameless('/x/'),
      nameless('/x'),
      nameless('/'),
    ]);
    expect(sessionHealCookies('theme=dark', '/x', '127.0.0.1', false, true)).toEqual([]);
    expect(sessionHealCookies(undefined, '/x', '127.0.0.1', false, true)).toEqual([]);
  });

  it('expires a bare fragment in nameless host-only form after the named ones, at the root too', () => {
    expect(sessionHealCookies(`${SESSION}; platform_session`, '/x', '127.0.0.1', false)).toEqual([
      named('/x/'),
      named('/x'),
      nameless('/x/'),
      nameless('/x'),
      nameless('/'),
    ]);
  });

  it('orders host-only, nameless, Domain and then Partitioned forms on an HTTPS DNS host', () => {
    const domain = '; Domain=corp.example';

    expect(sessionHealCookies('platform_session', '/x', 'corp.example', true, true)).toEqual([
      named('/x/'),
      named('/x'),
      nameless('/x/'),
      nameless('/x'),
      nameless('/'),
      named('/x/', domain),
      named('/x', domain),
      named('/', domain),
      nameless('/x/', domain),
      nameless('/x', domain),
      nameless('/', domain),
      named('/x/', PARTITIONED),
      named('/x', PARTITIONED),
      nameless('/x/', PARTITIONED),
      nameless('/x', PARTITIONED),
      nameless('/', PARTITIONED),
      named('/x/', `${domain}${PARTITIONED}`),
      named('/x', `${domain}${PARTITIONED}`),
      named('/', `${domain}${PARTITIONED}`),
      nameless('/x/', `${domain}${PARTITIONED}`),
      nameless('/x', `${domain}${PARTITIONED}`),
      nameless('/', `${domain}${PARTITIONED}`),
    ]);
  });

  it('visits every Domain form per ancestor and never a plain Secure or a host-only named root', () => {
    const cookies = sessionHealCookies(`${SESSION}; ${SHADOW}`, '/x', 'dsh.corp.example', true);

    expect(cookies.slice(0, 8)).toEqual([
      named('/x/'),
      named('/x'),
      named('/x/', '; Domain=dsh.corp.example'),
      named('/x/', '; Domain=corp.example'),
      named('/x', '; Domain=dsh.corp.example'),
      named('/x', '; Domain=corp.example'),
      named('/', '; Domain=dsh.corp.example'),
      named('/', '; Domain=corp.example'),
    ]);
    expect(cookies.slice(8)).toEqual(
      cookies
        .slice(0, 8)
        .map((cookie) => cookie.replace('; Max-Age=0', `${PARTITIONED}; Max-Age=0`)),
    );
    expect(
      cookies.filter((cookie) => cookie.includes('Secure') && !cookie.includes(PARTITIONED)),
    ).toEqual([]);
    expect(
      cookies.filter(
        (cookie) => cookie.startsWith('platform_session=; Path=/;') && !cookie.includes('Domain='),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a stale session', SHADOW, 6],
    ['a bare fragment', 'platform_session', 13],
  ])(
    'heals a typical HTTPS login carrying %s host-only first within 3 KiB',
    (_name, header, hostOnly) => {
      const cookies = sessionHealCookies(
        header,
        '/_platform/api/login',
        'dsh.corp.example',
        true,
        true,
      );

      expect(cookies.slice(0, hostOnly)).toEqual([
        ...LOGIN_DEEPEST_FIRST.map((path) => named(path)),
        ...(hostOnly === 6 ? [] : [...LOGIN_DEEPEST_FIRST, '/'].map((path) => nameless(path))),
      ]);
      expect(bytes(cookies)).toBeLessThanOrEqual(3072);
    },
  );

  it('stops at the 3 KiB budget in priority order for the worst-case path and host', () => {
    const path = '/'.concat(Array.from({ length: 8 }, () => 'a'.repeat(31)).join('/'));
    const cookies = sessionHealCookies(`${SESSION}; platform_session`, path, 'a.b.c.d.e.f', true);

    expect(path).toHaveLength(256);
    expect(cookies).toEqual(shadowPaths(path).map((ancestor) => named(ancestor)));
    expect(cookies).toHaveLength(16);
    expect(bytes(cookies)).toBeLessThanOrEqual(3072);
  });

  it.each([
    ['256 characters', `/${'a'.repeat(255)}`, 2],
    ['8 segments', '/a'.repeat(8), 16],
    ['a long query', `/x?${'q'.repeat(4096)}`, 2],
  ])('heals a path within the bounds: %s', (_name, target, count) => {
    expect(sessionHealCookies(`${SESSION}; ${SHADOW}`, target, '127.0.0.1', false)).toHaveLength(
      count,
    );
  });

  it.each([
    ['257 characters', `/${'a'.repeat(256)}`],
    ['9 segments', '/a'.repeat(9)],
    ['thousands of slashes', '/'.repeat(16200)],
    ['a semicolon attribute injection', '/z/;Path=/'],
    ['a control character', '/a\u0001b'],
    ['a non-ASCII character', '/café'],
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
          '/_platform/api/session/',
          '/_platform/api/session',
          '/_platform/api/',
          '/_platform/api',
          '/_platform/',
          '/_platform',
        ].map((path) => named(path)),
      );
    });
  });
});

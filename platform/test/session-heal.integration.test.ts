import type { IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  jsonRequestHeaders,
  sessionCookieToken,
  withApp,
} from './auth-fixture.ts';
import { sendHttp } from './gateway-http-fixture.ts';

const SHADOW = `platform_session=${'b'.repeat(64)}`;
const SESSION_PATHS = [
  '/_platform',
  '/_platform/',
  '/_platform/api',
  '/_platform/api/',
  '/_platform/api/session',
  '/_platform/api/session/',
];

function setCookies(headers: IncomingHttpHeaders): string[] {
  return headers['set-cookie'] ?? [];
}

function expiries(paths: readonly string[], forms: readonly string[]): string[] {
  return paths.flatMap((path) =>
    forms.map((form) => `platform_session=; Path=${path}${form}; Max-Age=0`),
  );
}

it('answers a duplicate-cookie session read 401 with host-only expiries and never Path=/ on an IP host', async () => {
  await withApp(async (app) => {
    const registered = await injectRegister(app, {
      email: 'a@example.com',
      password: 'test-password',
    });
    const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });

    const healed = await sendHttp(base, {
      path: '/_platform/api/session?x=1',
      headers: { cookie: `${cookie}; theme=dark; ${SHADOW}` },
    });
    const single = await sendHttp(base, { path: '/_platform/api/session', headers: { cookie } });

    expect(healed.status).toBe(401);
    expect(setCookies(healed.headers)).toEqual(expiries(SESSION_PATHS, ['']));
    expect(setCookies(healed.headers).some((line) => line.includes('Path=/;'))).toBe(false);
    expect(single.status).toBe(200);
    expect(single.headers['set-cookie']).toBeUndefined();
  });
});

it('expires every Domain, Secure and Partitioned form and only Domain forms at Path=/ on an HTTPS DNS host', async () => {
  await withApp(
    async (app) => {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });

      const healed = await sendHttp(base, {
        path: '/_platform/api/session',
        headers: { cookie: `${SHADOW}; platform_session=${'c'.repeat(64)}` },
      });

      const forms = ['', '; Domain=dsh.corp.example', '; Domain=corp.example'].flatMap((form) => [
        form,
        `${form}; Secure`,
        `${form}; Partitioned; Secure`,
      ]);
      expect(healed.status).toBe(401);
      expect(setCookies(healed.headers)).toEqual([
        ...expiries(SESSION_PATHS, forms),
        ...expiries(['/'], forms.slice(3)),
      ]);
    },
    true,
    [],
    undefined,
    { publicUrl: 'https://dsh.corp.example' },
  );
});

it('heals a duplicate-cookie login while issuing the new root session', async () => {
  await withApp(async (app) => {
    await injectRegister(app, { email: 'b@example.com', password: 'test-password' });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });

    const login = await sendHttp(
      base,
      {
        method: 'POST',
        path: '/_platform/api/login',
        headers: {
          ...jsonRequestHeaders(),
          cookie: `platform_session=${'a'.repeat(64)}; ${SHADOW}`,
        },
      },
      JSON.stringify({ email: 'b@example.com', password: 'test-password' }),
    );

    expect(login.status).toBe(200);
    const lines = setCookies(login.headers);
    const issued = lines.filter((line) => !line.startsWith('platform_session=;'));
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatch(/^platform_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(lines.filter((line) => line.startsWith('platform_session=;'))).toEqual(
      expiries(
        [
          '/_platform',
          '/_platform/',
          '/_platform/api',
          '/_platform/api/',
          '/_platform/api/login',
          '/_platform/api/login/',
        ],
        [''],
      ),
    );
  });
});

it.each([
  ['/_platform/api/login', 'single@example.com', 200],
  ['/_platform/api/register', 'new@example.com', 201],
] as const)(
  'heals a single planted session cookie on %s while issuing the new root session',
  async (path, email, status) => {
    await withApp(async (app) => {
      await injectRegister(app, { email: 'single@example.com', password: 'test-password' });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });

      const response = await sendHttp(
        base,
        { method: 'POST', path, headers: { ...jsonRequestHeaders(), cookie: SHADOW } },
        JSON.stringify({ email, password: 'test-password' }),
      );

      expect(response.status).toBe(status);
      const lines = setCookies(response.headers);
      expect(lines.filter((line) => !line.startsWith('platform_session=;'))).toEqual([
        expect.stringMatching(/^platform_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax$/),
      ]);
      const segments = path.split('/').slice(1);
      expect(lines.filter((line) => line.startsWith('platform_session=;'))).toEqual(
        expiries(
          segments.flatMap((_segment, index) => {
            const ancestor = `/${segments.slice(0, index + 1).join('/')}`;
            return [ancestor, `${ancestor}/`];
          }),
          [''],
        ),
      );
    });
  },
);

it.each([
  ['text/html', 302, { location: '/_platform/login' }],
  ['application/json', 401, {}],
] as const)(
  'keeps the anonymous gateway answer for %s and adds the expiries',
  async (accept, status, extra) => {
    await withApp(async (app) => {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });

      const response = await sendHttp(base, {
        path: '/workbench/app?x=1',
        headers: { accept, cookie: `platform_session=${'a'.repeat(64)}; ${SHADOW}` },
      });

      expect(response.status).toBe(status);
      expect(response.headers).toMatchObject(extra);
      expect(setCookies(response.headers)).toEqual(
        expiries(['/workbench', '/workbench/', '/workbench/app', '/workbench/app/'], ['']),
      );
    });
  },
);

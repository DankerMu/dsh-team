import type { IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  jsonRequestHeaders,
  sessionCookieToken,
  withApp,
} from './auth-fixture.ts';
import { rejectedUpgrade, sendHttp } from './gateway-http-fixture.ts';

const SHADOW = `platform_session=${'b'.repeat(64)}`;
// Deepest ancestor first: the heal's fixed priority order.
const SESSION_PATHS = [
  '/_platform/api/session/',
  '/_platform/api/session',
  '/_platform/api/',
  '/_platform/api',
  '/_platform/',
  '/_platform',
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

it('emits host-only, Domain and then Partitioned forms then stops at 3 KiB on an HTTPS four-label host', async () => {
  await withApp(
    async (app) => {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });

      const healed = await sendHttp(base, {
        path: '/_platform/api/session',
        headers: { cookie: `${SHADOW}; platform_session=${'c'.repeat(64)}` },
      });

      const domains = [
        '; Domain=dsh.a.corp.example',
        '; Domain=a.corp.example',
        '; Domain=corp.example',
      ];
      const unpartitioned = [
        ...expiries(SESSION_PATHS, ['']),
        ...expiries([...SESSION_PATHS, '/'], domains),
      ];
      const priority = [
        ...unpartitioned,
        ...unpartitioned.map((line) =>
          line.replace('; Max-Age=0', '; Partitioned; Secure; Max-Age=0'),
        ),
      ];
      const budgeted: string[] = [];
      let total = 0;
      for (const line of priority) {
        if (total + line.length > 3072) break;
        budgeted.push(line);
        total += line.length;
      }
      expect(healed.status).toBe(401);
      expect(budgeted.length).toBeLessThan(priority.length);
      expect(budgeted.length).toBeGreaterThan(unpartitioned.length);
      expect(setCookies(healed.headers)).toEqual(budgeted);
    },
    true,
    [],
    undefined,
    { publicUrl: 'https://dsh.a.corp.example' },
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
          '/_platform/api/login/',
          '/_platform/api/login',
          '/_platform/api/',
          '/_platform/api',
          '/_platform/',
          '/_platform',
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
          segments
            .map((_segment, index) => `/${segments.slice(0, index + 1).join('/')}`)
            .reverse()
            .flatMap((ancestor) => [`${ancestor}/`, ancestor]),
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
        expiries(['/workbench/app/', '/workbench/app', '/workbench/', '/workbench'], ['']),
      );
    });
  },
);

it('expires a bare platform_session fragment in nameless form, including at the root', async () => {
  await withApp(async (app) => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });

    const healed = await sendHttp(base, {
      path: '/_platform/api/session',
      headers: { cookie: `platform_session=${'a'.repeat(64)}; platform_session` },
    });

    expect(healed.status).toBe(401);
    expect(setCookies(healed.headers)).toEqual([
      ...expiries(SESSION_PATHS, ['']),
      ...[...SESSION_PATHS, '/'].map((path) => `platform_session; Path=${path}; Max-Age=0`),
    ]);
  });
});

it('ignores an unbounded path on an HTTPS DNS host and keeps serving', async () => {
  await withApp(
    async (app) => {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const cookie = `platform_session=${'a'.repeat(64)}; ${SHADOW}; platform_session`;
      // Large enough to amplify quadratically, small enough to stay under Node's 16 KiB header limit.
      const path = '/'.repeat(15000);

      const upgrade = await rejectedUpgrade(
        base,
        cookie,
        ['Origin: https://dsh.corp.example', 'Upgrade: websocket'],
        path,
      );
      const http = await sendHttp(base, { path, headers: { cookie } });
      const injected = await sendHttp(base, { path: '/z/;Path=/', headers: { cookie } });
      const health = await sendHttp(base, { path: '/healthz' });

      expect(upgrade).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
      expect(upgrade.toLowerCase()).not.toContain('set-cookie');
      expect(http.status).toBe(401);
      expect(http.headers['set-cookie']).toBeUndefined();
      expect(injected.status).toBe(401);
      expect(injected.headers['set-cookie']).toBeUndefined();
      expect(health.status).toBe(200);
    },
    true,
    [],
    undefined,
    { publicUrl: 'https://dsh.corp.example' },
  );
});

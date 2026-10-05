import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  cookieAttributes,
  cookieHeaders,
  injectLogin,
  injectRegister,
  type PublicIdentity,
  readPublicIdentity,
  sessionCookieHeader,
  sessionCookieToken,
  snapshotAuthState,
  SOURCE,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import { validateSession } from './index.ts';

const REGISTER_EMAIL = 'user@example.com';
const LOGIN_EMAIL = '  User@Example.com  ';
const PASSWORD = ' PassW0rd ';
const UNKNOWN_TOKEN = 'b'.repeat(64);

async function registerAndLogin(
  app: FastifyInstance,
): Promise<{ user: PublicIdentity; registerToken: string; loginToken: string }> {
  const registered = await injectRegister(app, {
    email: REGISTER_EMAIL,
    password: PASSWORD,
  });
  expect(registered.statusCode).toBe(201);
  // JSON.parse is typed as any; the HTTP body is JSON text.
  readPublicIdentity(JSON.parse(registered.body) as unknown);

  const login = await injectLogin(app, { email: LOGIN_EMAIL, password: PASSWORD });
  expect(login.statusCode).toBe(200);
  // JSON.parse is typed as any; the HTTP body is JSON text.
  const loginBody = readPublicIdentity(JSON.parse(login.body) as unknown);
  return {
    user: loginBody,
    registerToken: sessionCookieToken(cookieHeaders(registered)),
    loginToken: sessionCookieToken(cookieHeaders(login)),
  };
}

describe('POST /_platform/api/logout', () => {
  it.each([
    { cookieSecure: false, extraAttributes: [] as const },
    { cookieSecure: true, extraAttributes: ['Secure'] as const },
  ])(
    'revokes only the presented login session and clears the cookie when cookieSecure is $cookieSecure',
    async ({ cookieSecure, extraAttributes }) => {
      await withApp(async (app, database, lines) => {
        const { user, registerToken, loginToken } = await registerAndLogin(app);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });

        const logout = await app.inject({
          method: 'POST',
          url: '/_platform/api/logout',
          remoteAddress: SOURCE,
          headers: { cookie: `theme=dark; platform_session=${loginToken}` },
        });

        expect(logout.statusCode).toBe(204);
        expect(logout.body).toBe('');
        const cookies = cookieHeaders(logout);
        expect(cookies).toHaveLength(1);
        const header = sessionCookieHeader(cookies);
        expect(cookieAttributes(header)).toEqual(
          ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Lax', ...extraAttributes].sort(),
        );
        expect(header).not.toContain('Domain=');
        expect(validateSession(database, loginToken, Date.now())).toBeNull();
        expect(validateSession(database, registerToken, Date.now())).toBe(user.id);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 3 });
        const events = queryAuditEvents(database, {
          page: 1,
          pageSize: 10,
          eventType: 'logout.succeeded',
        });
        expect(events).toHaveLength(1);
        const event = events[0];
        if (event === undefined) {
          throw new Error('expected logout.succeeded audit row');
        }
        expect(event).toMatchObject({
          type: 'logout.succeeded',
          actorEmail: REGISTER_EMAIL,
          targetEmail: REGISTER_EMAIL,
          target: user.id,
          sourceAddress: SOURCE,
          details: {},
        });
        const written = `${logout.body}${lines.join('')}${JSON.stringify(event)}`;
        for (const secret of [PASSWORD, registerToken, loginToken]) {
          expect(written).not.toContain(secret);
        }
      }, cookieSecure);
    },
  );

  it.each([
    ['missing', undefined],
    ['unknown', `platform_session=${UNKNOWN_TOKEN}`],
  ] as const)(
    'returns 401 for a %s cookie without audit, cookie, or session side effects',
    async (_label, cookie) => {
      await withApp(async (app, database) => {
        await registerAndLogin(app);
        const before = snapshotAuthState(database);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });

        const logout = await app.inject({
          method: 'POST',
          url: '/_platform/api/logout',
          remoteAddress: SOURCE,
          ...(cookie === undefined ? {} : { headers: { cookie } }),
        });

        expect(logout.statusCode).toBe(401);
        expect(cookieHeaders(logout)).toEqual([]);
        expect(snapshotAuthState(database)).toEqual(before);
        expect(tableCounts(database)).toEqual({ users: 1, sessions: 2, audits: 2 });
        expect(
          queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'logout.succeeded' }),
        ).toEqual([]);
      });
    },
  );
});

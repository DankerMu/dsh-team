import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getSessionUser, readSessionCookie } from '../src/auth/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import {
  injectRegister,
  jsonRequestHeaders,
  type PublicIdentity,
  readPublicIdentity,
  sessionCookieHeader,
  sessionCookieToken,
  withApp,
} from './auth-fixture.ts';

export const PASSWORD = ' PassW0rd ';
const IDENTITY_PATH = '/_test/current-identity';
const LOOPBACK = '127.0.0.1';
export const LOOPBACK_ADDRESSES = [LOOPBACK, '::1', '::ffff:127.0.0.1'] as const;

const SELECT_LOGIN_SESSION =
  'SELECT created_at, last_activity_at FROM platform_sessions WHERE token_hash = ?';
const UNAUTHENTICATED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Unauthorized',
} as const;

export interface TestClock {
  ms: number;
}

export interface LoginSessionTimes {
  created_at: number;
  last_activity_at: number;
}

export interface SuccessfulLogin {
  identity: PublicIdentity;
  token: string;
  header: string;
}

function registerTestIdentityRoute(
  app: FastifyInstance,
  database: DatabaseHandle,
  now: TestClock,
): void {
  app.get(IDENTITY_PATH, (request, reply) => {
    const cookie = request.headers.cookie;
    const token = readSessionCookie(typeof cookie === 'string' ? cookie : undefined);
    if (token === null) {
      return reply.code(401).send(UNAUTHENTICATED);
    }
    const identity = getSessionUser(database, token, now.ms);
    if (identity === null) {
      return reply.code(401).send(UNAUTHENTICATED);
    }
    return reply.code(200).send(identity);
  });
}

export async function withListeningApp(
  run: (
    baseUrl: string,
    app: FastifyInstance,
    database: DatabaseHandle,
    lines: string[],
    now: TestClock,
  ) => Promise<void>,
  cookieSecure = false,
  trustedProxies: readonly string[] = [],
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const now = { ms: Date.now() };
      registerTestIdentityRoute(app, database, now);
      const baseUrl = await app.listen({ host: LOOPBACK, port: 0 });
      await run(baseUrl, app, database, lines, now);
    },
    cookieSecure,
    trustedProxies,
  );
}

export async function postJson(
  url: string,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string | undefined>> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: jsonRequestHeaders(extraHeaders),
    body: JSON.stringify(payload),
  });
}

export async function getIdentity(baseUrl: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}${IDENTITY_PATH}`, { headers: { cookie } });
}

export async function registerAccount(
  app: FastifyInstance,
  email: string,
): Promise<PublicIdentity> {
  const response = await injectRegister(app, { email, password: PASSWORD });
  expect(response.statusCode).toBe(201);
  return readPublicIdentity(JSON.parse(response.body) as unknown);
}

export async function successfulLogin(baseUrl: string, email: string): Promise<SuccessfulLogin> {
  const response = await postJson(`${baseUrl}/_platform/api/login`, { email, password: PASSWORD });
  expect(response.status).toBe(200);
  const identity = readPublicIdentity(await response.json());
  const cookies = response.headers.getSetCookie();
  return {
    identity,
    token: sessionCookieToken(cookies),
    header: sessionCookieHeader(cookies),
  };
}

export function sessionTimes(database: DatabaseHandle, token: string): LoginSessionTimes {
  const row = database
    .prepare<[string], LoginSessionTimes>(SELECT_LOGIN_SESSION)
    .get(createHash('sha256').update(token).digest('hex'));
  if (row === undefined) {
    throw new Error('expected login session row');
  }
  return row;
}

export function expectNoSecrets(
  lines: readonly string[],
  extra: unknown,
  secrets: readonly string[],
): void {
  const written = `${lines.join('')}${JSON.stringify(extra)}`;
  for (const secret of secrets) {
    expect(written).not.toContain(secret);
  }
}

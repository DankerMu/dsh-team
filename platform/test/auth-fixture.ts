import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';

export const SOURCE = '192.0.2.20';

const CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'info',
  dataDir: './data',
  publicUrl: 'http://127.0.0.1:8080',
  authority: '127.0.0.1:8080',
  cookieSecure: false,
  trustedProxies: [],
} as const;

const TOKEN_VALUE = /^platform_session=([0-9a-f]{64})/;
const SNAPSHOT_SESSIONS = 'SELECT * FROM platform_sessions ORDER BY token_hash';
const SNAPSHOT_AUDIT = 'SELECT * FROM audit_events ORDER BY id';

const COUNT_USERS = 'SELECT COUNT(*) AS n FROM users';
const COUNT_SESSIONS = 'SELECT COUNT(*) AS n FROM platform_sessions';
const COUNT_AUDIT = 'SELECT COUNT(*) AS n FROM audit_events';

interface CountRow {
  n: number;
}

export function cookieHeaders(response: LightMyRequestResponse): string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) {
    return [];
  }
  if (typeof raw === 'string') {
    return [raw];
  }
  return raw;
}

export function tableCounts(database: DatabaseHandle): {
  users: number;
  sessions: number;
  audits: number;
} {
  const users = database.prepare<[], CountRow>(COUNT_USERS).get();
  const sessions = database.prepare<[], CountRow>(COUNT_SESSIONS).get();
  const audits = database.prepare<[], CountRow>(COUNT_AUDIT).get();
  if (users === undefined || sessions === undefined || audits === undefined) {
    throw new Error('expected table counts');
  }
  return { users: users.n, sessions: sessions.n, audits: audits.n };
}

export interface PublicIdentity {
  id: string;
  email: string;
  role: string;
}

export function sessionCookieHeader(setCookie: readonly string[]): string {
  const header = setCookie.find((value) => value.startsWith('platform_session='));
  if (header === undefined) {
    throw new Error('expected platform_session cookie');
  }
  return header;
}

export function sessionCookieToken(setCookie: readonly string[]): string {
  const token = TOKEN_VALUE.exec(sessionCookieHeader(setCookie))?.[1];
  if (token === undefined) {
    throw new Error('expected platform_session cookie token');
  }
  return token;
}

export function cookieAttributes(header: string): string[] {
  return header
    .split(';')
    .slice(1)
    .map((part) => part.trim())
    .sort();
}

export function readPublicIdentity(value: unknown): PublicIdentity {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected public identity');
  }
  if (!('id' in value) || !('email' in value) || !('role' in value)) {
    throw new Error('expected public identity');
  }
  if (
    Object.keys(value).length !== 3 ||
    typeof value.id !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.role !== 'string'
  ) {
    throw new Error('expected public identity');
  }
  return { id: value.id, email: value.email, role: value.role };
}

export function snapshotAuthState(database: DatabaseHandle): {
  sessions: unknown[];
  audits: unknown[];
} {
  return {
    sessions: database.prepare(SNAPSHOT_SESSIONS).all(),
    audits: database.prepare(SNAPSHOT_AUDIT).all(),
  };
}

export async function withApp(
  run: (app: FastifyInstance, database: DatabaseHandle, lines: string[]) => Promise<void>,
  cookieSecure = false,
  trustedProxies: readonly string[] = [],
): Promise<void> {
  const lines: string[] = [];
  const database = openDatabase(':memory:');
  let app: FastifyInstance | undefined;
  try {
    applyMigrations(database);
    app = await buildApp({ ...CONFIG, cookieSecure, trustedProxies }, database, {
      write: (line) => lines.push(line),
    });
    await run(app, database, lines);
  } finally {
    if (app === undefined) {
      database.close();
    } else {
      await app.close();
    }
  }
}

function injectJson(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: SOURCE,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(payload),
  });
}

export function injectRegister(
  app: FastifyInstance,
  payload: unknown,
): Promise<LightMyRequestResponse> {
  return injectJson(app, '/_platform/api/register', payload);
}

export function injectLogin(
  app: FastifyInstance,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  return injectJson(app, '/_platform/api/login', payload, extraHeaders);
}

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

export async function withApp(
  run: (app: FastifyInstance, database: DatabaseHandle, lines: string[]) => Promise<void>,
  cookieSecure = false,
): Promise<void> {
  const lines: string[] = [];
  const database = openDatabase(':memory:');
  let app: FastifyInstance | undefined;
  try {
    applyMigrations(database);
    app = await buildApp({ ...CONFIG, cookieSecure }, database, {
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

export function injectRegister(
  app: FastifyInstance,
  payload: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/_platform/api/register',
    remoteAddress: SOURCE,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

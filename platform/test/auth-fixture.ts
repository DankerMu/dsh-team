import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { PlatformConfig } from '../src/config.ts';
import type { DatabaseHandle, Settings } from '../src/db/index.ts';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { GatewayUpstreamResolver } from '../src/gateway/index.ts';

export const SOURCE = '192.0.2.20';
export const PUBLIC_ORIGIN = 'http://127.0.0.1:8080';

const CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'info',
  dataDir: './data',
  managedConfigDir: './data/managed-config',
  dockerSocketPath: '/var/run/docker.sock',
  userImage: 'dsh-team-user:local',
  seccompProfilePath: '/unused/seccomp.json',
  subnetPool: '172.30.0.0/16',
  upstreamMode: 'published-loopback',
  platformContainerName: 'dsh-team-platform',
  publicUrl: PUBLIC_ORIGIN,
  authority: '127.0.0.1:8080',
  cookieSecure: false,
  trustedProxies: [],
  documentServer: null,
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

/**
 * One request of a case, cut to the case's deadline on the monotonic clock (`performance.now()`:
 * some cases fake `Date`). A stall or a failure is rethrown naming the step, never as the runner's
 * bare timeout.
 */
export async function boundedStep<T>(
  step: string,
  deadline: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error(`${step}: case deadline passed before it started`);
  try {
    return await request(AbortSignal.timeout(remaining));
  } catch (error) {
    throw new Error(`${step}: ${String(error)}`, { cause: error });
  }
}

/**
 * A wait that takes no signal, rejected with the signal's reason once it aborts, so `boundedStep`
 * can cut it. The wait itself keeps running; its later settlement is observed here.
 */
export function untilAborted<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const aborted = () => {
    reject(signal.reason as Error);
  };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  void wait.then(resolve, reject).finally(() => {
    signal.removeEventListener('abort', aborted);
  });
  return promise;
}

// Default bound of withApp's teardown close: the larger lane's maximum, twice, rounded up to 50ms,
// so a healthy close never turns a case red. Measured (#736) on Darwin 25.6.0 arm64:
// - pnpm test:integration, 3 runs at 1-minute load 15-35: 1194 closes, at most 66ms;
// - pnpm test (unit files under platform/src, with coverage), 2 runs at 1-minute load 17-31:
//   1278 closes, at most 486ms (platform/src/admin/empty-body.test.ts; the next highest 43ms).
// Accepted cost: a default-budget case that already spent 4500 of its 5000ms on one sendHttp and
// then hangs its close may hit the runner timeout first; a case needing the attribution passes
// teardownDeadline.
export const TEARDOWN_CLOSE_MS = 1000;

/**
 * Closes `app` within `deadline` and reports a close that does not settle as the teardown's
 * failure. A failure of the body stays first: an `Error` gets the teardown's appended to its
 * message (unless frozen), any other value is rethrown unchanged. An abandoned close keeps its hook
 * and the app's SQLite handle (`app.ts` `onClose`) queued in this worker; the case then always
 * fails, never continues silently.
 */
async function closeWithin(
  app: FastifyInstance,
  deadline: number,
  failure: { error: unknown } | undefined,
): Promise<void> {
  try {
    await boundedStep('teardown: application close', deadline, (signal) =>
      untilAborted(app.close(), signal),
    );
  } catch (error) {
    if (failure === undefined) throw error;
    if (!(failure.error instanceof Error)) return;
    // `boundedStep` rethrows every failure as an `Error` naming its step.
    const value = `${failure.error.message}; ${(error as Error).message}`;
    try {
      // An own property, since a `DOMException`'s `message` is a getter that rejects assignment.
      Object.defineProperty(failure.error, 'message', {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A frozen error takes no property; it is rethrown unchanged, its failure still first.
    }
  }
}

export async function withApp(
  run: (app: FastifyInstance, database: DatabaseHandle, lines: string[]) => Promise<void>,
  cookieSecure = false,
  trustedProxies: readonly string[] = [],
  resolveUpstream?: GatewayUpstreamResolver,
  options: {
    subnetPool?: string;
    initialSettings?: Partial<Settings>;
    publicUrl?: string;
    upstreamMode?: PlatformConfig['upstreamMode'];
    documentServer?: PlatformConfig['documentServer'];
    /** `performance.now()` deadline of the teardown close; never the case's step deadline. */
    teardownDeadline?: number;
  } = {},
): Promise<void> {
  const lines: string[] = [];
  const database = openDatabase(':memory:');
  let app: FastifyInstance | undefined;
  let failure: { error: unknown } | undefined;
  try {
    applyMigrations(database);
    if (options.initialSettings !== undefined) writeSettings(database, options.initialSettings);
    app = await buildApp(
      {
        ...CONFIG,
        cookieSecure,
        trustedProxies,
        subnetPool: options.subnetPool ?? CONFIG.subnetPool,
        upstreamMode: options.upstreamMode ?? CONFIG.upstreamMode,
        documentServer: options.documentServer ?? CONFIG.documentServer,
        ...(options.publicUrl === undefined
          ? {}
          : { publicUrl: options.publicUrl, authority: new URL(options.publicUrl).host }),
      },
      database,
      {
        write: (line) => lines.push(line),
      },
      resolveUpstream,
    );
    await run(app, database, lines);
  } catch (error) {
    failure = { error };
  }
  if (app === undefined) {
    database.close();
  } else {
    const deadline = options.teardownDeadline ?? performance.now() + TEARDOWN_CLOSE_MS;
    await closeWithin(app, deadline, failure);
  }
  if (failure !== undefined) throw failure.error;
}

/** Undefined overrides deliberately omit a header; names are case-insensitive. */
export function jsonRequestHeaders(
  extraHeaders: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    origin: PUBLIC_ORIGIN,
    'content-type': 'application/json',
  };
  for (const [name, value] of Object.entries(extraHeaders)) {
    merged[name.toLowerCase()] = value;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function injectJson(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string | undefined>> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders(extraHeaders),
    payload: JSON.stringify(payload),
  });
}

export function injectRegister(
  app: FastifyInstance,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string | undefined>> = {},
): Promise<LightMyRequestResponse> {
  return injectJson(app, '/_platform/api/register', payload, extraHeaders);
}

export function injectLogin(
  app: FastifyInstance,
  payload: unknown,
  extraHeaders: Readonly<Record<string, string | undefined>> = {},
): Promise<LightMyRequestResponse> {
  return injectJson(app, '/_platform/api/login', payload, extraHeaders);
}

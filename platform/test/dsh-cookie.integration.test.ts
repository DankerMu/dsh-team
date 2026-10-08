import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { acquireDshCookie, createDockerClient } from '../src/orchestrator/index.ts';
import { START_CONTAINER, START_IMAGE, START_USER } from './container-start-fixture.ts';

let root: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let engine: Server;
let web: Server;
let port: number;
let token: string;
let cookie: string;
let hostObserved: string | undefined;
let tokenObserved = false;
let logs: string;
let frames: Buffer[];
let inspection: Record<string, unknown>;
let engineRequests: string[];
let httpRequests: number;
let logClosed: Promise<void> | undefined;
let httpClosed: Promise<void> | undefined;
let logStarted: { promise: Promise<undefined>; resolve: (value: undefined) => void };
let holdLogs: boolean;
let beforeInspect: (() => void) | undefined;
let httpReply: (request: IncomingMessage, response: ServerResponse) => void;
const authority = 'team.example:8443';
// Independent openssl SHA256/base64url of this literal authority, per released protocol.
const cookieName = 'dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64';

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
function readCookie(): unknown {
  const row: unknown = database
    .prepare('SELECT dsh_cookie FROM instances WHERE user_id = ?')
    .get(START_USER);
  return typeof row === 'object' && row !== null && 'dsh_cookie' in row
    ? row.dsh_cookie
    : undefined;
}
function input(signal?: AbortSignal) {
  return {
    client: createDockerClient(join(root, 'engine.sock')),
    database,
    userId: START_USER,
    authority,
    ...(signal === undefined ? {} : { signal }),
  };
}
async function attempt(
  signal?: AbortSignal,
): Promise<{ failed: boolean; serialized: string; result?: unknown }> {
  try {
    return await acquireDshCookie(input(signal)).then((result: unknown) => {
      app.log.info({ result }, 'Acquisition returned');
      return { failed: false, serialized: JSON.stringify({ result }), result };
    });
  } catch (error) {
    app.log.error({ err: error }, 'Acquisition rejected');
    const serialized =
      error instanceof Error ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : '';
    return { failed: true, serialized };
  }
}
function assertSafe(serialized: string) {
  const audit = JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
  for (const secret of [token, cookie, cookie.slice(cookie.indexOf('=') + 1)]) {
    expect((logs + serialized + audit).includes(secret)).toBe(false);
  }
  expect(audit).toBe('[]');
}
function reply(response: ServerResponse) {
  response
    .writeHead(303, {
      'set-cookie': ['unrelated=value; Path=/', `${cookie}; Path=/; HttpOnly; SameSite=Strict`],
      location: './',
    })
    .end();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cookie-'));
  database = openDatabase(join(root, 'platform.db'));
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'cookie@example.test', 'unused', 'employee', 'active', 1)",
    )
    .run(START_USER);
  token = randomBytes(32).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt: 1, expiresAt: 8_000_000_000_000 }),
  ).toString('base64url');
  cookie = `${cookieName}=v1.${body}.${randomBytes(32).toString('base64url')}`;
  hostObserved = undefined;
  tokenObserved = false;
  logs = '';
  httpRequests = 0;
  engineRequests = [];
  holdLogs = false;
  logClosed = undefined;
  httpClosed = undefined;
  logStarted = Promise.withResolvers<undefined>();
  beforeInspect = undefined;
  frames = [
    frame(1, 'ordinary boot output\ndsh web: http://127.0.0.1:3080/?to'),
    frame(2, `dsh web: http://127.0.0.1:3080/?token=${randomBytes(32).toString('base64url')}\n`),
    frame(1, `ken=${token.slice(0, 17)}`),
    frame(1, `${token.slice(17)}\n`),
  ];
  httpReply = (_request, response) => {
    reply(response);
  };
  web = createServer((request, response) => {
    httpClosed = once(response, 'close').then(() => undefined);
    httpRequests += 1;
    hostObserved = request.headers.host;
    tokenObserved = request.url === `/?token=${token}`;
    httpReply(request, response);
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const address = web.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
  port = address.port;
  database
    .prepare(
      `INSERT INTO instances (user_id, status, container_id, upstream_host, upstream_port, image_tag, last_started_at, dsh_cookie)
    VALUES (?, 'starting', ?, '127.0.0.1', ?, 'dsh-team-user:local', 1, 'previous-credential')`,
    )
    .run(START_USER, START_CONTAINER, port);
  inspection = {
    Id: START_CONTAINER,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
  };
  engine = createServer((request, response) => {
    engineRequests.push(request.url ?? '');
    if (request.url?.startsWith('/images/')) response.end(JSON.stringify({ Id: START_IMAGE }));
    else if (request.url?.endsWith('/json')) {
      beforeInspect?.();
      response.end(JSON.stringify(inspection));
    } else {
      logClosed = once(response, 'close').then(() => undefined);
      logStarted.resolve(undefined);
      for (const bytes of frames) response.write(bytes);
      if (!holdLogs) response.end();
    }
  });
  engine.listen(join(root, 'engine.sock'));
  await once(engine, 'listening');
  app = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'info',
      dataDir: root,
      managedConfigDir: join(root, 'managed'),
      dockerSocketPath: join(root, 'engine.sock'),
      userImage: 'dsh-team-user:local',
      seccompProfilePath: join(root, 'seccomp.json'),
      publicUrl: `http://${authority}`,
      authority,
      cookieSecure: false,
      trustedProxies: [],
    },
    database,
    {
      write: (line) => {
        logs += line;
      },
    },
  );
});

afterEach(async () => {
  for (const server of [engine, web]) {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await app.close();
  database.close();
  await rm(root, { recursive: true, force: true });
});

it('acquires the split stdout launch credential with explicit Host and persists only the cookie while still starting', async () => {
  holdLogs = true;

  const result = await attempt();

  expect(result.failed).toBe(false);
  expect(result.result === undefined).toBe(true);
  expect(hostObserved).toBe(authority);
  expect(tokenObserved).toBe(true);
  await logClosed;
  database.close();
  database = openDatabase(join(root, 'platform.db'));
  expect(readCookie() === cookie).toBe(true);
  expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
  assertSafe(result.serialized);
});

it.each(['stderr', 'arbitrary', 'partial', 'truncated-frame', 'large-line', 'wrong-authority'])(
  'rejects %s logs without exchanging or retaining an old cookie',
  async (kind) => {
    frames =
      kind === 'stderr'
        ? [frame(2, `dsh web: http://127.0.0.1:3080/?token=${token}\n`)]
        : kind === 'arbitrary'
          ? [frame(1, `boot token=${token}\n`)]
          : kind === 'partial'
            ? [frame(1, `dsh web: http://127.0.0.1:3080/?token=${token}`)]
            : kind === 'truncated-frame'
              ? [frame(1, 'ordinary\n').subarray(0, 10)]
              : kind === 'large-line'
                ? [frame(1, 'x'.repeat(16 * 1024 + 1))]
                : [frame(1, `dsh web: http://remote.invalid:3080/?token=${token}\n`)];

    const result = await attempt();

    expect(result.failed).toBe(true);
    expect(httpRequests).toBe(0);
    expect(readCookie()).toBeNull();
    assertSafe(result.serialized);
  },
);

it.each(['owner', 'name', 'id', 'image', 'stopped', 'remote-endpoint', 'port'])(
  'refuses %s inspection before consuming Docker credentials',
  async (kind) => {
    if (kind === 'owner') inspection.Config = { Labels: { 'dsh-team.user': 'otheraccount' } };
    if (kind === 'name') inspection.Name = '/foreign';
    if (kind === 'id') inspection.Id = 'd'.repeat(64);
    if (kind === 'image') inspection.Image = `sha256:${'d'.repeat(64)}`;
    if (kind === 'stopped') inspection.State = { Running: false };
    if (kind === 'remote-endpoint' || kind === 'port')
      inspection.NetworkSettings = {
        Ports: {
          '3080/tcp': [
            {
              HostIp: kind === 'remote-endpoint' ? '0.0.0.0' : '127.0.0.1',
              HostPort: String(port + 1),
            },
          ],
        },
      };

    const result = await attempt();

    expect(result.failed).toBe(true);
    expect(engineRequests.some((path) => path.includes('/logs?'))).toBe(false);
    expect(httpRequests).toBe(0);
    expect(readCookie()).toBeNull();
    assertSafe(result.serialized);
  },
);

it.each(['disabled', 'missing', 'running', 'bad-host'])(
  'rejects %s indexed current account or instance before Docker IO',
  async (kind) => {
    if (kind === 'disabled') database.prepare("UPDATE users SET status = 'disabled'").run();
    if (kind === 'missing') database.prepare('DELETE FROM instances').run();
    if (kind === 'running') database.prepare("UPDATE instances SET status = 'running'").run();
    if (kind === 'bad-host')
      database.prepare("UPDATE instances SET upstream_host = 'remote.invalid'").run();

    const result = await attempt();

    expect(result.failed).toBe(true);
    expect(engineRequests).toEqual([]);
    assertSafe(result.serialized);
  },
);

it.each([
  'status',
  'missing',
  'unrelated',
  'duplicate',
  'malformed',
  'wrong-audience',
  'expired',
  'huge-header',
  'reset',
])('rejects %s HTTP exchange with cleared credentials and secret-safe errors', async (kind) => {
  httpReply = (request, response) => {
    if (kind === 'reset') {
      request.socket.destroy(new Error(token));
      return;
    }
    let selected = cookie;
    if (kind === 'malformed') selected = `${cookieName}=v1.invalid.invalid`;
    if (kind === 'wrong-audience' || kind === 'expired') {
      const body = Buffer.from(
        JSON.stringify({
          version: 1,
          authority: kind === 'wrong-audience' ? 'foreign.test' : authority,
          issuedAt: 1,
          expiresAt: kind === 'expired' ? 2 : 8_000_000_000_000,
        }),
      ).toString('base64url');
      selected = `${cookieName}=v1.${body}.${randomBytes(32).toString('base64url')}`;
    }
    const headers =
      kind === 'missing'
        ? []
        : kind === 'unrelated'
          ? ['unrelated=value']
          : kind === 'duplicate'
            ? [selected, selected]
            : [selected];
    response
      .writeHead(kind === 'status' ? 200 : 303, {
        'set-cookie': headers,
        ...(kind === 'huge-header' ? { 'x-overflow': 'x'.repeat(9000) + token } : {}),
        location: `/?token=${token}`,
      })
      .end(cookie);
  };

  const result = await attempt();

  expect(result.failed).toBe(true);
  expect(httpRequests).toBe(1);
  expect(readCookie()).toBeNull();
  assertSafe(result.serialized);
});

it.each([
  'container',
  'host',
  'port',
  'image',
  'state',
  'restart',
  'account',
  'replacement-cookie',
])('rejects stale %s completion without overwriting the newer record', async (kind) => {
  httpReply = (_request, response) => {
    const mutation: Record<string, string> = {
      container: `container_id = '${'d'.repeat(64)}'`,
      host: "upstream_host = 'remote.invalid'",
      port: 'upstream_port = 12345',
      image: "image_tag = 'replacement-image'",
      state: "status = 'stopped'",
      restart: 'last_started_at = 2',
      'replacement-cookie': "dsh_cookie = 'replacement-credential'",
    };
    if (kind === 'account') database.prepare("UPDATE users SET status = 'disabled'").run();
    else database.prepare(`UPDATE instances SET ${mutation[kind] ?? ''}`).run();
    if (kind !== 'account' && kind !== 'replacement-cookie')
      database.prepare("UPDATE instances SET dsh_cookie = 'replacement-credential'").run();
    reply(response);
  };

  const result = await attempt();

  expect(result.failed).toBe(true);
  expect(readCookie() === (kind === 'account' ? null : 'replacement-credential')).toBe(true);
  assertSafe(result.serialized);
});

it('does not clear a replacement selected while container inspection is pending', async () => {
  beforeInspect = () =>
    database
      .prepare("UPDATE instances SET container_id = ?, dsh_cookie = 'replacement-credential'")
      .run('d'.repeat(64));

  const result = await attempt();

  expect(result.failed).toBe(true);
  expect(readCookie()).toBe('replacement-credential');
  assertSafe(result.serialized);
});

it.each(['logs', 'HTTP', 'pre-aborted'])(
  'cancels %s acquisition, closes IO and leaves the current cookie cleared',
  async (phase) => {
    const controller = new AbortController();
    const waiting = Promise.withResolvers<undefined>();
    if (phase === 'logs') {
      frames = [frame(1, 'ordinary boot output\n')];
      holdLogs = true;
    }
    if (phase === 'HTTP')
      httpReply = () => {
        waiting.resolve(undefined);
      };
    if (phase === 'pre-aborted') controller.abort(new Error(token + cookie));

    const operation = attempt(controller.signal);
    if (phase === 'HTTP') await waiting.promise;
    if (phase === 'logs') await logStarted.promise;
    controller.abort(new Error(token + cookie));
    const result = await operation;

    expect(result.failed).toBe(true);
    expect(readCookie()).toBeNull();
    if (phase === 'logs') await logClosed;
    if (phase === 'HTTP') await httpClosed;
    assertSafe(result.serialized);
  },
);

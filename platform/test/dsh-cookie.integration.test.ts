import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildCookieFixtureApp, frame, reply } from './dsh-cookie-fixture.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import {
  acquireDshCookie,
  createDockerClient,
  waitForUserContainerReady,
} from '../src/orchestrator/index.ts';
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
let imageReply: { status: number; document?: unknown };
let httpRequests: number;
let logClosed: Promise<void> | undefined;
let httpClosed: Promise<void> | undefined;
let logStarted: { promise: Promise<undefined>; resolve: (value: undefined) => void };
let holdLogs: boolean;
let beforeInspect: (() => void) | undefined;
let httpReply: (request: IncomingMessage, response: ServerResponse) => void;
let tailFrames: Buffer[] | undefined;
let stopStatus: number;
let tailStatus: number;
let holdTail: boolean;
let holdStop: boolean;
let tailStarted: { promise: Promise<undefined>; resolve: (value: undefined) => void };
let stopStarted: { promise: Promise<undefined>; resolve: (value: undefined) => void };
const authority = 'team.example:8443';
// Independent openssl SHA256/base64url of this literal authority, per released protocol.
const cookieName = 'dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64';

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
  operation = acquireDshCookie,
): Promise<{ failed: boolean; serialized: string; result?: unknown }> {
  try {
    return await operation(input(signal)).then((result: unknown) => {
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
function assertSafe(serialized: string, emptyAudit = true) {
  const audit = JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
  const errors = JSON.stringify(database.prepare('SELECT last_error FROM instances').all());
  for (const secret of [token, cookie, cookie.slice(cookie.indexOf('=') + 1)]) {
    expect((logs + serialized + audit + errors).includes(secret)).toBe(false);
  }
  if (emptyAudit) expect(audit).toBe('[]');
}

function replyWithDockerLogs(response: ServerResponse, tail: boolean): void {
  logClosed = once(response, 'close').then(() => undefined);
  logStarted.resolve(undefined);
  if (tail) tailStarted.resolve(undefined);
  response.writeHead(tail ? tailStatus : 200);
  for (const bytes of tail ? (tailFrames ?? frames) : frames) response.write(bytes);
  if ((tail && !holdTail) || (!tail && !holdLogs)) response.end();
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
  imageReply = { status: 200, document: { Id: START_IMAGE } };
  engineRequests = [];
  holdLogs = false;
  logClosed = undefined;
  httpClosed = undefined;
  logStarted = Promise.withResolvers<undefined>();
  beforeInspect = undefined;
  tailFrames = undefined;
  stopStatus = 204;
  tailStatus = 200;
  holdTail = false;
  holdStop = false;
  tailStarted = Promise.withResolvers<undefined>();
  stopStarted = Promise.withResolvers<undefined>();
  frames = [
    frame(1, 'ordinary boot output\ndsh web: http://127.0.0.1:3080/?to'),
    frame(2, `dsh web: http://127.0.0.1:3080/?token=${randomBytes(32).toString('base64url')}\n`),
    frame(1, `ken=${token.slice(0, 17)}`),
    frame(1, `${token.slice(17)}\n`),
  ];
  httpReply = (_request, response) => {
    reply(response, cookie);
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
      `INSERT INTO instances (user_id, status, container_id, upstream_host, upstream_port, image_tag, image_id, last_started_at, dsh_cookie)
    VALUES (?, 'starting', ?, '127.0.0.1', ?, 'dsh-team-user:local', ?, 1, 'previous-credential')`,
    )
    .run(START_USER, START_CONTAINER, port, START_IMAGE);
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
    if (request.url?.startsWith('/images/')) {
      response.writeHead(imageReply.status).end(JSON.stringify(imageReply.document));
    } else if (request.url?.endsWith('/json')) {
      beforeInspect?.();
      response.end(JSON.stringify(inspection));
    } else if (request.url?.includes('/stop?')) {
      stopStarted.resolve(undefined);
      if (holdStop) return;
      if (stopStatus === 204) inspection.State = { Running: false };
      response.writeHead(stopStatus).end();
    } else {
      replyWithDockerLogs(response, request.url?.includes('follow=false') === true);
    }
  });
  engine.listen(join(root, 'engine.sock'));
  await once(engine, 'listening');
  app = await buildCookieFixtureApp(root, database, authority, (line) => {
    logs += line;
  });
});

afterEach(async () => {
  vi.useRealTimers();
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

it('commits running and instance.ready only after the current cookie authenticates the homepage', async () => {
  const observations: string[] = [];
  database.prepare("UPDATE instances SET last_error = 'previous startup failure'").run();
  httpReply = (request, response) => {
    if (request.url === `/?token=${token}`) {
      observations.push('launch credential exchanged');
      reply(response, cookie);
      return;
    }
    const authenticated =
      request.url === '/' &&
      request.headers.host === authority &&
      request.headers.cookie === cookie;
    observations.push(authenticated ? 'authenticated homepage' : 'unauthenticated homepage');
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({
      status: 'starting',
    });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([]);
    response.writeHead(authenticated ? 200 : 401).end();
  };

  await waitForUserContainerReady(input());

  expect(observations).toEqual(['launch credential exchanged', 'authenticated homepage']);
  expect(readCookie() === cookie).toBe(true);
  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'running',
    last_error: null,
  });
  expect(
    database
      .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
      .all(),
  ).toEqual([
    {
      event_type: 'instance.ready',
      target: START_USER,
      target_email: 'cookie@example.test',
      details: '{}',
    },
  ]);
  const serialized = logs + JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
  for (const secret of [token, cookie, cookie.slice(cookie.indexOf('=') + 1)]) {
    expect(serialized.includes(secret)).toBe(false);
  }
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
  'immutable-image',
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
      'immutable-image': `image_id = 'sha256:${'d'.repeat(64)}'`,
      state: "status = 'stopped'",
      restart: 'last_started_at = 2',
      'replacement-cookie': "dsh_cookie = 'replacement-credential'",
    };
    if (kind === 'account') database.prepare("UPDATE users SET status = 'disabled'").run();
    else database.prepare(`UPDATE instances SET ${mutation[kind] ?? ''}`).run();
    if (kind !== 'account' && kind !== 'replacement-cookie')
      database.prepare("UPDATE instances SET dsh_cookie = 'replacement-credential'").run();
    reply(response, cookie);
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

it.each(['retargeted', 'removed'])(
  'acquires for the original owned image when its configured tag is %s',
  async (change) => {
    imageReply =
      change === 'retargeted'
        ? { status: 200, document: { Id: `sha256:${'d'.repeat(64)}` } }
        : { status: 404 };

    const result = await attempt();

    expect(result.failed).toBe(false);
    expect(readCookie() === cookie).toBe(true);
    expect(engineRequests.some((path) => path.startsWith('/images/'))).toBe(false);
    assertSafe(result.serialized);
  },
);

it('rejects historical instances without immutable image identity before clearing an existing credential', async () => {
  database.prepare('UPDATE instances SET image_id = NULL').run();

  const result = await attempt();

  expect(result.failed).toBe(true);
  expect(readCookie()).toBe('previous-credential');
  expect(engineRequests).toEqual([]);
  expect(httpRequests).toBe(0);
  assertSafe(result.serialized);
});

function ready(signal?: AbortSignal) {
  return attempt(signal, waitForUserContainerReady);
}

function homepage(status = 200) {
  httpReply = (request, response) => {
    if (request.url === `/?token=${token}`) reply(response, cookie);
    else {
      expect(request.url).toBe('/');
      expect(request.headers.cookie === cookie).toBe(true);
      expect(request.headers.host).toBe(authority);
      response.writeHead(status).end();
    }
  };
}

it('polls transient homepage failures and never records readiness twice', async () => {
  let pages = 0;
  httpReply = (request, response) => {
    if (request.url === `/?token=${token}`) reply(response, cookie);
    else {
      expect(request.headers.cookie === cookie).toBe(true);
      pages += 1;
      response.writeHead(pages === 1 ? 503 : 200).end();
    }
  };

  const first = await ready();
  const repeated = await ready();

  expect(first.failed).toBe(false);
  expect(repeated.failed).toBe(true);
  expect(pages).toBe(2);
  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'running',
    last_error: null,
  });
  expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
    { event_type: 'instance.ready' },
  ]);
  assertSafe(first.serialized + repeated.serialized, false);
});

it('shares one exact 60-second deadline with a pending announcement and closes it before cleanup', async () => {
  frames = [frame(1, 'boot is waiting\n')];
  holdLogs = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let settled = false;
  const pending = ready().then((result) => {
    settled = true;
    return result;
  });
  await logStarted.promise;

  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;

  expect(result.failed).toBe(true);
  expect(result.serialized).toContain('deadline or cancellation');
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    dsh_cookie: null,
  });
  expect(engineRequests.filter((path) => path.includes('/stop?'))).toHaveLength(1);
  expect(engineRequests.some((path) => path.includes('follow=false&tail=1000'))).toBe(true);
  assertSafe(result.serialized, false);
});

it.each(['indexed', 'no-endpoint', 'during-announcement'])(
  'fails promptly for an owned early-dead instance: %s',
  async (phase) => {
    if (phase === 'during-announcement') {
      holdLogs = true;
      frames = [frame(1, 'waiting for startup\n')];
    } else inspection.State = { Running: false };
    if (phase === 'no-endpoint') {
      database
        .prepare(
          'UPDATE instances SET upstream_host = NULL, upstream_port = NULL, last_started_at = NULL',
        )
        .run();
      inspection.NetworkSettings = { Ports: {} };
    }
    const pending = ready();
    if (phase === 'during-announcement') {
      await logStarted.promise;
      inspection.State = { Running: false };
    }

    const result = await pending;

    expect(result.failed).toBe(true);
    expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
      status: 'error',
      dsh_cookie: null,
    });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
      { event_type: 'instance.start-failed' },
    ]);
    expect(engineRequests.some((path) => path.includes('/stop?'))).toBe(false);
    assertSafe(result.serialized, false);
  },
);

it.each(['announcement', 'homepage'])(
  'cancels a pending %s using independent cleanup without exposing abort reasons',
  async (phase) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<undefined>();
    if (phase === 'announcement') {
      holdLogs = true;
      frames = [frame(1, 'startup is waiting\n')];
    } else {
      httpReply = (request, response) => {
        if (request.url === `/?token=${token}`) reply(response, cookie);
        else started.resolve(undefined);
      };
    }
    const pending = ready(controller.signal);
    await (phase === 'announcement' ? logStarted.promise : started.promise);

    controller.abort(new Error(`${token} ${cookie}`));
    const result = await pending;

    expect(result.failed).toBe(true);
    expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
      status: 'error',
      dsh_cookie: null,
    });
    expect(inspection.State).toEqual({ Running: false });
    expect(engineRequests.filter((path) => path.includes('/stop?'))).toHaveLength(1);
    assertSafe(result.serialized, false);
  },
);

it('surfaces daemon stop failure and never claims the still-running instance stopped', async () => {
  frames = [frame(1, 'harmless startup failure\n')];
  stopStatus = 500;

  const result = await ready();

  expect(result.failed).toBe(true);
  expect(result.serialized).toContain('stop failed or unconfirmed');
  expect(inspection.State).toEqual({ Running: true });
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    dsh_cookie: null,
  });
  expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
    { event_type: 'instance.start-failed' },
  ]);
  assertSafe(result.serialized, false);
});

it.each(['ready-audit', 'ready-update', 'failure-audit', 'failure-update'])(
  'rolls back atomic state and audit changes on %s failure',
  async (kind) => {
    const failure = kind.startsWith('failure');
    if (failure) frames = [frame(1, 'ordinary failure\n')];
    else homepage();
    const table = kind.endsWith('audit') ? 'audit_events' : 'instances';
    const operation = kind.endsWith('audit') ? 'INSERT' : 'UPDATE';
    const predicate = kind.endsWith('audit')
      ? `NEW.event_type = 'instance.${failure ? 'start-failed' : 'ready'}'`
      : `NEW.status = '${failure ? 'error' : 'running'}'`;
    database.exec(`CREATE TRIGGER reject_change BEFORE ${operation} ON ${table}
      WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'external persistence failure'); END`);

    const result = await ready();

    expect(result.failed).toBe(true);
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({
      status: failure ? 'starting' : 'error',
    });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual(
      failure ? [] : [{ event_type: 'instance.start-failed' }],
    );
    expect(inspection.State).toEqual({ Running: false });
    assertSafe(result.serialized, false);
  },
);

it.each(['container', 'image', 'start', 'endpoint', 'account', 'cookie'])(
  'does not mark ready, stop, or overwrite a %s changed while HTTP200 is pending',
  async (field) => {
    httpReply = (request, response) => {
      if (request.url === `/?token=${token}`) reply(response, cookie);
      else {
        if (field === 'account') database.prepare("UPDATE users SET status = 'disabled'").run();
        else if (field === 'cookie')
          database.prepare('UPDATE instances SET dsh_cookie = ?').run('newer-credential');
        else if (field === 'container')
          database.prepare('UPDATE instances SET container_id = ?').run('d'.repeat(64));
        else if (field === 'image')
          database.prepare('UPDATE instances SET image_id = ?').run(`sha256:${'e'.repeat(64)}`);
        else if (field === 'start')
          database.prepare('UPDATE instances SET last_started_at = 2').run();
        else database.prepare('UPDATE instances SET upstream_port = 12345').run();
        response.writeHead(200).end();
      }
    };

    const result = await ready();

    expect(result.failed).toBe(true);
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
    expect(readCookie() === (field === 'cookie' ? 'newer-credential' : cookie)).toBe(true);
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([]);
    expect(engineRequests.some((path) => path.includes('/stop?'))).toBe(false);
    assertSafe(result.serialized);
  },
);

it('retains the final fifty harmless lines without leaking fragmented credentials or truncated suffixes', async () => {
  inspection.State = { Running: false };
  database.prepare('UPDATE instances SET dsh_cookie = ?').run(cookie);
  const utf8 = Buffer.from('中文 startup 邻行\r\n');
  tailFrames = [
    frame(1, Array.from({ length: 55 }, (_, index) => `boot ${String(index + 1)}\r\n`).join('')),
    frame(1, `dsh web: http://127.0.0.1:3080/?to`),
    frame(2, `Cookie: ${cookie}\n`),
    frame(1, `ken=${token.slice(0, 13)}`),
    frame(1, `${token.slice(13)}\r\n`),
    frame(1, `${'x'.repeat(2048)}${token}\n`),
    frame(1, utf8.subarray(0, 2)),
    frame(1, utf8.subarray(2, utf8.length - 1)),
    frame(1, utf8.subarray(utf8.length - 1)),
    frame(2, `dsh web: http://bad.invalid/?token=${token}`),
  ];

  const result = await ready();
  const row: unknown = database.prepare('SELECT last_error FROM instances').get();

  expect(result.failed).toBe(true);
  if (
    typeof row !== 'object' ||
    row === null ||
    !('last_error' in row) ||
    typeof row.last_error !== 'string'
  )
    throw new Error('Missing retained startup diagnostic');
  expect(row.last_error.split('\n').slice(1)).toEqual([
    ...Array.from({ length: 49 }, (_, index) => `boot ${String(index + 7)}`),
    '中文 startup 邻行',
  ]);
  assertSafe(result.serialized, false);
});

it('records an explicit safe diagnostic rather than invented logs when Docker logs are unreadable', async () => {
  inspection.State = { Running: false };
  tailStatus = 500;

  const result = await ready();

  expect(result.failed).toBe(true);
  expect(JSON.stringify(database.prepare('SELECT last_error FROM instances').get())).toContain(
    'Startup logs unavailable',
  );
  assertSafe(result.serialized, false);
});

it('rejects a credential replaced immediately by acquisition persistence instead of adopting it', async () => {
  database.exec(`CREATE TRIGGER replace_acquired_cookie AFTER UPDATE OF dsh_cookie ON instances
    WHEN NEW.dsh_cookie IS NOT NULL AND NEW.dsh_cookie != 'replacement-credential'
    BEGIN UPDATE instances SET dsh_cookie = 'replacement-credential' WHERE user_id = NEW.user_id; END`);
  let homepageRequests = 0;
  httpReply = (request, response) => {
    if (request.url === `/?token=${token}`) reply(response, cookie);
    else {
      homepageRequests += 1;
      response.writeHead(request.headers.cookie === 'replacement-credential' ? 200 : 401).end();
    }
  };

  const result = await ready();

  expect(result.failed).toBe(true);
  expect(homepageRequests).toBe(0);
  expect(readCookie() === 'replacement-credential').toBe(true);
  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'starting',
    last_error: null,
  });
  expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([]);
  expect(engineRequests.some((path) => path.includes('/stop?'))).toBe(false);
  assertSafe(result.serialized);
});

it('bounds an unreadable pending log tail independently and records the stopped instance failure', async () => {
  inspection.State = { Running: false };
  holdTail = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const pending = ready();
  await tailStarted.promise;

  await vi.advanceTimersByTimeAsync(3_000);
  const result = await pending;

  expect(result.failed).toBe(true);
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    dsh_cookie: null,
  });
  expect(JSON.stringify(database.prepare('SELECT last_error FROM instances').get())).toContain(
    'Startup logs unavailable: incomplete or unreadable Docker tail',
  );
  assertSafe(result.serialized, false);
});

it('bounds an unresponsive stop and retains an observable unconfirmed-stop failure', async () => {
  frames = [frame(1, 'ordinary failed startup\n')];
  holdStop = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const pending = ready();
  await stopStarted.promise;

  await vi.advanceTimersByTimeAsync(10_000);
  const result = await pending;

  expect(result.failed).toBe(true);
  expect(result.serialized).toContain('container stop failed or unconfirmed');
  expect(inspection.State).toEqual({ Running: true });
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    dsh_cookie: null,
  });
  assertSafe(result.serialized, false);
});

it('keeps persisted startup diagnostics secret-safe when control removal reconstructs credentials', async () => {
  inspection.State = { Running: false };
  database.prepare('UPDATE instances SET dsh_cookie = ?').run(cookie);
  const value = cookie.slice(cookie.indexOf('=') + 1);
  tailFrames = [
    frame(1, 'before failure\n'),
    frame(1, 'boot to'),
    frame(2, `neighbor ${value.slice(0, 12)}`),
    frame(1, '\u0000'),
    frame(2, '\u0000'),
    frame(1, `ken=${token}\n`),
    frame(2, `${value.slice(12)} remains\n`),
    frame(1, 'after failure\n'),
  ];

  const result = await ready();
  const row: unknown = database.prepare('SELECT last_error FROM instances').get();

  expect(result.failed).toBe(true);
  assertSafe(result.serialized, false);
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    dsh_cookie: null,
  });
  expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
    { event_type: 'instance.start-failed' },
  ]);
  if (
    typeof row !== 'object' ||
    row === null ||
    !('last_error' in row) ||
    typeof row.last_error !== 'string'
  )
    throw new Error('Missing normalized startup diagnostic');
  expect(row.last_error.split('\n').slice(1)).toEqual([
    'before failure',
    'neighbor [redacted] remains',
    'after failure',
  ]);
});

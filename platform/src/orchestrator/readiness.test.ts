import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type * as NodeHttp from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { createDockerClient, createOrchestrator } from './index.ts';
import type { Orchestrator } from './index.ts';
import {
  startupDaemon,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from '../../test/container-start-fixture.ts';

const http = vi.hoisted(() => ({
  cookie: '',
  status: 200,
  exchange: 303,
  refuse: 0,
  pages: 0,
  hold: '',
  started: undefined as (() => void) | undefined,
  beforePage: undefined as (() => void) | undefined,
  secret: '',
  missingCookie: false,
}));
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof NodeHttp>();
  return {
    ...original,
    request: (options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      const outgoing = new EventEmitter();
      const exchange = options.path?.startsWith('/?token=') === true;
      const signal = options.signal;
      const aborted = () => {
        outgoing.emit('error', new Error(http.secret));
      };
      signal?.addEventListener('abort', aborted, { once: true });
      return Object.assign(outgoing, {
        end() {
          queueMicrotask(() => {
            if (signal?.aborted) {
              aborted();
              return;
            }
            if (!exchange) {
              http.pages += 1;
              http.beforePage?.();
            }
            http.started?.();
            if (http.hold === (exchange ? 'exchange' : 'homepage')) return;
            if (!exchange && http.refuse > 0) {
              http.refuse -= 1;
              outgoing.emit('error', new Error(http.secret));
              return;
            }
            const response = Object.assign(new PassThrough(), {
              statusCode: exchange ? http.exchange : http.status,
              headers: {
                'set-cookie': http.missingCookie ? [] : [`${http.cookie}; Path=/; HttpOnly`],
              },
            });
            // This external HTTP fixture supplies the IncomingMessage fields consumed by production.
            receive(response as unknown as IncomingMessage);
          });
        },
        destroy() {
          signal?.removeEventListener('abort', aborted);
        },
      });
    },
  };
});

const authority = 'team.example:8443';
const cookieName = 'dsh-auth-3eo-BcKCoQv18vgqA6jsyDZEVweseAZ0c-hb0sOZg64';
let database: DatabaseHandle;
let daemon = startupDaemon();
let waitForUserContainerReady: Orchestrator['waitForUserContainerReady'];
let token: string;
let container: {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown>;
  State: { Running: boolean };
  NetworkSettings: { Ports: unknown };
};

beforeEach(() => {
  database = openDatabase(':memory:');
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'ready@example.test', 'unused', 'employee', 'active', 1)",
    )
    .run(START_USER);
  database
    .prepare(
      `INSERT INTO instances (user_id, status, container_id, upstream_host,
    upstream_port, image_tag, image_id, last_started_at, last_error)
    VALUES (?, 'starting', ?, '127.0.0.1', 49173, 'image:test', ?, 1, 'previous failure')`,
    )
    .run(START_USER, START_CONTAINER, START_IMAGE);
  token = randomBytes(32).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      authority,
      issuedAt: 1,
      expiresAt: 8_000_000_000_000,
    }),
  ).toString('base64url');
  http.cookie = `${cookieName}=v1.${body}.${randomBytes(32).toString('base64url')}`;
  http.secret = `${token} ${http.cookie}`;
  http.status = 200;
  http.exchange = 303;
  http.refuse = 0;
  http.pages = 0;
  http.hold = '';
  http.started = undefined;
  http.beforePage = undefined;
  http.missingCookie = false;
  daemon = startupDaemon();
  container = {
    Id: START_CONTAINER,
    Name: `/dsh-team-u-${START_USER}`,
    Image: START_IMAGE,
    Config: { Labels: { 'dsh-team.user': START_USER } },
    State: { Running: true },
    NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] } },
  };
  daemon.containers.set(START_CONTAINER, container);
  daemon.attachOwnedNetwork(START_USER, START_CONTAINER);
  daemon.setComposition(`harmless boot line\ndsh web: http://127.0.0.1:3080/?token=${token}\n`);
  daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, { status: 204 });
  daemon.beforeRequest((request) => {
    if (
      request.method === 'POST' &&
      request.path.includes('/stop?') &&
      daemon.overrides.get(`POST ${request.path}`)?.status === 204
    )
      container.State.Running = false;
  });
  ({ waitForUserContainerReady } = createOrchestrator({
    client: createDockerClient('/fixture/docker.sock', daemon.transport),
    database,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
});

function input(signal?: AbortSignal) {
  return {
    userId: START_USER,
    authority,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function failure(signal?: AbortSignal): Promise<string> {
  try {
    await waitForUserContainerReady(input(signal));
  } catch (error) {
    const serialized =
      error instanceof Error ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : '';
    const diagnostics =
      serialized +
      JSON.stringify(database.prepare('SELECT last_error FROM instances').all()) +
      JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
    for (const secret of [token, http.cookie, http.cookie.slice(http.cookie.indexOf('=') + 1)])
      expect(diagnostics.includes(secret)).toBe(false);
    return serialized;
  }
  throw new Error('Expected readiness failure');
}

it('atomically records readiness once, retains only the backend credential and clears prior failure', async () => {
  await waitForUserContainerReady(input());
  const repeated = await failure();

  expect(database.prepare('SELECT status, last_error FROM instances').get()).toEqual({
    status: 'running',
    last_error: null,
  });
  const row: unknown = database.prepare('SELECT dsh_cookie FROM instances').get();
  expect(
    typeof row === 'object' &&
      row !== null &&
      'dsh_cookie' in row &&
      row.dsh_cookie === http.cookie,
  ).toBe(true);
  expect(
    database.prepare('SELECT event_type, target, target_email, details FROM audit_events').all(),
  ).toEqual([
    {
      event_type: 'instance.ready',
      target: START_USER,
      target_email: 'ready@example.test',
      details: '{}',
    },
  ]);
  expect(repeated).toContain('before selecting an owned instance');
});

it.each(['account', 'identity', 'image', 'label', 'name', 'inspect-id', 'state'])(
  'rejects invalid %s without stopping or mutating an unselected instance',
  async (kind) => {
    if (kind === 'account') database.prepare("UPDATE users SET status = 'disabled'").run();
    if (kind === 'identity') database.prepare('UPDATE instances SET image_id = NULL').run();
    if (kind === 'image') container.Image = `sha256:${'d'.repeat(64)}`;
    if (kind === 'label') container.Config = { Labels: { 'dsh-team.user': 'foreign-user' } };
    if (kind === 'name') container.Name = '/foreign-container';
    if (kind === 'inspect-id') container.Id = 'd'.repeat(64);
    if (kind === 'state') container.State = {} as { Running: boolean }; // Malformed external Docker response.

    await failure();

    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([]);
    expect(daemon.requests.some((request) => request.path.includes('/stop?'))).toBe(false);
  },
);

it.each([false, true])(
  'records an early-dead owned instance with nullable endpoint: %s',
  async (incomplete) => {
    container.State.Running = false;
    if (incomplete)
      database
        .prepare(
          'UPDATE instances SET upstream_host = NULL, upstream_port = NULL, last_started_at = NULL',
        )
        .run();

    const error = await failure();

    expect(error).toContain('container already stopped');
    expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
      status: 'error',
      dsh_cookie: null,
    });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([
      { event_type: 'instance.start-failed' },
    ]);
  },
);

it('stops an owned live instance whose endpoint was not persisted instead of trusting a partial creation', async () => {
  database
    .prepare(
      'UPDATE instances SET upstream_host = NULL, upstream_port = NULL, last_started_at = NULL',
    )
    .run();

  await failure();

  expect(container.State.Running).toBe(false);
  expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
});

it.each(['announcement', 'cookie', 'exchange'])(
  'cleans up after invalid %s without retaining raw protocol errors',
  async (kind) => {
    if (kind === 'announcement') daemon.setComposition('ordinary failure\n');
    if (kind === 'cookie') http.missingCookie = true;
    if (kind === 'exchange') http.exchange = 500;

    await failure();

    expect(container.State.Running).toBe(false);
    expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
      status: 'error',
      dsh_cookie: null,
    });
  },
);

it.each(['connection', 'status'])(
  'polls transient authenticated homepage %s failures',
  async (kind) => {
    if (kind === 'connection') http.refuse = 1;
    else {
      http.status = 503;
      http.beforePage = () => {
        if (http.pages === 2) http.status = 200;
      };
    }

    await waitForUserContainerReady(input());

    expect(http.pages).toBe(2);
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'running' });
  },
);

it.each(['exchange', 'homepage'])(
  'cancels a pending %s and releases observers before finite cleanup',
  async (phase) => {
    const started = Promise.withResolvers<undefined>();
    http.hold = phase;
    http.started = () => {
      if ((phase === 'homepage') === http.pages > 0) started.resolve(undefined);
    };
    const controller = new AbortController();
    const pending = failure(controller.signal);
    await started.promise;

    controller.abort(new Error(http.secret));
    const error = await pending;

    expect(error).toContain('deadline or cancellation');
    expect(container.State.Running).toBe(false);
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
  },
);

it('uses one exact controlled 60-second deadline while authenticated homepage remains pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const started = Promise.withResolvers<undefined>();
  http.hold = 'homepage';
  http.started = () => {
    if (http.pages > 0) started.resolve(undefined);
  };
  let settled = false;
  const pending = failure().then((error) => {
    settled = true;
    return error;
  });
  await started.promise;

  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const error = await pending;

  expect(error).toContain('deadline or cancellation');
  expect(container.State.Running).toBe(false);
});

it('observes an exit during pending token exchange without waiting for the readiness deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const started = Promise.withResolvers<undefined>();
  http.hold = 'exchange';
  http.started = () => {
    started.resolve(undefined);
  };
  const pending = failure();
  await started.promise;
  container.State.Running = false;

  await vi.advanceTimersByTimeAsync(250);
  const error = await pending;

  expect(error).toContain('owned instance exited or changed');
  expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
});

it.each(['container', 'cookie', 'account', 'endpoint'])(
  'preserves a %s replacement during HTTP200',
  async (kind) => {
    http.beforePage = () => {
      if (kind === 'container')
        database.prepare('UPDATE instances SET container_id = ?').run('d'.repeat(64));
      if (kind === 'cookie')
        database.prepare("UPDATE instances SET dsh_cookie = 'newer-cookie'").run();
      if (kind === 'account') database.prepare("UPDATE users SET status = 'disabled'").run();
      if (kind === 'endpoint') database.prepare('UPDATE instances SET upstream_port = 12345').run();
    };

    await failure();

    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual([]);
    expect(daemon.requests.some((request) => request.path.includes('/stop?'))).toBe(false);
  },
);

it.each(['daemon-error', '304-stopped', '304-live'])(
  'reports truthful stop state for %s',
  async (kind) => {
    daemon.setComposition('boot failure\n');
    daemon.overrides.set(`POST /containers/${START_CONTAINER}/stop?t=1`, {
      status: kind === 'daemon-error' ? 500 : 304,
    });
    if (kind === '304-stopped')
      daemon.beforeRequest((request) => {
        if (request.path.includes('/stop?')) container.State.Running = false;
      });

    const error = await failure();

    expect(error).toContain(
      kind === '304-stopped' ? 'container stopped' : 'stop failed or unconfirmed',
    );
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
  },
);

it.each(['ready', 'failure'])(
  'rolls back %s audit failure without claiming an uncommitted transition',
  async (kind) => {
    if (kind === 'failure') daemon.setComposition('boot failure\n');
    database.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'instance.${kind === 'ready' ? 'ready' : 'start-failed'}'
    BEGIN SELECT RAISE(ABORT, 'unsafe external persistence error'); END`);

    const error = await failure();

    expect(database.prepare('SELECT status FROM instances').get()).toEqual({
      status: kind === 'ready' ? 'error' : 'starting',
    });
    expect(database.prepare('SELECT event_type FROM audit_events').all()).toEqual(
      kind === 'ready' ? [{ event_type: 'instance.start-failed' }] : [],
    );
    expect(error.includes('unsafe external persistence error')).toBe(false);
  },
);

it('preserves replacement ownership appearing while failure logs are being obtained', async () => {
  daemon.setComposition('boot failure\n');
  daemon.beforeRequest((request) => {
    if (request.path.includes('follow=false'))
      database.prepare('UPDATE instances SET container_id = ?').run('d'.repeat(64));
  });

  await failure();

  expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
  expect(daemon.requests.some((request) => request.path.includes('/stop?'))).toBe(false);
});

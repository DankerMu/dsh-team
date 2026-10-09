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
  seedPlatform,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from '../../test/container-start-fixture.ts';
import { seedReconciliation } from '../../test/container-reconcile-fixture.ts';

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
  addresses: [] as { hostname: unknown; port: unknown; path: unknown }[],
}));
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof NodeHttp>();
  return {
    ...original,
    request: (options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      const outgoing = new EventEmitter();
      http.addresses.push({ hostname: options.hostname, port: options.port, path: options.path });
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
  http.addresses = [];
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
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
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

function networkOwner() {
  const platform = 'f'.repeat(64);
  seedPlatform(daemon, 'dsh-team-test-platform', platform);
  container.NetworkSettings.Ports = { '3080/tcp': null };
  daemon.reply({
    method: 'POST',
    path: `/networks/${'e'.repeat(64)}/connect`,
    body: { Container: platform },
  });
  database.prepare("UPDATE instances SET upstream_host = '172.30.0.2', upstream_port = 3080").run();
  const owner = createOrchestrator({
    client: createDockerClient('/fixture/docker.sock', daemon.transport),
    database,
    config: { upstreamMode: 'network', platformContainerName: 'dsh-team-test-platform' },
  });
  return { owner, platform };
}

it('network readiness authenticates the verified IPv4:3080 and preserves its platform attachment', async () => {
  const { owner, platform } = networkOwner();
  await owner.waitForUserContainerReady({ userId: START_USER, authority });

  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'running',
    dsh_cookie: http.cookie,
  });
  expect(http.addresses).toEqual(
    expect.arrayContaining([
      { hostname: '172.30.0.2', port: 3080, path: `/?token=${encodeURIComponent(token)}` },
      { hostname: '172.30.0.2', port: 3080, path: '/' },
    ]),
  );
  expect(daemon.networks.get('e'.repeat(64))?.Containers).toHaveProperty(platform);
  expect(
    database
      .prepare("SELECT event_type FROM audit_events WHERE event_type = 'instance.ready'")
      .all(),
  ).toEqual([{ event_type: 'instance.ready' }]);
});

it.each(['clean detach', 'failed detach', 'unknown endpoint'])(
  'network readiness failure settles %s without claiming readiness or deleting data',
  async (failure) => {
    const { owner, platform } = networkOwner();
    http.exchange = 401;
    if (failure === 'failed detach')
      daemon.overrides.set(`POST /networks/${'e'.repeat(64)}/disconnect`, { status: 500 });
    if (failure === 'unknown endpoint') {
      const network = daemon.networks.get('e'.repeat(64));
      if (network === undefined) throw new Error('Network missing');
      network.Containers['8'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.4/28' };
    }
    const cleanup =
      failure === 'clean detach'
        ? 'owned network removed'
        : 'network cleanup failed or unconfirmed';

    await expect(
      owner.waitForUserContainerReady({ userId: START_USER, authority }),
    ).rejects.toThrow(cleanup);
    const expectedError: unknown = expect.stringContaining(cleanup);

    expect(
      database.prepare('SELECT status, dsh_cookie, last_error FROM instances').get(),
    ).toMatchObject({
      status: 'error',
      dsh_cookie: null,
      last_error: expectedError,
    });
    expect(daemon.networks.has('e'.repeat(64))).toBe(failure !== 'clean detach');
    if (failure === 'clean detach') {
      const expectedBridge: unknown = expect.objectContaining({
        NetworkID: '0'.repeat(64),
        IPAddress: '172.17.0.2',
      });
      expect(daemon.containers.get(platform)?.NetworkSettings.Networks).toEqual({
        bridge: expectedBridge,
      });
    }
    expect(
      daemon.requests.filter(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes'),
      ),
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT event_type FROM audit_events WHERE event_type = 'instance.ready'")
        .all(),
    ).toEqual([]);
  },
);

it('credential acquisition rejects a persisted network host that disagrees with the owned bridge before HTTP', async () => {
  const { owner } = networkOwner();
  database
    .prepare(
      "UPDATE instances SET upstream_host = '172.30.0.9', dsh_cookie = 'previous-private-cookie'",
    )
    .run();

  await expect(owner.acquireDshCookie({ userId: START_USER, authority })).rejects.toThrow(
    'owned container',
  );

  expect(http.addresses).toEqual([]);
  expect(database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'starting',
    dsh_cookie: null,
  });
  expect(
    daemon.requests.filter(({ path }) => path.includes('/stop?') || path.includes('/disconnect')),
  ).toEqual([]);
});

async function cleanedNetworkFailure() {
  const { owner, platform } = networkOwner();
  const siblingUser = 'mnopqrstuvwx';
  const siblingId = 'd'.repeat(64);
  seedReconciliation(database, daemon, siblingUser, siblingId);
  const sibling = daemon.containers.get(siblingId);
  const siblingNetwork = [...daemon.networks.values()].find(
    (network) => network.Name === `dsh-team-net-${siblingUser}`,
  );
  if (sibling === undefined || siblingNetwork === undefined)
    throw new Error('Sibling fixture unavailable');
  siblingNetwork.IPAM = { Driver: 'default', Config: [{ Subnet: '172.30.0.16/28' }] };
  siblingNetwork.Containers[siblingId] = {
    Name: `dsh-team-u-${siblingUser}`,
    IPv4Address: '172.30.0.18/28',
    EndpointID: siblingId,
  };
  sibling.NetworkSettings.Ports = { '3080/tcp': null };
  sibling.NetworkSettings.Networks = {
    [`dsh-team-net-${siblingUser}`]: {
      NetworkID: siblingNetwork.Id,
      EndpointID: siblingId,
      IPAddress: '172.30.0.18',
      Aliases: [`u-${siblingUser}`],
    },
  };
  database
    .prepare(
      "UPDATE instances SET upstream_host = '172.30.0.18', upstream_port = 3080 WHERE user_id = ?",
    )
    .run(siblingUser);
  daemon.reply({
    method: 'POST',
    path: `/networks/${siblingNetwork.Id}/connect`,
    body: { Container: platform },
  });
  const preserved = {
    row: database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingUser),
    container: structuredClone(sibling),
    network: structuredClone(siblingNetwork),
    primary: structuredClone(daemon.networks.get('0'.repeat(64))),
  };
  http.exchange = 401;

  await expect(owner.waitForUserContainerReady({ userId: START_USER, authority })).rejects.toThrow(
    'owned network removed',
  );

  expect(
    database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
  ).toMatchObject({
    status: 'error',
    container_id: START_CONTAINER,
    image_id: START_IMAGE,
    dsh_cookie: null,
  });
  expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
  expect(daemon.containers.get(START_CONTAINER)?.NetworkSettings.Networks).toEqual({});
  expect(daemon.networks.has('e'.repeat(64))).toBe(false);
  expect(daemon.containers.get(platform)?.NetworkSettings.Networks).not.toHaveProperty(
    `dsh-team-net-${START_USER}`,
  );
  return { owner, platform, siblingUser, siblingId, siblingNetwork, preserved };
}

it.each(['explicit stop', 'indexed reconciliation'])(
  'readiness cleanup leaves an owned detached error container that %s safely retires',
  async (operation) => {
    const { owner, platform, siblingUser, siblingId, siblingNetwork, preserved } =
      await cleanedNetworkFailure();

    if (operation === 'explicit stop')
      await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    else await owner.reconcile();

    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER),
    ).toMatchObject({
      status: 'stopped',
      container_id: null,
      image_id: null,
      image_tag: null,
      upstream_host: null,
      upstream_port: null,
      dsh_cookie: null,
      last_started_at: 1,
    });
    expect(
      database
        .prepare(
          'SELECT event_type, target, target_email, details FROM audit_events WHERE target = ? ORDER BY id',
        )
        .all(START_USER),
    ).toEqual([
      {
        event_type: 'instance.start-failed',
        target: START_USER,
        target_email: 'ready@example.test',
        details: '{}',
      },
      {
        event_type: 'instance.stopped',
        target: START_USER,
        target_email: 'ready@example.test',
        details: operation === 'explicit stop' ? '{"reason":"admin"}' : '{"reason":"error"}',
      },
    ]);
    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingUser)).toEqual(
      preserved.row,
    );
    expect(daemon.containers.get(siblingId)).toEqual(preserved.container);
    expect(daemon.networks.get(siblingNetwork.Id)).toEqual(preserved.network);
    expect(daemon.networks.get('0'.repeat(64))).toEqual(preserved.primary);
    expect(daemon.containers.get(platform)?.NetworkSettings.Networks).toHaveProperty(
      `dsh-team-net-${siblingUser}`,
    );
    expect(
      daemon.requests.filter(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes'),
      ),
    ).toEqual([]);
    expect(daemon.requests.filter(({ body }) => body.Force === true)).toEqual([]);
  },
);

it.each([
  'wrong image',
  'invalid detached declaration',
  'declared sibling bridge',
  'foreign stopped attachment',
  'live foreign attachment',
  'publication',
  'foreign bridge endpoint',
])(
  'post-readiness retirement rejects %s without adopting or destroying resources',
  async (fault) => {
    const { owner, siblingNetwork } = await cleanedNetworkFailure();
    const retained = daemon.containers.get(START_CONTAINER);
    if (retained === undefined) throw new Error('Retained fixture missing');
    if (fault === 'wrong image') retained.Image = `sha256:${'9'.repeat(64)}`;
    if (fault === 'invalid detached declaration')
      retained.HostConfig = { ...retained.HostConfig, NetworkMode: 'host' };
    if (fault === 'declared sibling bridge')
      retained.HostConfig = { ...retained.HostConfig, NetworkMode: siblingNetwork.Id };
    if (fault === 'foreign stopped attachment' || fault === 'live foreign attachment') {
      retained.State.Running = fault === 'live foreign attachment';
      retained.NetworkSettings.Networks = {
        foreign: {
          NetworkID: '8'.repeat(64),
          EndpointID: '9'.repeat(64),
          IPAddress: '192.0.2.2',
          Aliases: [`u-${START_USER}`],
        },
      };
    }
    if (fault === 'publication')
      retained.NetworkSettings.Ports = { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] };
    if (fault === 'foreign bridge endpoint') {
      daemon.reply({
        method: 'POST',
        path: '/networks/create',
        body: {
          Name: `dsh-team-net-${START_USER}`,
          Driver: 'bridge',
          Labels: { 'dsh-team.user': START_USER },
          IPAM: { Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] },
        },
      });
      const network = [...daemon.networks.values()].find(
        (row) => row.Name === `dsh-team-net-${START_USER}`,
      );
      if (network === undefined) throw new Error('Foreign endpoint fixture missing');
      network.Containers['8'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.4/28' };
    }
    const row = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
    const physical = structuredClone([...daemon.containers]);
    const networks = structuredClone([...daemon.networks]);
    const requestCount = daemon.requests.length;

    await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
      'User container retirement failed',
    );
    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER)).toEqual(
      row,
    );
    expect([...daemon.containers]).toEqual(physical);
    expect([...daemon.networks]).toEqual(networks);
    expect(daemon.requests.slice(requestCount).every(({ method }) => method === 'GET')).toBe(true);
    expect(
      database
        .prepare(
          "SELECT * FROM audit_events WHERE event_type IN ('instance.stopped', 'instance.ready')",
        )
        .all(),
    ).toEqual([]);
  },
);

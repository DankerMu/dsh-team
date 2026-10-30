import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createOrchestrator } from './index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import { RECONCILE_COOKIE } from '../../test/container-reconcile-fixture.ts';

const PLATFORM = 'f'.repeat(64);
const NAME = 'dsh-team-test-platform';
const roots: string[] = [];
const databases: DatabaseHandle[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const context = await startupOwnerFixture();
  roots.push(context.root);
  databases.push(context.database);
  seedPlatform(context.daemon, NAME, PLATFORM);
  const config: { upstreamMode: 'network' | 'published-loopback'; platformContainerName: string } =
    {
      upstreamMode: 'network',
      platformContainerName: NAME,
    };
  const owner = createOrchestrator({ client: context.client, database: context.database, config });
  return { ...context, owner, config };
}

function row(database: DatabaseHandle): unknown {
  return database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
}

it('captured owner transport cannot be switched into host publication by later config mutation', async () => {
  const { owner, config, input, daemon } = await fixture();
  config.upstreamMode = 'published-loopback';
  config.platformContainerName = 'dsh-team-unconfigured';

  const forged = {
    ...input,
    config: {
      ...input.config,
      upstreamMode: 'published-loopback',
      platformContainerName: 'dsh-team-unconfigured',
    },
    transport: { config },
  };
  const started = await owner.startUserContainer(forged);

  expect(started).toMatchObject({ upstreamHost: '172.30.0.2', upstreamPort: 3080 });
  expect(daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(PLATFORM);
  expect(daemon.containers.get(START_CONTAINER)?.HostConfig?.PortBindings).toBeUndefined();
});

it('reuse and unchanged reconciliation validate network upstreams without reattaching', async () => {
  const { owner, input, daemon, database } = await fixture();
  const first = await owner.startUserContainer(input);
  database.prepare("UPDATE instances SET status = 'running', dsh_cookie = ?").run(RECONCILE_COOKIE);
  const before = row(database);
  const requests = daemon.requests.length;

  expect(await owner.startUserContainer(input)).toEqual({ ...first, outcome: 'running' });
  await owner.reconcile();

  expect(row(database)).toEqual(before);
  expect(daemon.requests.slice(requests).every(({ method }) => method === 'GET')).toBe(true);
});

it.each([
  ['persisted host', 'persistedHost'],
  ['persisted port', 'persistedPort'],
  ['publication', 'publication'],
  ['publish-all', 'publishAll'],
  ['binding', 'binding'],
  ['extra instance network', 'extraInstanceNetwork'],
  ['platform replacement', 'platformReplacement'],
  ['platform endpoint disagreement', 'platformEndpointDisagreement'],
  ['foreign endpoint', 'foreignEndpoint'],
  ['platform subnet', 'platformSubnet'],
])('reuse rejects %s without mutation or recovery', async (_label, failure) => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  const container = daemon.containers.get(START_CONTAINER);
  const platform = daemon.containers.get(PLATFORM);
  const network = daemon.networks.get(START_NETWORK);
  if (container === undefined || platform === undefined || network === undefined)
    throw new Error('Started fixture unavailable');
  const mutations: Record<string, () => void> = {
    persistedHost: () => {
      database.prepare('UPDATE instances SET upstream_host = ?').run('172.30.0.9');
    },
    persistedPort: () => {
      database.prepare('UPDATE instances SET upstream_port = 3099').run();
    },
    publication: () => {
      container.NetworkSettings.Ports = { '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49173' }] };
    },
    publishAll: () => {
      container.HostConfig = { ...container.HostConfig, PublishAllPorts: true };
    },
    binding: () => {
      container.HostConfig = { ...container.HostConfig, PortBindings: { '9999/tcp': [] } };
    },
    extraInstanceNetwork: () => {
      container.NetworkSettings.Networks = { ...container.NetworkSettings.Networks, bridge: {} };
    },
    platformReplacement: () => {
      daemon.containers.delete(PLATFORM);
      daemon.containers.set('9'.repeat(64), { ...platform, Id: '9'.repeat(64) });
    },
    platformEndpointDisagreement: () => {
      platform.NetworkSettings.Networks = { bridge: {} };
    },
    foreignEndpoint: () => {
      network.Containers['8'.repeat(64)] = { Name: 'untrusted', IPv4Address: '172.30.0.4/28' };
    },
    platformSubnet: () => {
      network.Containers[PLATFORM] = {
        Name: NAME,
        IPv4Address: '172.31.0.3/28',
        EndpointID: PLATFORM,
      };
      platform.NetworkSettings.Networks = {
        [`dsh-team-net-${START_USER}`]: {
          NetworkID: START_NETWORK,
          EndpointID: PLATFORM,
          IPAddress: '172.31.0.3',
        },
      };
    },
  };
  const mutate = mutations[failure];
  if (mutate === undefined) throw new Error('Failure control missing');
  mutate();
  const before = row(database);
  const physical = structuredClone([...daemon.containers]);
  const requests = daemon.requests.length;

  await expect(owner.startUserContainer(input)).rejects.toThrow('Container startup failed');
  await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

  expect(row(database)).toEqual(before);
  expect([...daemon.containers]).toEqual(physical);
  expect(daemon.requests.slice(requests).every(({ method }) => method === 'GET')).toBe(true);
});

it.each(['starting', 'running'])(
  'reuse still rejects missing platform membership for a %s index without mutation',
  async (status) => {
    const { owner, input, daemon, database } = await fixture();
    await owner.startUserContainer(input);
    if (status === 'running')
      database
        .prepare("UPDATE instances SET status = 'running', dsh_cookie = ?")
        .run(RECONCILE_COOKIE);
    expect(
      daemon.reply({
        method: 'POST',
        path: `/networks/${START_NETWORK}/disconnect`,
        body: { Container: PLATFORM, Force: false },
      }).status,
    ).toBe(200);
    const before = row(database);
    const physical = structuredClone([...daemon.containers]);
    const networks = structuredClone([...daemon.networks]);
    const boundary = daemon.requests.length;

    await expect(owner.startUserContainer(input)).rejects.toThrow('Container startup failed');

    expect(row(database)).toEqual(before);
    expect([...daemon.containers]).toEqual(physical);
    expect([...daemon.networks]).toEqual(networks);
    expect(daemon.requests.slice(boundary).filter(({ method }) => method !== 'GET')).toEqual([]);
  },
);

it('reconciliation retires an incomplete starting index with missing platform membership without promoting it or damaging its sibling', async () => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  const other = 'mnopqrstuvwx';
  const otherContainer = 'd'.repeat(64);
  daemon.setContainerId(otherContainer);
  await owner.startUserContainer({ ...input, userId: other });
  const sibling = structuredClone(daemon.containers.get(otherContainer));
  const siblingNetwork = structuredClone(
    [...daemon.networks.values()].find((network) => network.Name === `dsh-team-net-${other}`),
  );
  if (sibling === undefined || siblingNetwork === undefined)
    throw new Error('Started sibling fixture unavailable');
  // Keep the sibling an authenticated survivor rather than a second incomplete start.
  database
    .prepare("UPDATE instances SET status = 'running', dsh_cookie = ? WHERE user_id = ?")
    .run(RECONCILE_COOKIE, other);
  const siblingRow = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(other);
  const primary = structuredClone(daemon.networks.get('0'.repeat(64)));
  const history = database
    .prepare(
      'SELECT last_started_at, last_activity_at, last_error FROM instances WHERE user_id = ?',
    )
    .get(START_USER);
  expect(row(database)).toMatchObject({ status: 'starting', dsh_cookie: null });
  expect(
    daemon.reply({
      method: 'POST',
      path: `/networks/${START_NETWORK}/disconnect`,
      body: { Container: PLATFORM, Force: false },
    }).status,
  ).toBe(200);
  const boundary = daemon.requests.length;

  await owner.reconcile();

  expect(row(database)).toMatchObject({
    status: 'stopped',
    container_id: null,
    image_id: null,
    image_tag: null,
    upstream_host: null,
    upstream_port: null,
    dsh_cookie: null,
  });
  expect(
    database
      .prepare(
        'SELECT last_started_at, last_activity_at, last_error FROM instances WHERE user_id = ?',
      )
      .get(START_USER),
  ).toEqual(history);
  expect(
    database
      .prepare(
        "SELECT event_type, target, details FROM audit_events WHERE event_type = 'instance.stopped'",
      )
      .all(),
  ).toEqual([
    { event_type: 'instance.stopped', target: START_USER, details: '{"reason":"error"}' },
  ]);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.has(START_NETWORK)).toBe(false);
  expect(daemon.containers.get(otherContainer)).toEqual(sibling);
  expect(daemon.networks.get(siblingNetwork.Id)).toEqual(siblingNetwork);
  expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(other)).toEqual(
    siblingRow,
  );
  expect(daemon.networks.get('0'.repeat(64))).toEqual(primary);
  expect(daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).toHaveProperty(
    `dsh-team-net-${other}`,
  );
  expect(daemon.requests.slice(boundary).filter(({ path }) => path.includes('/volumes'))).toEqual(
    [],
  );
  expect(daemon.requests.slice(boundary).filter(({ path }) => path.endsWith('/connect'))).toEqual(
    [],
  );
});

it.each(['connect rejected', 'platform stopped', 'wrong configured name', 'identity disagreement'])(
  'untrusted platform %s fails without successful startup evidence',
  async (failure) => {
    const { owner, input, daemon, database } = await fixture();
    if (failure === 'connect rejected')
      daemon.overrides.set(`POST /networks/${START_NETWORK}/connect`, { status: 500 });
    if (failure === 'platform stopped') {
      daemon.beforeRequest(({ method, path }) => {
        if (method !== 'POST' || path !== `/containers/${START_CONTAINER}/start`) return;
        const platform = daemon.containers.get(PLATFORM);
        if (platform === undefined) throw new Error('Platform missing');
        platform.State.Running = false;
      });
    }
    if (failure === 'wrong configured name') {
      const platform = daemon.containers.get(PLATFORM);
      if (platform === undefined) throw new Error('Platform missing');
      platform.Name = '/dsh-team-not-configured';
    }
    if (failure === 'identity disagreement')
      daemon.overrides.set(`GET /containers/${PLATFORM}/json`, {
        status: 200,
        document: { Id: '9'.repeat(64), Name: `/${NAME}`, State: { Running: true } },
      });

    await expect(owner.startUserContainer(input)).rejects.toThrow('Container startup failed');

    const audits = database.prepare('SELECT event_type FROM audit_events').all();
    expect(audits).not.toContainEqual({ event_type: 'instance.started' });
    expect(audits).not.toContainEqual({ event_type: 'instance.ready' });
    if (failure === 'connect rejected' || failure === 'platform stopped') {
      expect(daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(daemon.networks.has(START_NETWORK)).toBe(false);
      const expectedError: unknown = expect.stringContaining(
        'started container and owned network removed',
      );
      expect(row(database)).toMatchObject({
        status: 'error',
        last_error: expectedError,
      });
      expect(audits).toContainEqual({ event_type: 'instance.start-failed' });
    }
  },
);

it.each(['disconnect rejected', 'third endpoint', 'ineffective disconnect'])(
  'retirement preserves unconfirmed network state for %s and emits no stopped audit',
  async (failure) => {
    const { owner, input, daemon, database } = await fixture();
    await owner.startUserContainer(input);
    const network = daemon.networks.get(START_NETWORK);
    if (network === undefined) throw new Error('Network missing');
    if (failure === 'third endpoint')
      network.Containers['8'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.4/28' };
    else
      daemon.overrides.set(`POST /networks/${START_NETWORK}/disconnect`, {
        status: failure === 'disconnect rejected' ? 500 : 200,
      });

    await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
      'User container retirement failed',
    );

    expect(daemon.networks.has(START_NETWORK)).toBe(true);
    expect(daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(PLATFORM);
    expect(row(database)).toMatchObject({ status: 'starting' });
    expect(
      database.prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'").all(),
    ).toEqual([]);
    expect(daemon.requests.filter(({ body }) => body.Force === true)).toEqual([]);
  },
);

it('retirement removes only the selected bridge and preserves platform primary and sibling attachments', async () => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  daemon.setContainerId('d'.repeat(64));
  await owner.startUserContainer({ ...input, userId: 'mnopqrstuvwx' });
  const sibling = structuredClone(
    [...daemon.networks.values()].find((network) => network.Name === 'dsh-team-net-mnopqrstuvwx'),
  );
  const primary = structuredClone(daemon.networks.get('0'.repeat(64)));

  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(daemon.networks.has(START_NETWORK)).toBe(false);
  expect(daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(daemon.networks.get('0'.repeat(64))).toEqual(primary);
  expect(
    [...daemon.networks.values()].find((network) => network.Name === 'dsh-team-net-mnopqrstuvwx'),
  ).toEqual(sibling);
  expect(daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).toHaveProperty(
    'dsh-team-net-mnopqrstuvwx',
  );
  expect(
    daemon.requests.filter(
      ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes'),
    ),
  ).toEqual([]);
  expect(
    database
      .prepare("SELECT event_type FROM audit_events WHERE event_type = 'instance.stopped'")
      .all(),
  ).toEqual([{ event_type: 'instance.stopped' }]);
});

function placeInstance(
  daemon: Awaited<ReturnType<typeof fixture>>['daemon'],
  database: DatabaseHandle,
  address: string,
  declaration: unknown,
): void {
  const container = daemon.containers.get(START_CONTAINER);
  const network = daemon.networks.get(START_NETWORK);
  const attachment = container?.NetworkSettings.Networks?.[`dsh-team-net-${START_USER}`];
  const endpoint = network?.Containers[START_CONTAINER];
  if (typeof attachment !== 'object' || attachment === null || endpoint === undefined)
    throw new Error('Started fixture unavailable');
  // Literal fixture Docker state, rewritten as a daemon would report it.
  const reported = attachment as Record<string, unknown>;
  reported.IPAddress = address;
  if (declaration === undefined) Reflect.deleteProperty(reported, 'IPAMConfig');
  else reported.IPAMConfig = declaration;
  endpoint.IPv4Address = `${address}/28`;
  database.prepare('UPDATE instances SET upstream_host = ?').run(address);
}

it.each([
  ['absent', undefined],
  ['null', null],
  ['empty', {}],
])(
  'a running instance with %s address declaration keeps the stage-1 range check at +5',
  async (_label, declaration) => {
    const { owner, input, daemon, database } = await fixture();
    await owner.startUserContainer(input);
    database
      .prepare("UPDATE instances SET status = 'running', dsh_cookie = ?")
      .run(RECONCILE_COOKIE);
    placeInstance(daemon, database, '172.30.0.5', declaration);
    const before = row(database);
    const requests = daemon.requests.length;

    expect(await owner.startUserContainer(input)).toEqual({
      outcome: 'running',
      containerId: START_CONTAINER,
      upstreamHost: '172.30.0.5',
      upstreamPort: 3080,
    });
    await owner.reconcile();

    expect(row(database)).toEqual(before);
    expect(daemon.requests.slice(requests).every(({ method }) => method === 'GET')).toBe(true);
  },
);

it.each([
  ['missing address', '172.30.0.2', { IPv6Address: 'fd00::2' }],
  ['empty address', '172.30.0.2', { IPv4Address: '' }],
  ['non-string address', '172.30.0.2', { IPv4Address: 2 }],
  ['non-IPv4 address', '172.30.0.2', { IPv4Address: '172.30.0.2/28' }],
  ['actual address differing from it', '172.30.0.5', { IPv4Address: '172.30.0.2' }],
  ['address off the layout', '172.30.0.5', { IPv4Address: '172.30.0.5' }],
])(
  'reuse rejects a declaration with %s without mutation or recovery',
  async (_label, address, declaration) => {
    const { owner, input, daemon, database } = await fixture();
    await owner.startUserContainer(input);
    placeInstance(daemon, database, address, declaration);
    const before = row(database);
    const physical = structuredClone([...daemon.containers]);
    const requests = daemon.requests.length;

    await expect(owner.startUserContainer(input)).rejects.toThrow('Container startup failed');
    await expect(owner.reconcile()).rejects.toThrow('Instance reconciliation failed');

    expect(row(database)).toEqual(before);
    expect([...daemon.containers]).toEqual(physical);
    expect(daemon.requests.slice(requests).every(({ method }) => method === 'GET')).toBe(true);
  },
);

it('a replacement on the reused network whose +2 is held fails at start and leaves every resource', async () => {
  const { owner, input, daemon, database } = await fixture();
  await owner.startUserContainer(input);
  daemon.removeContainer(START_CONTAINER);
  const network = daemon.networks.get(START_NETWORK);
  const platform = daemon.containers.get(PLATFORM)?.NetworkSettings.Networks;
  const holder = network?.Containers[PLATFORM];
  const held = platform?.[`dsh-team-net-${START_USER}`];
  if (holder === undefined || typeof held !== 'object' || held === null)
    throw new Error('Attached platform fixture unavailable');
  holder.IPv4Address = '172.30.0.2/28';
  // Literal fixture Docker state: the platform endpoint now holds the layout container address.
  (held as Record<string, unknown>).IPAddress = '172.30.0.2';
  const replacement = 'd'.repeat(64);
  daemon.setContainerId(replacement);
  const networkBefore = structuredClone(network);
  const platformBefore = structuredClone(platform);
  const audits = database.prepare('SELECT MAX(id) AS id FROM audit_events').get() as {
    id: number;
  };
  const boundary = daemon.requests.length;

  const failure: unknown = await owner.startUserContainer(input).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Container startup failed during container start');
  expect((failure as Error).cause).toMatchObject({ stage: 'container start', dockerStatus: 500 });

  expect(database.prepare('SELECT * FROM creation_attempts').all()).toEqual([]);
  expect(row(database)).toMatchObject({
    status: 'starting',
    container_id: replacement,
    upstream_host: null,
    upstream_port: null,
    last_error: null,
  });
  expect(
    database.prepare('SELECT event_type FROM audit_events WHERE id > ? ORDER BY id').all(audits.id),
  ).toEqual([{ event_type: 'instance.created' }]);
  expect(daemon.containers.get(replacement)?.State.Running).toBe(false);
  const after = daemon.networks.get(START_NETWORK);
  if (after === undefined) throw new Error('Reused network removed');
  // The fixture registers the created endpoint before start; real Docker attaches only on start.
  Reflect.deleteProperty(after.Containers, replacement);
  expect(after).toEqual(networkBefore);
  expect(daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).toEqual(platformBefore);
  const mutations = daemon.requests
    .slice(boundary)
    .filter(({ method }) => method !== 'GET')
    .map(({ method, path }) => `${method} ${path}`);
  expect(mutations).toContain(`POST /containers/${replacement}/start`);
  expect(
    mutations.filter(
      (request) =>
        request.includes('/stop') ||
        request.startsWith(`DELETE /containers/${replacement}`) ||
        request.startsWith('DELETE /networks/') ||
        request.startsWith('DELETE /volumes/') ||
        request.endsWith('/connect') ||
        request.endsWith('/disconnect'),
    ),
  ).toEqual([]);
  // The rejection is the daemon's start-time occupancy refusal, not another start failure.
  expect(
    daemon.reply({ method: 'POST', path: `/containers/${replacement}/start`, body: {} }),
  ).toEqual({
    status: 500,
    document: { message: 'Address already in use' },
  });
});

import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../db/index.ts';
import { writeSettings } from '../db/index.ts';
import type { Orchestrator, StartUserContainerInput } from './index.ts';
import { createOrchestrator } from './index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  startupOwnerFixture,
} from '../../test/container-start-fixture.ts';
import type { StartupNetwork, StartupOwnerFixture } from '../../test/container-start-fixture.ts';

let owner: Orchestrator;
let database: DatabaseHandle;
let input: StartUserContainerInput;
let root: string;
let networks: Map<string, StartupNetwork>;
let fixture: StartupOwnerFixture;

beforeEach(async () => {
  fixture = await startupOwnerFixture();
  ({ owner, database, input, root } = fixture);
  networks = fixture.daemon.networks;
  input = { ...input, config: { ...input.config, subnetPool: '172.30.0.0/26' } };
});
afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

function document(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Missing fixture document');
  // This is literal external Docker fixture state, not a production collaborator.
  return value as Record<string, unknown>;
}
function owned() {
  const network =
    networks.get(START_NETWORK) ??
    [...networks.values()].find(({ Name }) => Name === `dsh-team-net-${START_USER}`);
  if (network === undefined) throw new Error('Missing fixture owned network');
  return network;
}
function state() {
  return {
    rows: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
    audit: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
    networks: structuredClone([...networks]),
    containers: structuredClone([...fixture.daemon.containers]),
  };
}

it('excludes unlabeled foreign Docker ranges and allocates the first free aligned subnet', async () => {
  networks.set('f'.repeat(64), {
    Id: 'f'.repeat(64),
    Name: 'foreign-unlabeled',
    Labels: {},
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: false,
    IPAM: { Config: [{ Subnet: '172.30.0.0/27' }] },
    Containers: {},
  });

  await owner.startUserContainer(input);

  expect(owned().IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.32/28' }] });
  expect(networks.get('f'.repeat(64))?.IPAM).toEqual({ Config: [{ Subnet: '172.30.0.0/27' }] });
});

it.each([undefined, '', '   '])(
  'unconfigured %j leaves all Docker and database state untouched',
  async (modelKey) => {
    const before = state();

    expect(await owner.startUserContainer({ ...input, modelKey })).toEqual({
      outcome: 'unconfigured',
    });

    expect(state()).toEqual(before);
    expect(fixture.daemon.requests).toEqual([]);
  },
);

it('full admission performs no allocation and preserves every existing resource', async () => {
  writeSettings(database, { maxRunningInstances: 1 });
  await owner.startUserContainer(input);
  const before = state();
  const requests = structuredClone(fixture.daemon.requests);

  expect(await owner.startUserContainer({ ...input, userId: 'mnopqrstuvwx' })).toEqual({
    outcome: 'full',
  });

  expect(state()).toEqual(before);
  expect(fixture.daemon.requests).toEqual(requests);
});

it('never adopts a foreign canonical same-name network', async () => {
  const foreign: StartupNetwork = {
    Id: START_NETWORK,
    Name: `dsh-team-net-${START_USER}`,
    Driver: 'bridge',
    Labels: { 'dsh-team.user': 'mnopqrstuvwx' },
    Internal: false,
    EnableIPv6: false,
    IPAM: { Config: [{ Subnet: '172.30.0.0/28' }] },
    Containers: {},
  };
  networks.set(START_NETWORK, foreign);

  await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

  expect(networks.get(START_NETWORK)).toEqual(foreign);
  expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
});

it.each(['exhausted', 'malformed', 'not-array'] as const)(
  'rejects %s all-network discovery without container creation',
  async (kind) => {
    const document =
      kind === 'not-array'
        ? {}
        : [
            {
              Id: 'f'.repeat(64),
              IPAM: {
                Config: [{ Subnet: kind === 'exhausted' ? '172.30.0.0/26' : '172.30.0.999/28' }],
              },
            },
          ];
    fixture.daemon.overrides.set('GET /networks', { status: 200, document });

    await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

    expect([...networks.keys()]).toEqual(['0'.repeat(64)]);
    expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
  },
);

it.each([
  'Id',
  'Name',
  'Labels',
  'Driver',
  'Internal',
  'EnableIPv6',
  'IPAM',
  'Containers',
] as const)(
  'rejects new network %s corruption without deleting unverified resources',
  async (field) => {
    fixture.daemon.beforeRequest(({ method, path }) => {
      if (method !== 'GET' || path !== `/networks/${START_NETWORK}`) return;
      const row = owned();
      if (field === 'Id') row.Id = 'f'.repeat(64);
      if (field === 'Name') row.Name = 'foreign';
      if (field === 'Labels') row.Labels = { 'dsh-team.user': 'mnopqrstuvwx' };
      if (field === 'Driver') row.Driver = 'overlay';
      if (field === 'Internal') row.Internal = true;
      if (field === 'EnableIPv6') row.EnableIPv6 = true;
      if (field === 'IPAM') row.IPAM = { Config: [{ Subnet: '172.30.0.0/27' }] };
      if (field === 'Containers')
        row.Containers['f'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.3/28' };
    });

    await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

    expect(networks.has(START_NETWORK)).toBe(true);
    expect(
      fixture.daemon.requests.some(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/networks'),
      ),
    ).toBe(false);
    expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
  },
);

it('captured empty network rolls back when independent validation fails, then a successor can allocate it', async () => {
  fixture.daemon.overrides.set(`GET /networks/${START_NETWORK}`, { status: 500 });
  // Fail only active validation; independent cleanup still observes the actual Engine resource.
  let failed = false;
  fixture.daemon.beforeRequest(({ path }) => {
    if (path === `/networks/${START_NETWORK}` && failed)
      fixture.daemon.overrides.delete(`GET ${path}`);
    if (path === `/networks/${START_NETWORK}`) failed = true;
  });

  await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

  expect(networks.has(START_NETWORK)).toBe(false);
  await owner.startUserContainer(input);
  expect(owned().IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] });
});

it('uncertain final container creation retains the captured network rather than destructive rollback', async () => {
  fixture.daemon.overrides.set(`POST /containers/create?name=dsh-team-u-${START_USER}`, {
    status: 500,
  });

  await expect(owner.startUserContainer(input)).rejects.toThrow('container creation');

  expect(networks.has(START_NETWORK)).toBe(true);
  expect(owned().Containers).toEqual({});
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
});

it.each(['missing', 'extra', 'id', 'alias', 'foreign-endpoint', 'address', 'endpoint-id'] as const)(
  'reuse rejects %s attachment without resource or database mutations',
  async (kind) => {
    await owner.startUserContainer(input);
    const container = fixture.daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Fixture missing container');
    const attached = container.NetworkSettings.Networks;
    if (attached === undefined) throw new Error('Fixture missing attachment');
    const endpoint = document(attached[`dsh-team-net-${START_USER}`]);
    if (kind === 'missing') Reflect.deleteProperty(attached, `dsh-team-net-${START_USER}`);
    if (kind === 'extra') attached.bridge = { NetworkID: '0'.repeat(64) };
    if (kind === 'id') endpoint.NetworkID = 'f'.repeat(64);
    if (kind === 'alias') endpoint.Aliases = ['foreign'];
    if (kind === 'address') endpoint.IPAddress = '172.31.0.2';
    if (kind === 'endpoint-id') endpoint.EndpointID = 'f'.repeat(64);
    if (kind === 'foreign-endpoint')
      owned().Containers['f'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.3/28' };
    const before = state();

    await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');

    expect(state()).toEqual(before);
  },
);

it('retirement cleans a missing container owned empty network before committing stopped', async () => {
  await owner.startUserContainer(input);
  fixture.daemon.removeContainer(START_CONTAINER);

  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(networks.has(START_NETWORK)).toBe(false);
  expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
    status: 'stopped',
    container_id: null,
  });
  expect(
    database
      .prepare("SELECT details FROM audit_events WHERE event_type = 'instance.stopped'")
      .get(),
  ).toEqual({ details: '{"reason":"admin"}' });
});

it.each(['foreign-label', 'foreign-endpoint', 'delete-failed', 'ineffective-delete'] as const)(
  'retirement %s never claims successful stopped state',
  async (kind) => {
    await owner.startUserContainer(input);
    const before = database.prepare('SELECT * FROM instances').get();
    if (kind === 'foreign-label') owned().Labels = { 'dsh-team.user': 'mnopqrstuvwx' };
    if (kind === 'foreign-endpoint')
      owned().Containers['f'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.3/28' };
    if (kind === 'delete-failed')
      fixture.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });
    if (kind === 'ineffective-delete')
      fixture.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 204 });

    await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
      'retirement failed',
    );

    expect(networks.has(START_NETWORK)).toBe(true);
    expect(database.prepare('SELECT * FROM instances').get()).toEqual(before);
    expect(
      database.prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'").all(),
    ).toEqual([]);
    expect(fixture.daemon.requests.some(({ path }) => path.endsWith('/disconnect'))).toBe(false);
  },
);

it('database audit failure after network deletion preserves the indexed identity and retry settles idempotently', async () => {
  await owner.startUserContainer(input);
  const before = database.prepare('SELECT * FROM instances').get();
  database.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'instance.stopped' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);

  await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
    'retirement failed',
  );

  expect(networks.has(START_NETWORK)).toBe(false);
  expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(before);
  database.exec('DROP TRIGGER reject_stop');
  await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
  expect(database.prepare('SELECT status, container_id FROM instances').get()).toEqual({
    status: 'stopped',
    container_id: null,
  });
});

it('readiness failure retains the confirmed stopped container but disconnects its own endpoint and removes its network', async () => {
  await owner.startUserContainer(input);

  await expect(
    owner.waitForUserContainerReady({ userId: START_USER, authority: input.config.authority }),
  ).rejects.toThrow('owned network removed');

  expect(fixture.daemon.containers.get(START_CONTAINER)?.State).toEqual({ Running: false });
  expect(fixture.daemon.containers.get(START_CONTAINER)?.NetworkSettings.Networks).toEqual({});
  expect(networks.has(START_NETWORK)).toBe(false);
  expect(database.prepare('SELECT status, container_id, dsh_cookie FROM instances').get()).toEqual({
    status: 'error',
    container_id: START_CONTAINER,
    dsh_cookie: null,
  });
  expect(database.prepare('SELECT event_type FROM audit_events ORDER BY id').all()).toEqual([
    { event_type: 'instance.created' },
    { event_type: 'instance.started' },
    { event_type: 'instance.start-failed' },
  ]);
});

it.each(['stop', 'disconnect', 'delete'] as const)(
  'readiness %s failure reports uncertainty and never deletes an unsafe network',
  async (kind) => {
    await owner.startUserContainer(input);
    const operation =
      kind === 'stop'
        ? `POST /containers/${START_CONTAINER}/stop?t=1`
        : kind === 'disconnect'
          ? `POST /networks/${START_NETWORK}/disconnect`
          : `DELETE /networks/${START_NETWORK}`;
    fixture.daemon.overrides.set(operation, { status: 500 });

    await expect(
      owner.waitForUserContainerReady({ userId: START_USER, authority: input.config.authority }),
    ).rejects.toThrow(
      kind === 'stop'
        ? 'container stop failed or unconfirmed'
        : 'network cleanup failed or unconfirmed',
    );

    expect(networks.has(START_NETWORK)).toBe(true);
    expect(fixture.daemon.containers.get(START_CONTAINER)?.State).toEqual({
      Running: kind === 'stop',
    });
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
    expect(
      database.prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'").all(),
    ).toEqual([]);
    if (kind === 'stop')
      expect(fixture.daemon.requests.some(({ path }) => path.endsWith('/disconnect'))).toBe(false);
  },
);

it.each([false, true])(
  'pre-container cancellation rolls back only its captured empty network (cleanup failure=%s)',
  async (cleanupFailed) => {
    const controller = new AbortController();
    if (cleanupFailed)
      fixture.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });
    const client: typeof fixture.client = {
      ...fixture.client,
      async json(method, path, body, signal, maxBytes) {
        const response = await fixture.client.json(method, path, body, signal, maxBytes);
        // Cancel at the external response boundary, after allocation validation has really completed.
        if (method === 'GET' && path === `/networks/${START_NETWORK}`) controller.abort();
        return response;
      },
    };
    const canceledOwner = createOrchestrator({ client, database });

    await expect(
      canceledOwner.startUserContainer({ ...input, signal: controller.signal }),
    ).rejects.toThrow(cleanupFailed ? 'network rollback failed' : 'container creation');

    expect(networks.has(START_NETWORK)).toBe(cleanupFailed);
    expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
  },
);

it('exact indexed container absence reuses only its verified empty owned bridge identity', async () => {
  await owner.startUserContainer(input);
  const before = structuredClone(owned());
  fixture.daemon.removeContainer(START_CONTAINER);
  const replacement = 'd'.repeat(64);
  fixture.daemon.setContainerId(replacement);

  expect(await owner.startUserContainer(input)).toMatchObject({
    outcome: 'starting',
    containerId: replacement,
  });

  expect(owned().Id).toBe(before.Id);
  expect(owned().IPAM).toEqual(before.IPAM);
  expect(owned().Containers).toEqual({
    [replacement]: {
      Name: `dsh-team-u-${START_USER}`,
      IPv4Address: '172.30.0.2/28',
      EndpointID: replacement,
    },
  });
});

it('exact indexed container absence never permits adoption of a relabeled same-name bridge', async () => {
  await owner.startUserContainer(input);
  fixture.daemon.removeContainer(START_CONTAINER);
  owned().Labels = { 'dsh-team.user': 'mnopqrstuvwx' };
  const before = state();

  await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

  expect(state()).toEqual(before);
});

it('ignores non-IPv4 inventory ranges without treating absent IPAM entries as reservations', async () => {
  networks.set('f'.repeat(64), {
    Id: 'f'.repeat(64),
    Name: 'foreign-v6',
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: true,
    Labels: {},
    IPAM: { Config: [{ Subnet: 'fd00::/64' }, {}, { Subnet: '' }] },
    Containers: {},
  });
  networks.set('d'.repeat(64), {
    Id: 'd'.repeat(64),
    Name: 'foreign-offline',
    Driver: 'null',
    Internal: false,
    EnableIPv6: false,
    Labels: {},
    IPAM: { Config: null },
    Containers: {},
  });

  await owner.startUserContainer(input);

  const network = [...networks.values()].find(({ Name }) => Name === `dsh-team-net-${START_USER}`);
  expect(network?.IPAM).toEqual({ Driver: 'default', Config: [{ Subnet: '172.30.0.0/28' }] });
});

it('a create response with a different valid subnet never authorizes destructive rollback of that identity', async () => {
  fixture.daemon.beforeRequest(({ method, path }) => {
    if (method === 'GET' && path === `/networks/${START_NETWORK}`)
      owned().IPAM = { Config: [{ Subnet: '172.30.0.16/28' }] };
  });

  await expect(owner.startUserContainer(input)).rejects.toThrow('network allocation');

  expect(networks.has(START_NETWORK)).toBe(true);
  expect(
    fixture.daemon.requests.some(
      ({ method, path }) => method === 'DELETE' && path.startsWith('/networks'),
    ),
  ).toBe(false);
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
});

it('network retirement never adopts or deletes a foreign same-name replacement appearing during removal', async () => {
  await owner.startUserContainer(input);
  const before = database.prepare('SELECT * FROM instances').get();
  const foreignId = 'f'.repeat(64);
  fixture.daemon.beforeRequest(({ method, path }) => {
    if (method === 'DELETE' && path === `/networks/${START_NETWORK}`) {
      networks.set(foreignId, {
        ...owned(),
        Id: foreignId,
        Labels: { 'dsh-team.user': 'mnopqrstuvwx' },
        Containers: {},
      });
    }
  });

  await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
    'retirement failed',
  );

  expect(networks.has(START_NETWORK)).toBe(false);
  expect(networks.get(foreignId)?.Labels).toEqual({ 'dsh-team.user': 'mnopqrstuvwx' });
  expect(database.prepare('SELECT * FROM instances').get()).toEqual(before);
  expect(
    database.prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'").all(),
  ).toEqual([]);
});

it.each(['name', 'id'] as const)(
  'a not-yet-started Engine declaration keyed by %s still starts directly on its captured immutable bridge',
  async (key) => {
    fixture.daemon.beforeRequest(({ method, path }) => {
      if (method !== 'GET' || path !== `/containers/${START_CONTAINER}/json`) return;
      const container = fixture.daemon.containers.get(START_CONTAINER);
      if (container === undefined || container.State.Running) return;
      const attached = container.NetworkSettings.Networks;
      if (attached === undefined) throw new Error('Missing pending attachment');
      const name = `dsh-team-net-${START_USER}`;
      const endpoint = document(attached[name]);
      endpoint.NetworkID = '';
      endpoint.EndpointID = '';
      endpoint.IPAddress = '';
      owned().Containers = {};
      if (key === 'id') {
        Reflect.deleteProperty(attached, name);
        attached[START_NETWORK] = endpoint;
      }
    });

    expect(await owner.startUserContainer(input)).toMatchObject({
      outcome: 'starting',
      containerId: START_CONTAINER,
    });

    expect(fixture.daemon.containers.get(START_CONTAINER)?.HostConfig?.NetworkMode).toBe(
      START_NETWORK,
    );
    expect(owned().Containers).toEqual({
      [START_CONTAINER]: {
        Name: `dsh-team-u-${START_USER}`,
        IPv4Address: '172.30.0.2/28',
        EndpointID: START_CONTAINER,
      },
    });
    expect(database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'starting' });
  },
);

it('reuse rejects an implicit default-bridge declaration even if an inspect document claims an owned attachment', async () => {
  await owner.startUserContainer(input);
  const container = fixture.daemon.containers.get(START_CONTAINER);
  if (container === undefined) throw new Error('Missing fixture container');
  container.HostConfig = { NetworkMode: 'bridge' };
  const before = state();

  await expect(owner.startUserContainer(input)).rejects.toThrow('current container validation');

  expect(state()).toEqual(before);
});

it('loss of an accepted create response reports uncertainty and never adopts or deletes the unconfirmed bridge', async () => {
  const client: typeof fixture.client = {
    ...fixture.client,
    async json(method, path, body, signal, maxBytes) {
      const response = await fixture.client.json(method, path, body, signal, maxBytes);
      // The external Engine mutated, but the client boundary could not deliver its identity.
      if (method === 'POST' && path === '/networks/create')
        throw new Error('fixture transport response lost with private diagnostic');
      return response;
    },
  };
  const uncertainOwner = createOrchestrator({ client, database });

  await expect(uncertainOwner.startUserContainer(input)).rejects.toThrow(
    'network creation outcome unconfirmed',
  );

  expect(owned().Containers).toEqual({});
  expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
  expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
  expect(
    fixture.daemon.requests.some(
      ({ method, path }) => method === 'DELETE' && path.startsWith('/networks'),
    ),
  ).toBe(false);
  const before = state();
  const requests = structuredClone(fixture.daemon.requests);
  expect(await uncertainOwner.startUserContainer({ ...input, modelKey: undefined })).toEqual({
    outcome: 'unconfigured',
  });
  expect(state()).toEqual(before);
  expect(fixture.daemon.requests).toEqual(requests);
  await expect(uncertainOwner.startUserContainer(input)).rejects.toThrow('network allocation');
  expect(state()).toEqual(before);
  await expect(uncertainOwner.reconcile()).rejects.toThrow('Instance reconciliation failed');
  expect(state()).toEqual(before);
});

it('a definite daemon create rejection remains an explicit failure without transport-uncertainty or compensation', async () => {
  fixture.daemon.overrides.set('POST /networks/create', {
    status: 409,
    document: { message: 'fixture subnet collision' },
  });
  const before = structuredClone([...networks]);

  const failed = await owner.startUserContainer(input).catch((error: unknown) => error);

  if (!(failed instanceof Error)) throw new Error('Expected rejected startup');
  expect(failed.message).toContain('network allocation');
  expect(failed.message).not.toContain('network creation outcome unconfirmed');
  expect([...networks]).toEqual(before);
  expect(fixture.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
  expect(
    fixture.daemon.requests.some(
      ({ method, path }) => method === 'DELETE' && path.startsWith('/networks'),
    ),
  ).toBe(false);
});

import { afterEach, expect, it } from 'vitest';
import { writeSettings } from '../db/index.ts';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
} from '../../test/container-start-fixture.ts';
import type { StartupDaemon } from '../../test/container-start-fixture.ts';
import {
  expectReconciliationRejected,
  reconciliationState,
} from '../../test/container-reconcile-fixture.ts';
import {
  DS_ID,
  DS_NAME,
  DS_PLATFORM,
  DS_PLATFORM_NAME,
  NULL_RECORD,
  documentServerAttachment,
  documentServerFixture,
  documentServerRecord,
  losingClient,
  markRunning,
  mutations,
  rejectDocumentServer,
  stopDocumentServer,
} from '../../test/container-document-server-fixture.ts';

const fixtures: Awaited<ReturnType<typeof documentServerFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

/** A bundled network start that attached the recorded Document Server at base+4. */
async function attached() {
  const f = await documentServerFixture();
  fixtures.push(f);
  await f.owner.startUserContainer(f.input);
  expect(f.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(DS_ID);
  return f;
}

const BUNDLED_RECORD = {
  document_server_mode: 'bundled',
  document_server_container_id: DS_ID,
  document_server_reason: null,
};
const DS_DISCONNECT = {
  request: `POST /networks/${START_NETWORK}/disconnect`,
  body: { Container: DS_ID, Force: false },
};

function primaryOnly(daemon: StartupDaemon): void {
  expect(Object.keys(daemon.containers.get(DS_ID)?.NetworkSettings.Networks ?? {})).toEqual([
    'bridge',
  ]);
}

it('stop disconnects the recorded Document Server after the platform, deletes the bridge and clears the record', async () => {
  const f = await attached();
  const from = f.daemon.requests.length;

  await f.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(mutations(f.daemon.requests, from)).toEqual([
    { request: `POST /containers/${START_CONTAINER}/stop?t=1`, body: {} },
    { request: `DELETE /containers/${START_CONTAINER}`, body: {} },
    {
      request: `POST /networks/${START_NETWORK}/disconnect`,
      body: { Container: DS_PLATFORM, Force: false },
    },
    DS_DISCONNECT,
    { request: `DELETE /networks/${START_NETWORK}`, body: {} },
  ]);
  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'stopped' });
  expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  primaryOnly(f.daemon);
});

it.each(['switched to external', 'configuration removed'])(
  'stop after the Document Server is %s still disconnects by record',
  async (kind) => {
    const f = await attached();
    if (kind === 'switched to external')
      writeSettings(f.database, {
        documentServerUrl: 'http://office.example',
        documentServerJwtSecret: 'fixture-external-jwt',
      });
    // A restarted platform without Document Server configuration has a fresh owner.
    const owner = kind === 'configuration removed' ? f.ownerFor() : f.owner;

    await owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

    expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
    expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
    expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
    primaryOnly(f.daemon);
  },
);

it('stop accepts a recorded Document Server endpoint that disappeared with its container', async () => {
  const f = await attached();
  f.daemon.removeContainer(DS_ID);

  await f.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(mutations(f.daemon.requests)).not.toContainEqual(DS_DISCONNECT);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
});

it.each(['remains after disconnect', 'disconnect fails before submission'])(
  'a recorded endpoint that %s fails retirement and keeps the bridge and the record',
  async (kind) => {
    const f = await attached();
    const owner =
      kind === 'remains after disconnect'
        ? f.owner
        : f.ownerFor(losingClient(f.client, 'disconnect', false));
    if (kind === 'remains after disconnect') rejectDocumentServer(f.daemon, 'disconnect');

    await expect(owner.stopUserContainer({ userId: START_USER, reason: 'admin' })).rejects.toThrow(
      'User container retirement failed',
    );

    expect(f.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(DS_ID);
    expect(documentServerRecord(f.database)).toEqual(BUNDLED_RECORD);
    expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({
      status: 'starting',
    });
  },
);

it('a lost disconnect response that inspection confirms settles the retirement', async () => {
  const f = await attached();

  await f
    .ownerFor(losingClient(f.client, 'disconnect', true))
    .stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
  primaryOnly(f.daemon);
});

it.each(['present', 'gone'])(
  'reconciliation keeps a running instance whose recorded endpoint is %s and never connects',
  async (kind) => {
    const f = await attached();
    markRunning(f.database);
    if (kind === 'gone') f.daemon.removeContainer(DS_ID);
    const before = reconciliationState(f.database);
    const from = f.daemon.requests.length;

    await f.ownerFor().reconcile();
    await f.ownerFor().reconcile();

    expect(reconciliationState(f.database)).toEqual(before);
    expect(mutations(f.daemon.requests, from)).toEqual([]);
  },
);

it('reconciliation after platform recreation re-attaches only the platform beside the recorded endpoint', async () => {
  const f = await attached();
  markRunning(f.database);
  const endpoint = structuredClone(f.daemon.networks.get(START_NETWORK)?.Containers[DS_ID]);
  f.daemon.removeContainer(DS_PLATFORM);
  seedPlatform(f.daemon, DS_PLATFORM_NAME, '6'.repeat(64));
  const before = reconciliationState(f.database);
  const from = f.daemon.requests.length;

  await f.ownerFor().reconcile();

  expect(mutations(f.daemon.requests, from)).toEqual([
    {
      request: `POST /networks/${START_NETWORK}/connect`,
      body: {
        Container: '6'.repeat(64),
        EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.3' } },
      },
    },
  ]);
  expect(f.daemon.networks.get(START_NETWORK)?.Containers[DS_ID]).toEqual(endpoint);
  expect(reconciliationState(f.database)).toEqual(before);
});

it.each(['same name, other ID', 'unrecorded', 'container gone', 'identity changed'])(
  'reconciliation fails closed on a %s Document Server endpoint without writes',
  async (kind) => {
    const f = await attached();
    markRunning(f.database);
    const network = f.daemon.networks.get(START_NETWORK);
    if (network === undefined) throw new Error('Missing fixture network');
    if (kind === 'same name, other ID')
      network.Containers['7'.repeat(64)] = {
        Name: DS_NAME,
        IPv4Address: '172.30.0.5/28',
        EndpointID: '7'.repeat(64),
      };
    if (kind === 'unrecorded')
      f.database.exec('UPDATE instances SET document_server_container_id = NULL');
    if (kind === 'container gone') f.daemon.containers.delete(DS_ID);
    const container = f.daemon.containers.get(DS_ID);
    if (kind === 'identity changed')
      f.daemon.overrides.set(`GET /containers/${DS_ID}/json`, {
        status: 200,
        document: { ...container, Id: '7'.repeat(64) },
      });
    f.daemon.requests.splice(0);

    await expectReconciliationRejected(f.database, f.daemon, f.ownerFor());
  },
);

/** Off the bridge, only a stopped or restart-backoff peer whose endpoint Docker released passes. */
it.each([
  ['running, not restarting', 'restarting', { Restarting: false }, {}],
  ['restarting with an endpoint ID', 'restarting', {}, { EndpointID: '8'.repeat(64) }],
  ['stopped with an endpoint ID', 'stopped', {}, { EndpointID: '8'.repeat(64) }],
] as const)(
  'reconciliation fails closed on an off-bridge %s Document Server without writes',
  async (_kind, state, status, endpoint) => {
    const f = await attached();
    markRunning(f.database);
    stopDocumentServer(f.daemon, state);
    const container = f.daemon.containers.get(DS_ID);
    const attachment = documentServerAttachment(f.daemon);
    if (container === undefined || typeof attachment !== 'object' || attachment === null)
      throw new Error('Missing fixture Document Server attachment');
    Object.assign(container.State, status);
    Object.assign(attachment, endpoint);
    f.daemon.requests.splice(0);

    await expectReconciliationRejected(f.database, f.daemon, f.ownerFor());
  },
);

it('a stopped Document Server attachment is accepted by health and reuse and disconnected on retirement', async () => {
  const f = await attached();
  markRunning(f.database);
  stopDocumentServer(f.daemon);
  const before = reconciliationState(f.database);

  await f.ownerFor().reconcile();
  const reused = await f.owner.startUserContainer(f.input);
  await f.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(reconciliationState(f.database).audits.length).toBe(before.audits.length + 1);
  expect(reused).toMatchObject({ outcome: 'running', containerId: START_CONTAINER });
  expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerAttachment(f.daemon)).toBeUndefined();
  expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
});

/**
 * Restart-policy backoff: Docker reports the peer `Running` with its endpoint released, so a
 * non-force disconnect is refused until the peer stops (config-only removal) or rejoins (live).
 */
function backoff(daemon: StartupDaemon): (recovery: 'stopped' | 'rejoined') => void {
  const network = daemon.networks.get(START_NETWORK);
  const live = structuredClone({
    endpoint: network?.Containers[DS_ID],
    attachment: documentServerAttachment(daemon),
  });
  stopDocumentServer(daemon, 'restarting');
  return (recovery) => {
    if (recovery === 'stopped') {
      stopDocumentServer(daemon);
      return;
    }
    const container = daemon.containers.get(DS_ID);
    const networks = container?.NetworkSettings.Networks;
    if (
      network === undefined ||
      container === undefined ||
      networks === undefined ||
      live.endpoint === undefined
    )
      throw new Error('Missing fixture Document Server attachment');
    Object.assign(container.State, { Running: true, Restarting: false });
    network.Containers[DS_ID] = live.endpoint;
    networks[`dsh-team-net-${START_USER}`] = live.attachment;
  };
}

/** During backoff the bridge, the peer's configuration and the record all remain. */
function retained(f: Awaited<ReturnType<typeof attached>>, status: string): void {
  expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
  expect(f.daemon.networks.get(START_NETWORK)?.Containers).not.toHaveProperty(DS_ID);
  expect(documentServerAttachment(f.daemon)).toMatchObject({
    NetworkID: START_NETWORK,
    EndpointID: '',
  });
  expect(documentServerRecord(f.database)).toEqual(BUNDLED_RECORD);
  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status });
}

/** A retried retirement after backoff removes the bridge and the peer's attachment and clears the record. */
async function retired(f: Awaited<ReturnType<typeof attached>>): Promise<void> {
  await f.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerAttachment(f.daemon)).toBeUndefined();
  expect(documentServerRecord(f.database)).toEqual(NULL_RECORD);
  expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'stopped' });
}

it.each(['stopped', 'rejoined'] as const)(
  'a restarting Document Server attachment passes health and reuse, fails retirement closed and retires once it has %s',
  async (recovery) => {
    const f = await attached();
    markRunning(f.database);
    const recover = backoff(f.daemon);
    const before = reconciliationState(f.database);

    await f.ownerFor().reconcile();
    const reused = await f.owner.startUserContainer(f.input);
    await expect(
      f.owner.stopUserContainer({ userId: START_USER, reason: 'admin' }),
    ).rejects.toThrow('User container retirement failed');

    expect(reused).toMatchObject({ outcome: 'running', containerId: START_CONTAINER });
    expect(reconciliationState(f.database).audits).toEqual(before.audits);
    retained(f, 'running');
    recover(recovery);
    await retired(f);
  },
);

it.each(['recorded', 'unrecorded'])(
  'orphan network reclamation %s Document Server endpoint',
  async (kind) => {
    const f = await attached();
    f.daemon.removeContainer(START_CONTAINER);
    f.database.exec("UPDATE instances SET status = 'error', container_id = NULL");
    if (kind === 'unrecorded')
      f.database.exec('UPDATE instances SET document_server_container_id = NULL');

    const reconciled = f.ownerFor().reconcile();

    if (kind === 'unrecorded') {
      await expect(reconciled).rejects.toThrow('Instance reconciliation failed');
      expect(f.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(DS_ID);
      return;
    }
    await reconciled;
    expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
    expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
    primaryOnly(f.daemon);
  },
);

it.each(['owned network removed', 'network cleanup failed or unconfirmed'])(
  'readiness failure cleanup reports %s and keeps the Document Server record on the error row',
  async (outcome) => {
    const f = await attached();
    f.daemon.setComposition('boot failure without a launch line\n');
    if (outcome !== 'owned network removed')
      f.daemon.overrides.set(`DELETE /networks/${START_NETWORK}`, { status: 500 });

    await expect(
      f.owner.waitForUserContainerReady({ userId: START_USER, authority: 'team.example:8443' }),
    ).rejects.toThrow(outcome);

    expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({ status: 'error' });
    expect(documentServerRecord(f.database)).toEqual(BUNDLED_RECORD);
    expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
  },
);

it('readiness failure cleanup disconnects a stopped Document Server attachment and removes the bridge', async () => {
  const f = await attached();
  stopDocumentServer(f.daemon);
  f.daemon.setComposition('boot failure without a launch line\n');

  await expect(
    f.owner.waitForUserContainerReady({ userId: START_USER, authority: 'team.example:8443' }),
  ).rejects.toThrow('owned network removed');

  expect(mutations(f.daemon.requests)).toContainEqual(DS_DISCONNECT);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(documentServerAttachment(f.daemon)).toBeUndefined();
});

it.each(['stopped', 'rejoined'] as const)(
  'readiness failure cleanup fails closed on a restarting Document Server attachment and a retried retirement succeeds once it has %s',
  async (recovery) => {
    const f = await attached();
    const recover = backoff(f.daemon);
    f.daemon.setComposition('boot failure without a launch line\n');

    await expect(
      f.owner.waitForUserContainerReady({ userId: START_USER, authority: 'team.example:8443' }),
    ).rejects.toThrow('network cleanup failed or unconfirmed');

    retained(f, 'error');
    recover(recovery);
    await retired(f);
  },
);

it('interrupted creation on a reused bridge recovers by the old record and keeps it on the error row', async () => {
  const f = await attached();
  f.daemon.removeContainer(START_CONTAINER);
  let losing = true;
  const owner = f.ownerFor({
    ...f.client,
    async json(method, path, body, signal, maxBytes) {
      const response = await f.client.json(method, path, body, signal, maxBytes);
      if (losing && path === `/containers/create?name=dsh-team-u-${START_USER}`)
        throw new Error('Fixture loses the applied create response');
      return response;
    },
  });
  await expect(owner.startUserContainer(f.input)).rejects.toThrow('container creation');
  losing = false;
  expect(f.database.prepare('SELECT * FROM creation_attempts').all()).toHaveLength(1);
  const from = f.daemon.requests.length;

  await f.ownerFor().reconcile();

  expect(mutations(f.daemon.requests, from)).toContainEqual(DS_DISCONNECT);
  expect(f.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
  expect(
    f.database.prepare('SELECT status, container_id, last_error FROM instances').get(),
  ).toEqual({
    status: 'error',
    container_id: null,
    last_error: 'Interrupted container creation recovered',
  });
  expect(documentServerRecord(f.database)).toEqual(BUNDLED_RECORD);
  primaryOnly(f.daemon);
});

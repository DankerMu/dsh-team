import { afterEach, expect, it, vi } from 'vitest';
import {
  START_CONTAINER,
  START_NETWORK,
  START_USER,
  seedPlatform,
  startupBarrier,
  expectUnconfirmedStartup,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';
import type { StartupRequest } from './container-start-fixture.ts';

const PLATFORM = 'f'.repeat(64);
const OTHER = 'mnopqrstuvwx';
const SECOND = 'd'.repeat(64);
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function fixture() {
  const context = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-transport-settlement-',
    users: { [START_USER]: `${START_USER}@example.test`, [OTHER]: `${OTHER}@example.test` },
    userImage: 'image:test',
    subnetPool: '172.30.0.0/26',
    transport: { upstreamMode: 'network', platformContainerName: 'dsh-team-test-platform' },
  });
  const { daemon } = context;
  closes.push(() => context.close());
  seedPlatform(daemon, 'dsh-team-test-platform', PLATFORM);
  daemon.beforeRequest(({ path }) => {
    if (path === `/containers/create?name=dsh-team-u-${OTHER}`) daemon.setContainerId(SECOND);
    if (path === `/containers/create?name=dsh-team-u-${START_USER}`)
      daemon.setContainerId(START_CONTAINER);
  });
  let response: ((request: StartupRequest) => void) | undefined;
  let concealedMutation: 'connect' | 'disconnect' | undefined;
  context.replyWith((request, result) => {
    response?.(request);
    if (
      concealedMutation !== undefined &&
      request.method === 'POST' &&
      request.path.endsWith(`/${concealedMutation}`)
    ) {
      concealedMutation = undefined;
      return { status: 500 };
    }
    return result;
  });
  return {
    ...context,
    observeResponse(callback: typeof response) {
      response = callback;
    },
    loseConnectResponse() {
      concealedMutation = 'connect';
    },
    loseDisconnectResponse() {
      concealedMutation = 'disconnect';
    },
  };
}

it('caller abort retains submitted attachment ownership through compensation before a same-user successor', async () => {
  const context = await fixture();
  const { owner, input, daemon, database } = context;
  const barrier = startupBarrier();
  context.holdResponse(({ method, path }) =>
    method === 'POST' && path === `/networks/${START_NETWORK}/connect` ? barrier.hold() : undefined,
  );
  const cancellation = new AbortController();
  const first = owner.startUserContainer({ ...input, signal: cancellation.signal });
  const firstResult = Promise.allSettled([first]);
  let nextResult: Promise<PromiseSettledResult<void>[]> | undefined;
  await barrier.reached;
  try {
    cancellation.abort();
    const successor = owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    nextResult = Promise.allSettled([successor]);

    const unrelated = await owner.startUserContainer({ ...input, userId: OTHER });

    expect(unrelated).toMatchObject({
      containerId: SECOND,
      upstreamHost: '172.30.0.18',
      upstreamPort: 3080,
    });
    expect(daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(PLATFORM);
    expect(
      daemon.requests.filter(({ path }) => path === `/containers/${START_CONTAINER}/stop?t=1`),
    ).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT * FROM audit_events WHERE target = ? AND event_type IN ('instance.started', 'instance.stopped')",
        )
        .all(START_USER),
    ).toEqual([]);
    barrier.release();
    expect(await firstResult).toEqual([expect.objectContaining({ status: 'rejected' })]);
    await successor;
    expect(await nextResult).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(daemon.networks.has(START_NETWORK)).toBe(false);
    expect(daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).toHaveProperty(
      `dsh-team-net-${OTHER}`,
    );
    expect(
      database.prepare('SELECT status FROM instances WHERE user_id = ?').get(START_USER),
    ).toEqual({ status: 'stopped' });
    expect(
      database
        .prepare("SELECT * FROM audit_events WHERE target = ? AND event_type = 'instance.started'")
        .all(START_USER),
    ).toEqual([]);
  } finally {
    barrier.release();
    await firstResult;
    await nextResult;
  }
});

it('lost connection responses are settled by independently agreeing Engine membership rather than request success', async () => {
  const context = await fixture();
  context.loseConnectResponse();

  const started = await context.owner.startUserContainer(context.input);

  expect(started).toMatchObject({ upstreamHost: '172.30.0.2', upstreamPort: 3080 });
  expect(context.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(PLATFORM);
  expect(context.daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).toHaveProperty(
    `dsh-team-net-${START_USER}`,
  );
});

it('disconnect cancellation settles both inspect views and empty-network removal before a successor commits stopped', async () => {
  const context = await fixture();
  const { owner, input, daemon, database } = context;
  await owner.startUserContainer(input);
  const barrier = startupBarrier();
  context.holdResponse(({ method, path }) =>
    method === 'POST' && path === `/networks/${START_NETWORK}/disconnect`
      ? barrier.hold()
      : undefined,
  );
  const cancellation = new AbortController();
  const first = owner.stopUserContainer({
    userId: START_USER,
    reason: 'admin',
    signal: cancellation.signal,
  });
  const firstResult = Promise.allSettled([first]);
  let successorResult: Promise<PromiseSettledResult<void>[]> | undefined;
  await barrier.reached;
  try {
    cancellation.abort();
    const successor = owner.stopUserContainer({ userId: START_USER, reason: 'admin' });
    successorResult = Promise.allSettled([successor]);
    expect(daemon.networks.has(START_NETWORK)).toBe(true);
    expect(daemon.networks.get(START_NETWORK)?.Containers).toEqual({});
    expect(
      database.prepare("SELECT * FROM audit_events WHERE event_type = 'instance.stopped'").all(),
    ).toEqual([]);
    barrier.release();

    expect(await firstResult).toEqual([expect.objectContaining({ status: 'rejected' })]);
    await successor;

    expect(await successorResult).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(daemon.networks.has(START_NETWORK)).toBe(false);
    expect(daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).not.toHaveProperty(
      `dsh-team-net-${START_USER}`,
    );
    expect(
      database
        .prepare("SELECT event_type FROM audit_events WHERE event_type = 'instance.stopped'")
        .all(),
    ).toEqual([{ event_type: 'instance.stopped' }]);
  } finally {
    barrier.release();
    await firstResult;
    await successorResult;
  }
});

it('an unconfirmed connect outcome preserves the started instance and foreign endpoint with truthful error evidence', async () => {
  const context = await fixture();
  context.observeResponse(({ method, path }) => {
    if (method !== 'POST' || path !== `/networks/${START_NETWORK}/connect`) return;
    const network = context.daemon.networks.get(START_NETWORK);
    if (network === undefined) throw new Error('Network unavailable');
    network.Containers['8'.repeat(64)] = { Name: 'foreign', IPv4Address: '172.30.0.4/28' };
  });

  await expectUnconfirmedStartup(context);
  expect(context.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty('8'.repeat(64));
  const expectedError: unknown = expect.stringContaining('compensation failed or unconfirmed');
  expect(context.database.prepare('SELECT status, last_error FROM instances').get()).toMatchObject({
    status: 'error',
    last_error: expectedError,
  });
  expect(
    context.database
      .prepare(
        "SELECT event_type FROM audit_events WHERE event_type IN ('instance.started', 'instance.ready', 'instance.stopped')",
      )
      .all(),
  ).toEqual([]);
  expect(context.daemon.requests.filter(({ path }) => path.includes('/disconnect'))).toEqual([]);
});

it('lost disconnect responses are accepted only after both membership views prove absence', async () => {
  const context = await fixture();
  await context.owner.startUserContainer(context.input);
  context.loseDisconnectResponse();

  await context.owner.stopUserContainer({ userId: START_USER, reason: 'admin' });

  expect(context.daemon.networks.has(START_NETWORK)).toBe(false);
  expect(context.daemon.containers.get(PLATFORM)?.NetworkSettings.Networks).not.toHaveProperty(
    `dsh-team-net-${START_USER}`,
  );
  expect(context.database.prepare('SELECT status FROM instances').get()).toEqual({
    status: 'stopped',
  });
});

it('an expired independent attach deadline settles an accepted mutation through fresh compensation', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let settlement = new AbortController();
  // Time is an external boundary: expire the real request signal without a ten-second wall-clock sleep.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((duration) =>
    duration === 10_000 ? settlement.signal : timeout(duration),
  );
  const context = await fixture();
  const barrier = startupBarrier();
  context.holdResponse(({ method, path }) =>
    method === 'POST' && path === `/networks/${START_NETWORK}/connect` ? barrier.hold() : undefined,
  );
  const first = context.owner.startUserContainer(context.input);
  const observed = Promise.allSettled([first]);
  await barrier.reached;
  try {
    const expired = settlement;
    settlement = new AbortController();
    expired.abort();

    await expect(first).rejects.toThrow('started container and owned network removed');

    expect(context.daemon.containers.has(START_CONTAINER)).toBe(false);
    expect(context.daemon.networks.has(START_NETWORK)).toBe(false);
    const expectedError: unknown = expect.stringContaining(
      'started container and owned network removed',
    );
    expect(
      context.database.prepare('SELECT status, last_error FROM instances').get(),
    ).toMatchObject({
      status: 'error',
      last_error: expectedError,
    });
    expect(
      context.database
        .prepare("SELECT * FROM audit_events WHERE event_type = 'instance.started'")
        .all(),
    ).toEqual([]);
  } finally {
    barrier.release();
    await observed;
  }
});

it('compensation cannot stop or overwrite a newer credential row that changed during attachment', async () => {
  const context = await fixture();
  context.observeResponse(({ method, path }) => {
    if (method === 'POST' && path === `/networks/${START_NETWORK}/connect`)
      context.database
        .prepare("UPDATE instances SET dsh_cookie = 'newer-private-credential'")
        .run();
  });

  await expectUnconfirmedStartup(context);
  expect(context.daemon.networks.get(START_NETWORK)?.Containers).toHaveProperty(PLATFORM);
  expect(context.database.prepare('SELECT status, dsh_cookie FROM instances').get()).toEqual({
    status: 'starting',
    dsh_cookie: 'newer-private-credential',
  });
  expect(
    context.daemon.requests.filter(
      ({ path }) => path.includes('/stop?') || path.includes('/disconnect'),
    ),
  ).toEqual([]);
  expect(
    context.database
      .prepare(
        "SELECT * FROM audit_events WHERE event_type IN ('instance.started', 'instance.start-failed')",
      )
      .all(),
  ).toEqual([]);
});

it('a newly attached extra instance network is rejected before startup publication and preserved by compensation', async () => {
  const context = await fixture();
  context.observeResponse(({ method, path }) => {
    if (method !== 'POST' || path !== `/networks/${START_NETWORK}/connect`) return;
    const container = context.daemon.containers.get(START_CONTAINER);
    if (container === undefined) throw new Error('Instance unavailable');
    container.NetworkSettings.Networks = {
      ...container.NetworkSettings.Networks,
      foreign: {
        NetworkID: '8'.repeat(64),
        EndpointID: '9'.repeat(64),
        IPAddress: '192.0.2.2',
      },
    };
  });

  await expectUnconfirmedStartup(context);
  expect(context.daemon.containers.get(START_CONTAINER)?.NetworkSettings.Networks).toHaveProperty(
    'foreign',
  );
  expect(context.daemon.networks.has(START_NETWORK)).toBe(true);
  expect(context.database.prepare('SELECT status FROM instances').get()).toEqual({
    status: 'error',
  });
  expect(
    context.daemon.requests.filter(
      ({ path }) => path.includes('/stop?') || path.includes('/disconnect'),
    ),
  ).toEqual([]);
});

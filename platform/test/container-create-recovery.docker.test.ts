import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import type { DockerClient, StartUserContainerInput } from '../src/orchestrator/index.ts';
import { START_MODEL } from './container-start-fixture.ts';
import {
  createStandInPlatform,
  inspect,
  inspectNetwork,
  normalizeInspectMounts,
  platformHttpStatus,
  record,
  registerStartupUsers,
  runNetworkAcceptance,
  startupClient,
} from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

type FailureWindow = 'response' | 'inspection';
type UpstreamMode = 'network' | 'published-loopback';
const AUTHORITY = 'creation-recovery.example:8443';
const MARKERS = {
  effectiveUid: 1001,
  home: 'durable home 中文\n\u0000exact bytes\n',
  work: 'durable work 中文\n\u0000exact bytes\n',
};

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Missing acceptance identity');
  return value;
}

function attempt(database: DatabaseHandle, userId: string) {
  return database.prepare('SELECT * FROM creation_attempts WHERE user_id = ?').get(userId);
}

function events(database: DatabaseHandle, userId: string) {
  return database
    .prepare('SELECT event_type FROM audit_events WHERE target = ? ORDER BY id')
    .all(userId);
}

function preservationObservation(before: Record<string, unknown>, after: Record<string, unknown>) {
  const fields = [
    'Id',
    'Name',
    'Image',
    'State',
    'Config',
    'HostConfig',
    'Mounts',
    'NetworkSettings',
    'GraphDriver',
    'ExecIDs',
    'RestartCount',
    'Created',
  ] as const;
  return {
    equal: isDeepStrictEqual(before, after),
    equalWithMountOrderNormalized: isDeepStrictEqual(
      normalizeInspectMounts(before),
      normalizeInspectMounts(after),
    ),
    changed: Object.fromEntries(
      fields.map((field) => [field, !isDeepStrictEqual(before[field], after[field])]),
    ),
  };
}

function volumes(lifecycle: UserImageLifecycle, userId: string): unknown {
  const result = lifecycle.command(
    ['volume', 'inspect', `dsh-team-home-${userId}`, `dsh-team-work-${userId}`],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent volume observation failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error('Missing retained volume pair');
  for (const [index, kind] of ['home', 'work'].entries()) {
    expect(record(rows[index]).Name).toBe(`dsh-team-${kind}-${userId}`);
    expect(record(rows[index]).Labels).toMatchObject({ 'dsh-team.user': userId });
  }
  return rows;
}

function markers(
  lifecycle: UserImageLifecycle,
  userId: string,
  operation: 'seed' | 'read',
  runningId?: string,
): void {
  const script = `import json, os
from pathlib import Path
home = Path('/data/home/creation-recovery-sentinel')
work = Path('/data/work/creation-recovery-sentinel')
${
  operation === 'seed'
    ? `home.write_bytes(${JSON.stringify(MARKERS.home)}.encode('utf-8'))
work.write_bytes(${JSON.stringify(MARKERS.work)}.encode('utf-8'))`
    : ''
}
print(json.dumps({'effectiveUid': os.geteuid(), 'home': home.read_bytes().decode('utf-8'), 'work': work.read_bytes().decode('utf-8')}, ensure_ascii=False))`;
  let args: string[];
  if (runningId !== undefined) {
    // No user override: the actual employee process owns and reads the marker bytes.
    args = ['exec', runningId, 'python3', '-c', script];
  } else {
    const name = `dsh-team-test-recovery-${operation}-${userId}-${lifecycle.runId}`;
    lifecycle.registerResource('container', name, { 'dsh-team.test-run': lifecycle.runId });
    args = [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      '--mount',
      `type=volume,source=dsh-team-home-${userId},target=/data/home${operation === 'read' ? ',readonly' : ''}`,
      '--mount',
      `type=volume,source=dsh-team-work-${userId},target=/data/work${operation === 'read' ? ',readonly' : ''}`,
      lifecycle.imageId,
      'python3',
      '-c',
      script,
    ];
  }
  const result = lifecycle.command(args, 30_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent uid1001 marker observation failed');
  expect(JSON.parse(result.stdout)).toEqual(MARKERS);
}

function assertMounts(lifecycle: UserImageLifecycle, userId: string, container: unknown): void {
  const mounts = record(container).Mounts;
  if (!Array.isArray(mounts)) throw new Error('Missing independent mount inventory');
  expect(mounts.map((value: unknown) => record(value).Destination).sort()).toEqual([
    '/data/home',
    '/data/work',
    '/managed/patch.yml',
  ]);
  for (const kind of ['home', 'work'])
    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Type: 'volume',
          Name: `dsh-team-${kind}-${userId}`,
          Destination: `/data/${kind}`,
          RW: true,
        }),
      ]),
    );
  expect(mounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: 'bind',
        Source: join(lifecycle.overlayDirectory, `${userId}.patch.yml`),
        Destination: '/managed/patch.yml',
        RW: false,
      }),
    ]),
  );
}

function assertAbsent(lifecycle: UserImageLifecycle, kind: 'container' | 'network', id: string) {
  expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(true);
}

async function recoveryScenario(
  lifecycle: UserImageLifecycle,
  mode: UpstreamMode,
  window: FailureWindow,
  wrongNonce = false,
): Promise<string> {
  const identity = lifecycle.runId.replaceAll('-', '');
  const userId = identity.slice(0, 12);
  const siblingId = identity.slice(-12);
  if (userId === siblingId) throw new Error('Distinct acceptance accounts required');
  const name = `dsh-team-u-${userId}`;
  const platformName = `dsh-team-test-recovery-platform-${lifecycle.runId}`;
  const platformId =
    mode === 'network' ? text(createStandInPlatform(lifecycle, platformName).Id) : undefined;
  const config = { upstreamMode: mode, platformContainerName: platformName };
  const databasePath = join(dirname(lifecycle.overlayDirectory), 'creation-recovery.db');
  let database = openDatabase(databasePath);
  const transport = startupClient(lifecycle);
  let capturedId: string | undefined;
  let submittedNonce: string | undefined;
  let injected = false;
  let interceptedCreate = false;
  const client: DockerClient = {
    logs: (path, signal) => transport.client.logs(path, signal),
    async json(method, path, body, signal, maxBytes) {
      if (method === 'POST' && path === `/containers/create?name=${name}`) {
        interceptedCreate = true;
        const request = record(body);
        const labels = record(request.Labels);
        submittedNonce = text(labels['dsh-team.creation-attempt']);
        // This is before the real POST, not a receipt reconstructed from an Engine response.
        const persisted = record(attempt(database, userId));
        expect(persisted.attempt_id).toBe(submittedNonce);
        expect(persisted.container_id).toBe(null);
        const outgoing = wrongNonce
          ? { ...request, Labels: { ...labels, 'dsh-team.creation-attempt': 'foreign-attempt' } }
          : body;
        const result = await transport.client.json(method, path, outgoing, signal, maxBytes);
        capturedId = text(record(result).Id);
        if (window === 'response') {
          injected = true;
          // Engine applied the mutation; only the test observer learns this identity.
          throw new Error('Acceptance discards applied create response');
        }
        return result;
      }
      if (
        method === 'GET' &&
        capturedId !== undefined &&
        path === `/containers/${capturedId}/json`
      ) {
        expect(record(attempt(database, userId)).container_id).toBe(capturedId);
        await transport.client.json(method, path, body, signal, maxBytes);
        injected = true;
        throw new Error('Acceptance discards post-create inspection');
      }
      return transport.client.json(method, path, body, signal, maxBytes);
    },
  };
  let owner = createOrchestrator({ client, database, config });
  const input: StartUserContainerInput = {
    userId,
    config: {
      userImage: lifecycle.imageId,
      seccompProfilePath: lifecycle.seccomp,
      managedConfigDir: lifecycle.overlayDirectory,
      authority: AUTHORITY,
      subnetPool: '172.30.0.0/16',
    },
    modelSettings: START_MODEL,
    modelKey: 'docker-acceptance-only-not-a-model-credential',
  };
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userId, siblingId], 'creation-recovery.example');
    const sibling = await owner.startUserContainer({ ...input, userId: siblingId });
    if (sibling.outcome !== 'starting') throw new Error('Healthy sibling did not start');
    await owner.waitForUserContainerReady({ userId: siblingId, authority: AUTHORITY });
    markers(lifecycle, siblingId, 'seed', sibling.containerId);
    const siblingBefore = normalizeInspectMounts(inspect(lifecycle, sibling.containerId));
    const siblingNetwork = inspectNetwork(lifecycle, `dsh-team-net-${siblingId}`);
    const siblingVolumes = volumes(lifecycle, siblingId);
    const siblingRow = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingId);
    const siblingAudits = database
      .prepare('SELECT * FROM audit_events WHERE target = ? ORDER BY id')
      .all(siblingId);
    const platformNetworks =
      platformId === undefined
        ? undefined
        : record(record(inspect(lifecycle, platformId).NetworkSettings).Networks);
    const assertSibling = () => {
      const current = normalizeInspectMounts(inspect(lifecycle, sibling.containerId));
      expect(current.Id).toBe(sibling.containerId);
      expect(record(current.State).Running).toBe(true);
      expect(record(current.State).StartedAt).toBe(record(siblingBefore.State).StartedAt);
      // Compare credential-bearing structures only as booleans: never print cookies or Env.
      for (const field of ['Config', 'HostConfig', 'Mounts', 'NetworkSettings'])
        expect(isDeepStrictEqual(current[field], siblingBefore[field])).toBe(true);
      expect(
        isDeepStrictEqual(
          database.prepare('SELECT * FROM instances WHERE user_id = ?').get(siblingId),
          siblingRow,
        ),
      ).toBe(true);
      expect(
        database.prepare('SELECT * FROM audit_events WHERE target = ? ORDER BY id').all(siblingId),
      ).toEqual(siblingAudits);
      expect(inspectNetwork(lifecycle, text(siblingNetwork.Id))).toEqual(siblingNetwork);
      expect(volumes(lifecycle, siblingId)).toEqual(siblingVolumes);
      markers(lifecycle, siblingId, 'read', sibling.containerId);
      if (platformId !== undefined && platformNetworks !== undefined) {
        const currentNetworks = record(
          record(inspect(lifecycle, platformId).NetworkSettings).Networks,
        );
        for (const [network, endpoint] of Object.entries(platformNetworks))
          expect(currentNetworks[network]).toEqual(endpoint);
        expect(platformHttpStatus(lifecycle, platformId, sibling.upstreamHost, AUTHORITY)).toBe(
          401,
        );
      }
    };

    await expect(owner.startUserContainer(input)).rejects.toThrow();

    expect(interceptedCreate).toBe(true);
    expect(injected).toBe(true);
    // The CLI establishes the observed identity independently of the discarded client reply.
    const oldId = text(inspect(lifecycle, name).Id);
    expect(oldId).toBe(text(capturedId));
    const phantom = inspect(lifecycle, oldId);
    const preservation = wrongNonce
      ? { immediate: preservationObservation(phantom, inspect(lifecycle, oldId)) }
      : undefined;
    expect(phantom.Id).toBe(oldId);
    expect(phantom.Name).toBe(`/${name}`);
    expect(phantom.Image).toBe(lifecycle.imageId);
    expect(record(phantom.State)).toMatchObject({
      Status: 'created',
      Running: false,
      StartedAt: '0001-01-01T00:00:00Z',
    });
    expect(record(record(phantom.Config).Labels)['dsh-team.user']).toBe(userId);
    expect(record(record(phantom.Config).Labels)['dsh-team.creation-attempt']).toBe(
      wrongNonce ? 'foreign-attempt' : submittedNonce,
    );
    assertMounts(lifecycle, userId, phantom);
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
    ).toBeUndefined();
    expect(events(database, userId)).toEqual([]);
    const receipt = record(attempt(database, userId));
    expect(receipt).toMatchObject({
      user_id: userId,
      attempt_id: submittedNonce,
      account_created_at: 1,
      image_id: lifecycle.imageId,
      image_tag: lifecycle.imageId,
      overlay_path: join(lifecycle.overlayDirectory, `${userId}.patch.yml`),
      upstream_mode: mode,
      container_id: window === 'response' ? null : oldId,
    });
    const oldNetworkId = text(receipt.network_id);
    const oldNetwork = inspectNetwork(lifecycle, oldNetworkId);
    expect(oldNetwork.Id).toBe(oldNetworkId);
    expect(oldNetwork.Name).toBe(`dsh-team-net-${userId}`);
    expect(record(oldNetwork.Labels)['dsh-team.user']).toBe(userId);
    expect(record(oldNetwork.IPAM).Config).toEqual([
      expect.objectContaining({ Subnet: receipt.network_subnet }),
    ]);
    expect(record(phantom.HostConfig).NetworkMode).toBe(oldNetworkId);
    expect(
      transport.requests.some(
        ({ method, path }) => method === 'POST' && path === `/containers/${oldId}/start`,
      ),
    ).toBe(false);
    expect(
      transport.requests.filter(
        ({ method, path }) =>
          (method === 'DELETE' &&
            (path.startsWith(`/containers/${oldId}`) ||
              path.startsWith(`/containers/${name}`) ||
              path.startsWith('/networks/') ||
              path.startsWith('/volumes/'))) ||
          (method === 'POST' && path.startsWith(`/containers/${oldId}/stop`)),
      ),
    ).toEqual([]);
    const originalVolumes = volumes(lifecycle, userId);
    markers(lifecycle, userId, 'seed');
    assertSibling();

    // No fixture deletion or row repair: discard the entire owner and reopen the same file.
    await owner.drain();
    database.close();
    database = openDatabase(databasePath);
    applyMigrations(database);
    expect(attempt(database, userId)).toEqual(receipt);
    const recoveredTransport = startupClient(lifecycle);
    owner = createOrchestrator({ client: recoveredTransport.client, database, config });
    if (wrongNonce) {
      const beforeRecovery = preservationObservation(phantom, inspect(lifecycle, oldId));
      await expect(owner.reconcile()).rejects.toThrow();
      const afterReconcile = preservationObservation(phantom, inspect(lifecycle, oldId));
      await expect(
        owner.stopUserContainer({ userId, reason: 'admin', allowMissingInstance: true }),
      ).rejects.toThrow();
      const afterStop = preservationObservation(phantom, inspect(lifecycle, oldId));
      await expect(owner.startUserContainer(input)).rejects.toThrow();
      expect(attempt(database, userId)).toEqual(receipt);
      expect(
        database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
      ).toBeUndefined();
      expect(events(database, userId)).toEqual([]);
      const preserved = inspect(lifecycle, oldId);
      const preservationFacts = {
        ...preservation,
        beforeRecovery,
        afterReconcile,
        afterStop,
        afterStart: preservationObservation(phantom, preserved),
        mutationObserved: recoveredTransport.requests.some(({ method }) => method !== 'GET'),
      };
      process.stdout.write(
        `Creation preservation diagnostic: ${JSON.stringify(preservationFacts)}\n`,
      );
      expect(isDeepStrictEqual(preserved, phantom), JSON.stringify(preservationFacts)).toBe(true);
      expect(inspect(lifecycle, name).Id).toBe(oldId);
      expect(inspectNetwork(lifecycle, oldNetworkId)).toEqual(oldNetwork);
      expect(recoveredTransport.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
      markers(lifecycle, userId, 'read');
      expect(volumes(lifecycle, userId)).toEqual(originalVolumes);
      assertSibling();
      return JSON.stringify({ mode, window, outcome: 'foreign-nonce-preserved' });
    }

    await owner.reconcile();

    assertAbsent(lifecycle, 'container', oldId);
    assertAbsent(lifecycle, 'container', name);
    assertAbsent(lifecycle, 'network', oldNetworkId);
    assertAbsent(lifecycle, 'network', `dsh-team-net-${userId}`);
    expect(attempt(database, userId)).toBeUndefined();
    const failed = record(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
    );
    expect(failed.status).toBe('error');
    for (const field of [
      'container_id',
      'image_id',
      'image_tag',
      'upstream_host',
      'upstream_port',
      'dsh_cookie',
    ])
      expect(failed[field] === null).toBe(true);
    expect(typeof failed.last_error === 'string' && failed.last_error.length > 0).toBe(true);
    expect(events(database, userId)).toEqual([{ event_type: 'instance.start-failed' }]);
    expect(recoveredTransport.requests.filter(({ method }) => method === 'DELETE')).toEqual(
      expect.arrayContaining([
        { method: 'DELETE', path: `/containers/${oldId}` },
        { method: 'DELETE', path: `/networks/${oldNetworkId}` },
      ]),
    );
    expect(recoveredTransport.requests.some(({ method }) => method === 'POST')).toBe(false);
    expect(
      recoveredTransport.requests.some(
        ({ method, path }) => method === 'DELETE' && path.startsWith('/volumes/'),
      ),
    ).toBe(false);
    markers(lifecycle, userId, 'read');
    expect(volumes(lifecycle, userId)).toEqual(originalVolumes);
    assertSibling();
    await owner.reconcile();
    expect(events(database, userId)).toEqual([{ event_type: 'instance.start-failed' }]);
    expect(
      isDeepStrictEqual(
        database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId),
        failed,
      ),
    ).toBe(true);
    expect(attempt(database, userId)).toBeUndefined();

    const retried = await owner.startUserContainer(input);
    if (retried.outcome !== 'starting') throw new Error('Explicit production retry did not start');
    await owner.waitForUserContainerReady({ userId, authority: AUTHORITY });
    expect(retried.containerId).not.toBe(oldId);
    const replacement = inspect(lifecycle, retried.containerId);
    expect(replacement.Id).toBe(retried.containerId);
    expect(replacement.Image).toBe(lifecycle.imageId);
    expect(record(replacement.State).Running).toBe(true);
    assertMounts(lifecycle, userId, replacement);
    expect(attempt(database, userId)).toBeUndefined();
    const ready = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId));
    expect(ready.status).toBe('running');
    expect(ready.container_id).toBe(retried.containerId);
    expect(events(database, userId)).toEqual([
      { event_type: 'instance.start-failed' },
      { event_type: 'instance.created' },
      { event_type: 'instance.started' },
      { event_type: 'instance.ready' },
    ]);
    markers(lifecycle, userId, 'read', retried.containerId);
    expect(volumes(lifecycle, userId)).toEqual(originalVolumes);
    if (platformId !== undefined) {
      expect(platformHttpStatus(lifecycle, platformId, retried.upstreamHost, AUTHORITY)).toBe(401);
      const bindings = record(replacement.HostConfig).PortBindings;
      expect(bindings === null || Object.keys(record(bindings)).length === 0).toBe(true);
    } else {
      expect(retried.upstreamHost).toBe('127.0.0.1');
      expect(record(record(replacement.NetworkSettings).Ports)['3080/tcp']).toEqual([
        { HostIp: '127.0.0.1', HostPort: String(retried.upstreamPort) },
      ]);
    }
    assertSibling();
    await owner.stopUserContainer({ userId, reason: 'admin' });
    await owner.stopUserContainer({ userId: siblingId, reason: 'admin' });
    return JSON.stringify({ mode, window, outcome: 'recovered-and-retried' });
  } finally {
    try {
      await owner.drain();
    } finally {
      database.close();
    }
  }
}

it.each<{ mode: UpstreamMode; window: FailureWindow }>([
  { mode: 'network', window: 'response' },
  { mode: 'published-loopback', window: 'inspection' },
])(
  'recovers real Engine $window loss after database reopen in $mode mode without losing bytes or disturbing a sibling',
  async ({ mode, window }) => {
    await runNetworkAcceptance(
      (lifecycle) => recoveryScenario(lifecycle, mode, window),
      'durable creation recovery',
      (summary) => {
        expect(JSON.parse(summary)).toEqual({ mode, window, outcome: 'recovered-and-retried' });
      },
    );
  },
);

it('quarantines a real same-name wrong-nonce container after restart without granting cleanup or retry authority', async () => {
  await runNetworkAcceptance(
    (lifecycle) => recoveryScenario(lifecycle, 'published-loopback', 'response', true),
    'durable creation nonce fence',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        mode: 'published-loopback',
        window: 'response',
        outcome: 'foreign-nonce-preserved',
      });
    },
  );
});

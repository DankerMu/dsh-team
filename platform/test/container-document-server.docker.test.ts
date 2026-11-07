import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import type { Orchestrator } from '../src/orchestrator/index.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  createStandInPlatform,
  dockerStartInput,
  expectPlatformAtLayout,
  inspect,
  record,
  registerStartupUsers,
  runNetworkAcceptance,
  startDockerInstance,
  startupClient,
} from './container-start-docker-fixture.ts';
import {
  bridgeEndpoints,
  containerNetworks,
  dockerStep,
  documentServerConfig,
  expectDocumentServerAtLayout,
  gatewayStatus,
  overlayKeys,
  userNetworkId,
} from './container-document-server-docker-fixture.ts';
import { NULL_RECORD, documentServerRecord } from './container-document-server-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const AUTHORITY = 'document-server.example:8443';

interface Context {
  readonly lifecycle: UserImageLifecycle;
  readonly database: DatabaseHandle;
  readonly owner: Orchestrator;
  readonly fresh: () => Orchestrator;
  readonly platformId: string;
  readonly users: readonly string[];
}

/** An owned platform stand-in, owned users and an owner over a scenario-owned database. */
async function withContext(
  lifecycle: UserImageLifecycle,
  name: string,
  scenario: (context: Context) => Promise<Record<string, unknown>>,
): Promise<string> {
  const base = lifecycle.runId.replaceAll('-', '').slice(0, 10);
  const users = ['aa', 'ab', 'ac'].map((suffix) => `${base}${suffix}`);
  const platformName = `dsh-team-test-ds-platform-${lifecycle.runId}`;
  const platformId = String(createStandInPlatform(lifecycle, platformName).Id);
  const config = { upstreamMode: 'network' as const, platformContainerName: platformName };
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), `${name}.db`));
  const { client } = startupClient(lifecycle);
  const fresh = () => createOrchestrator({ client, database, config });
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, users, 'document-server.example');
    const summary = await scenario({
      lifecycle,
      database,
      owner: fresh(),
      fresh,
      platformId,
      users,
    });
    return JSON.stringify(summary);
  } finally {
    database.close();
  }
}

function user(context: Context, index: number): string {
  const selected = context.users[index];
  if (selected === undefined) throw new Error('Missing scenario user');
  return selected;
}

function expectRetired(lifecycle: UserImageLifecycle, networkId: string): void {
  expect(
    isAbsentResource(
      lifecycle.command(['network', 'inspect', networkId], 15_000),
      'network',
      networkId,
    ),
  ).toBe(true);
}

function useExternal(database: DatabaseHandle, external: boolean): void {
  writeSettings(database, {
    documentServerUrl: external ? 'http://office.example' : '',
    documentServerJwtSecret: external ? 'docker-acceptance-external-jwt' : '',
  });
}

/** Attach per start, disconnect per stop by record, and follow a recreated stand-in only on new starts. */
async function attachAndRetire(context: Context): Promise<Record<string, unknown>> {
  const { lifecycle, database, owner, platformId } = context;
  const [a, b] = [user(context, 0), user(context, 1)];
  const name = `dsh-team-test-ds-${lifecycle.runId}`;
  const configured = documentServerConfig(name);
  const standIn = String(createStandInPlatform(lifecycle, name).Id);
  const primary = structuredClone(
    record(record(inspect(lifecycle, standIn).NetworkSettings).Networks),
  );
  const startedA = await startDockerInstance(owner, lifecycle, a, AUTHORITY, configured);
  const startedB = await startDockerInstance(owner, lifecycle, b, AUTHORITY, configured);
  const networkA = userNetworkId(lifecycle, startedA.containerId, a);
  const networkB = userNetworkId(lifecycle, startedB.containerId, b);
  for (const [userId, started, network] of [
    [a, startedA, networkA],
    [b, startedB, networkB],
  ] as const) {
    expect(bridgeEndpoints(lifecycle, network)).toEqual(
      [started.containerId, platformId, standIn].sort(),
    );
    expectDocumentServerAtLayout(lifecycle, standIn, userId, network);
    expectPlatformAtLayout(lifecycle, platformId, userId, network);
    expect(documentServerRecord(database, userId)).toEqual({
      document_server_mode: 'bundled',
      document_server_container_id: standIn,
      document_server_reason: null,
    });
  }
  const kept = expectDocumentServerAtLayout(lifecycle, standIn, b, networkB);

  await owner.stopUserContainer({ userId: a, reason: 'admin' });

  expectRetired(lifecycle, networkA);
  expect(containerNetworks(lifecycle, standIn)).toEqual(['bridge', `dsh-team-net-${b}`]);
  expect(record(record(inspect(lifecycle, standIn).NetworkSettings).Networks).bridge).toEqual(
    primary.bridge,
  );
  expect(expectDocumentServerAtLayout(lifecycle, standIn, b, networkB)).toEqual(kept);
  expect(gatewayStatus(lifecycle, database, platformId, b, AUTHORITY)).toBe(200);
  expect(documentServerRecord(database, a)).toEqual(NULL_RECORD);
  // Switched to external after a bundled start: retirement still goes by the record.
  useExternal(database, true);
  await owner.stopUserContainer({ userId: b, reason: 'admin' });
  expectRetired(lifecycle, networkB);
  expect(containerNetworks(lifecycle, standIn)).toEqual(['bridge']);
  expect(documentServerRecord(database, b)).toEqual(NULL_RECORD);
  useExternal(database, false);
  // Recreation: a running instance is never re-attached; only the next start follows the new ID.
  const restartedA = await startDockerInstance(owner, lifecycle, a, AUTHORITY, configured);
  const renewedA = userNetworkId(lifecycle, restartedA.containerId, a);
  dockerStep(lifecycle, ['container', 'rm', '--force', standIn], 'Stand-in removal failed');
  const recreated = String(createStandInPlatform(lifecycle, name).Id);
  expect(recreated).not.toBe(standIn);
  const restartedB = await startDockerInstance(owner, lifecycle, b, AUTHORITY, configured);
  const renewedB = userNetworkId(lifecycle, restartedB.containerId, b);
  expect(documentServerRecord(database, b)).toMatchObject({
    document_server_container_id: recreated,
  });
  expectDocumentServerAtLayout(lifecycle, recreated, b, renewedB);
  expect(bridgeEndpoints(lifecycle, renewedA)).toEqual([restartedA.containerId, platformId].sort());
  await owner.stopUserContainer({ userId: a, reason: 'admin' });
  expectRetired(lifecycle, renewedA);
  // A vanished employee container: reconciliation reclaims the bridge and its recorded endpoint.
  dockerStep(
    lifecycle,
    ['container', 'rm', '--force', restartedB.containerId],
    'Employee container removal failed',
  );
  await context.fresh().reconcile();
  expectRetired(lifecycle, renewedB);
  expect(containerNetworks(lifecycle, recreated)).toEqual(['bridge']);
  expect(database.prepare('SELECT status FROM instances WHERE user_id = ?').get(b)).toEqual({
    status: 'stopped',
  });
  expect(documentServerRecord(database, b)).toEqual(NULL_RECORD);
  return {
    instances: 2,
    layoutAddress: kept.address !== '',
    recreatedFollowed: true,
    reclaimed: true,
  };
}

/** Unavailable stand-ins degrade only Office; a definitively refused connect fails the start. */
async function unavailable(context: Context): Promise<Record<string, unknown>> {
  const { lifecycle, database, owner, platformId } = context;
  const [absent, stopped, refused] = [user(context, 0), user(context, 1), user(context, 2)];
  const stoppedName = `dsh-team-test-ds-stopped-${lifecycle.runId}`;
  createStandInPlatform(lifecycle, stoppedName);
  dockerStep(lifecycle, ['stop', '-t', '1', stoppedName], 'Stand-in stop failed');
  for (const [userId, name, reason] of [
    [absent, `dsh-team-test-ds-absent-${lifecycle.runId}`, 'absent'],
    [stopped, stoppedName, 'identity-mismatch'],
  ] as const) {
    const started = await startDockerInstance(
      owner,
      lifecycle,
      userId,
      AUTHORITY,
      documentServerConfig(name),
    );
    const network = userNetworkId(lifecycle, started.containerId, userId);
    expect(bridgeEndpoints(lifecycle, network)).toEqual([started.containerId, platformId].sort());
    expect(gatewayStatus(lifecycle, database, platformId, userId, AUTHORITY)).toBe(200);
    expect(
      overlayKeys(lifecycle, userId).filter((key) => /onlyoffice|documentserver/i.test(key)),
    ).toEqual([]);
    expect(documentServerRecord(database, userId)).toEqual({
      document_server_mode: 'bundled',
      document_server_container_id: null,
      document_server_reason: reason,
    });
  }
  // Docker refuses to connect a container that shares another container's network namespace.
  const host = String(
    createStandInPlatform(lifecycle, `dsh-team-test-ds-host-${lifecycle.runId}`).Id,
  );
  const sharedName = `dsh-team-test-ds-shared-${lifecycle.runId}`;
  const shared = String(createStandInPlatform(lifecycle, sharedName, `container:${host}`).Id);
  await expect(
    owner.startUserContainer(
      dockerStartInput(lifecycle, refused, AUTHORITY, documentServerConfig(sharedName)),
    ),
  ).rejects.toThrow('Container startup failed during document server attachment');
  expect(database.prepare('SELECT status FROM instances WHERE user_id = ?').get(refused)).toEqual({
    status: 'error',
  });
  for (const [kind, id] of [
    ['container', `dsh-team-u-${refused}`],
    ['network', `dsh-team-net-${refused}`],
  ] as const)
    expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(true);
  for (const id of [shared, host, platformId])
    expect(containerNetworks(lifecycle, id)).not.toContain(`dsh-team-net-${refused}`);
  return { ready: 2, officeKeys: 0, refusedConnectFailed: true };
}

/** A stopped stand-in keeps a configured attachment: retirement removes it, reconciliation keeps the instance. */
async function stoppedAttachment(context: Context): Promise<Record<string, unknown>> {
  const { lifecycle, database, owner, platformId } = context;
  const [a, b] = [user(context, 0), user(context, 1)];
  const name = `dsh-team-test-ds-${lifecycle.runId}`;
  const configured = documentServerConfig(name);
  const standIn = String(createStandInPlatform(lifecycle, name).Id);
  const startedA = await startDockerInstance(owner, lifecycle, a, AUTHORITY, configured);
  const networkA = userNetworkId(lifecycle, startedA.containerId, a);
  dockerStep(lifecycle, ['stop', '-t', '1', standIn], 'Stand-in stop failed');
  expect(bridgeEndpoints(lifecycle, networkA)).toEqual([startedA.containerId, platformId].sort());

  await owner.stopUserContainer({ userId: a, reason: 'admin' });

  expectRetired(lifecycle, networkA);
  dockerStep(lifecycle, ['start', standIn], 'Stand-in restart failed after retirement');
  expect(containerNetworks(lifecycle, standIn)).toEqual(['bridge']);
  const startedB = await startDockerInstance(owner, lifecycle, b, AUTHORITY, configured);
  const networkB = userNetworkId(lifecycle, startedB.containerId, b);
  dockerStep(lifecycle, ['stop', '-t', '1', standIn], 'Stand-in stop failed');
  const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
  const row = database.prepare('SELECT * FROM instances WHERE user_id = ?').get(b);
  await context.fresh().reconcile();
  expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
  expect(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(b)).toEqual(row);
  expect(gatewayStatus(lifecycle, database, platformId, b, AUTHORITY)).toBe(200);
  // Docker re-attaches the restarted stand-in from its retained configuration, still at base+4.
  dockerStep(lifecycle, ['start', standIn], 'Stand-in restart failed');
  expectDocumentServerAtLayout(lifecycle, standIn, b, networkB);
  await owner.stopUserContainer({ userId: b, reason: 'admin' });
  expectRetired(lifecycle, networkB);
  expect(containerNetworks(lifecycle, standIn)).toEqual(['bridge']);
  return { stoppedRetired: true, restartable: true, reconciledRunning: true };
}

it('attaches the bundled stand-in at base+4, retires by record and follows a recreated stand-in only on new starts', async () => {
  await runNetworkAcceptance(
    (lifecycle) => withContext(lifecycle, 'document-server-attach', attachAndRetire),
    'Document Server attachment',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        instances: 2,
        layoutAddress: true,
        recreatedFollowed: true,
        reclaimed: true,
      });
    },
  );
});

it('absent and stopped stand-ins leave instances ready without Office while a refused connect fails the start', async () => {
  await runNetworkAcceptance(
    (lifecycle) => withContext(lifecycle, 'document-server-unavailable', unavailable),
    'Document Server unavailability',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({ ready: 2, officeKeys: 0, refusedConnectFailed: true });
    },
  );
});

it('a stopped stand-in attachment is removed by retirement and accepted by reconciliation', async () => {
  await runNetworkAcceptance(
    (lifecycle) => withContext(lifecycle, 'document-server-stopped', stoppedAttachment),
    'Document Server stopped attachment',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        stoppedRetired: true,
        restartable: true,
        reconciledRunning: true,
      });
    },
  );
});

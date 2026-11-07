import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createOrchestrator, instanceAddressLayout } from '../src/orchestrator/index.ts';
import { documentServerRecord } from './container-document-server-fixture.ts';
import { startupEvidence } from './container-start-fixture.ts';
import {
  createStandInPlatform,
  dockerStartInput,
  expectPlatformAtLayout,
  inspect,
  inspectNetwork,
  platformHttpStatus,
  record,
  registerStartupUsers,
  startDockerInstance,
  startupClient,
} from './container-start-docker-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** Acceptance-only configuration; the orchestrator never reads the JWT. */
export function documentServerConfig(containerName: string) {
  return { containerName, jwtSecret: 'docker-acceptance-only-not-a-jwt-secret' };
}

export function dockerStep(lifecycle: UserImageLifecycle, args: string[], failure: string): void {
  const result = lifecycle.command(args, 30_000);
  if (result.status !== 0 || result.error !== undefined) throw new Error(failure);
}

export function userNetworkId(lifecycle: UserImageLifecycle, id: string, user: string): string {
  const networks = record(record(inspect(lifecycle, id).NetworkSettings).Networks);
  return String(record(networks[`dsh-team-net-${user}`]).NetworkID);
}

export function bridgeEndpoints(lifecycle: UserImageLifecycle, networkId: string): string[] {
  return Object.keys(record(inspectNetwork(lifecycle, networkId).Containers)).sort();
}

export function containerNetworks(lifecycle: UserImageLifecycle, id: string): string[] {
  return Object.keys(record(record(inspect(lifecycle, id).NetworkSettings).Networks)).sort();
}

/** One base+4 endpoint, identical in the bridge (by ID and by name) and the stand-in's own view. */
export function expectDocumentServerAtLayout(
  lifecycle: UserImageLifecycle,
  documentServerId: string,
  user: string,
  networkId: string,
): { endpointId: string; address: string } {
  const bridge = inspectNetwork(lifecycle, networkId);
  expect(inspectNetwork(lifecycle, `dsh-team-net-${user}`).Containers).toEqual(bridge.Containers);
  const configs = record(bridge.IPAM).Config;
  if (!Array.isArray(configs) || configs.length !== 1)
    throw new Error('Unexpected instance network IPAM');
  const address = instanceAddressLayout(String(record(configs[0]).Subnet)).documentServer;
  const endpoint = record(record(bridge.Containers)[documentServerId]);
  expect(endpoint.IPv4Address).toBe(`${address}/28`);
  const networks = record(record(inspect(lifecycle, documentServerId).NetworkSettings).Networks);
  const attachment = record(networks[`dsh-team-net-${user}`]);
  expect(attachment.NetworkID).toBe(networkId);
  expect(attachment.EndpointID).toBe(endpoint.EndpointID);
  expect(attachment.IPAddress).toBe(address);
  expect(record(attachment.IPAMConfig).IPv4Address).toBe(address);
  return { endpointId: String(endpoint.EndpointID), address };
}

/** Every object key in the instance's managed overlay (compact JSON, a YAML subset). */
export function overlayKeys(lifecycle: UserImageLifecycle, user: string): string[] {
  const keys: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null)
      for (const [key, nested] of Object.entries(value)) {
        keys.push(key);
        visit(nested);
      }
  };
  visit(JSON.parse(readFileSync(join(lifecycle.overlayDirectory, `${user}.patch.yml`), 'utf8')));
  return keys;
}

export function gatewayStatus(
  lifecycle: UserImageLifecycle,
  database: DatabaseHandle,
  platformId: string,
  user: string,
  authority: string,
): number {
  const row = record(database.prepare('SELECT * FROM instances WHERE user_id = ?').get(user));
  if (typeof row.upstream_host !== 'string' || typeof row.dsh_cookie !== 'string')
    throw new Error('Instance is not ready');
  return platformHttpStatus(lifecycle, platformId, row.upstream_host, authority, row.dsh_cookie);
}

/**
 * Two bundled survivors: A's recorded stand-in was removed and recreated before B started, so A's
 * recorded endpoint is gone and B's is present. A fresh owner reconciles both, optionally after
 * platform recreation, and never attaches a Document Server.
 */
export async function documentServerReconciliation(
  lifecycle: UserImageLifecycle,
  recreatePlatform: boolean,
): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.slice(0, 10)}zz`;
  const platformName = `dsh-team-test-ds-platform-${lifecycle.runId}`;
  const documentServerName = `dsh-team-test-ds-${lifecycle.runId}`;
  const originalPlatform = String(createStandInPlatform(lifecycle, platformName).Id);
  const firstStandIn = String(createStandInPlatform(lifecycle, documentServerName).Id);
  const config = { upstreamMode: 'network' as const, platformContainerName: platformName };
  const database = openDatabase(
    join(dirname(lifecycle.overlayDirectory), 'document-server-reconciliation.db'),
  );
  const { client } = startupClient(lifecycle);
  const owner = createOrchestrator({ client, database, config });
  const authority = 'document-server.example:8443';
  const configured = documentServerConfig(documentServerName);
  try {
    applyMigrations(database);
    registerStartupUsers(lifecycle, database, [userA, userB], 'document-server.example');
    const a = await startDockerInstance(owner, lifecycle, userA, authority, configured);
    expect(documentServerRecord(database, userA)).toEqual({
      document_server_mode: 'bundled',
      document_server_container_id: firstStandIn,
      document_server_reason: null,
    });
    dockerStep(lifecycle, ['container', 'rm', '--force', firstStandIn], 'Stand-in removal failed');
    const standIn = String(createStandInPlatform(lifecycle, documentServerName).Id);
    expect(standIn).not.toBe(firstStandIn);
    const b = await startDockerInstance(owner, lifecycle, userB, authority, configured);
    expect(documentServerRecord(database, userB)).toMatchObject({
      document_server_container_id: standIn,
    });
    const networkA = userNetworkId(lifecycle, a.containerId, userA);
    const networkB = userNetworkId(lifecycle, b.containerId, userB);
    expect(bridgeEndpoints(lifecycle, networkA)).toEqual([a.containerId, originalPlatform].sort());
    const kept = expectDocumentServerAtLayout(lifecycle, standIn, userB, networkB);
    const evidence = () =>
      Promise.all(
        [userA, userB].map((userId) =>
          startupEvidence(database, dockerStartInput(lifecycle, userId, authority, configured)),
        ),
      );
    const before = await evidence();
    let platformId = originalPlatform;
    if (recreatePlatform) {
      dockerStep(
        lifecycle,
        ['container', 'rm', '--force', originalPlatform],
        'Platform stand-in removal failed',
      );
      platformId = String(createStandInPlatform(lifecycle, platformName).Id);
      expect(platformId).not.toBe(originalPlatform);
    }

    const reconstructed = createOrchestrator({ client, database, config });
    await reconstructed.reconcile();
    await reconstructed.reconcile();

    expect(await evidence()).toEqual(before);
    expect(bridgeEndpoints(lifecycle, networkA)).toEqual([a.containerId, platformId].sort());
    expect(bridgeEndpoints(lifecycle, networkB)).toEqual(
      [b.containerId, platformId, standIn].sort(),
    );
    expect(expectDocumentServerAtLayout(lifecycle, standIn, userB, networkB)).toEqual(kept);
    expect(containerNetworks(lifecycle, standIn)).toEqual(['bridge', `dsh-team-net-${userB}`]);
    for (const [user, network] of [
      [userA, networkA],
      [userB, networkB],
    ] as const) {
      expectPlatformAtLayout(lifecycle, platformId, user, network);
      expect(gatewayStatus(lifecycle, database, platformId, user, authority)).toBe(200);
    }
    return JSON.stringify({
      survivors: 2,
      recordedPresent: 1,
      recordedGone: 1,
      platformRecreated: recreatePlatform,
      documentServerAttached: 0,
    });
  } finally {
    database.close();
  }
}

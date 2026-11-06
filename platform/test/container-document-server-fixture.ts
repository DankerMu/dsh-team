import { rm } from 'node:fs/promises';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import type { DockerClient } from '../src/orchestrator/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { RECONCILE_COOKIE } from './container-reconcile-fixture.ts';
import { START_USER, seedPlatform, startupOwnerFixture } from './container-start-fixture.ts';
import type { StartupDaemon, StartupRequest } from './container-start-fixture.ts';

export const DS_ID = '9'.repeat(64);
export const DS_NAME = 'dsh-team-documentserver';
export const DS_PLATFORM = 'f'.repeat(64);
export const DS_PLATFORM_NAME = 'dsh-team-test-platform';
// Fixture-only configuration; the orchestrator never reads the JWT.
const DOCUMENT_SERVER = { containerName: DS_NAME, jwtSecret: 'fixture-not-a-jwt-secret' };

/** A network-mode owner with a running platform and a running bundled Document Server stand-in. */
export async function documentServerFixture(
  upstreamMode: 'network' | 'published-loopback' = 'network',
) {
  const context = await startupOwnerFixture();
  seedPlatform(context.daemon, DS_PLATFORM_NAME, DS_PLATFORM);
  seedPlatform(context.daemon, DS_NAME, DS_ID);
  const config = { upstreamMode, platformContainerName: DS_PLATFORM_NAME };
  const ownerFor = (client: DockerClient = context.client) =>
    createOrchestrator({ client, database: context.database, config });
  const input = {
    ...context.input,
    config: { ...context.input.config, documentServer: DOCUMENT_SERVER },
  };
  return {
    ...context,
    owner: ownerFor(),
    ownerFor,
    input,
    async close() {
      context.database.close();
      await rm(context.root, { recursive: true, force: true });
    },
  };
}

/** A client whose Document Server connect or disconnect response is lost before or after Docker applies it. */
export function losingClient(
  client: DockerClient,
  operation: 'connect' | 'disconnect',
  applied: boolean,
): DockerClient {
  return {
    ...client,
    async json(method, path, body, signal, maxBytes) {
      const target =
        method === 'POST' &&
        path.endsWith(`/${operation}`) &&
        typeof body === 'object' &&
        body !== null &&
        'Container' in body &&
        body.Container === DS_ID;
      if (target && !applied) throw new Error('Fixture transport failed before submission');
      const response = await client.json(method, path, body, signal, maxBytes);
      if (target) throw new Error('Fixture transport lost the applied response');
      return response;
    },
  };
}

/** Docker refuses only the Document Server request on a path the platform shares. */
export function rejectDocumentServer(daemon: StartupDaemon, operation: 'connect' | 'disconnect') {
  daemon.beforeRequest((request) => {
    const key = `${request.method} ${request.path}`;
    if (request.method === 'POST' && request.path.endsWith(`/${operation}`)) {
      if (request.body.Container === DS_ID)
        daemon.overrides.set(key, { status: operation === 'connect' ? 500 : 200 });
      else daemon.overrides.delete(key);
    }
  });
}

export function documentServerRecord(database: DatabaseHandle, user = START_USER): unknown {
  return database
    .prepare(
      'SELECT document_server_mode, document_server_container_id, document_server_reason FROM instances WHERE user_id = ?',
    )
    .get(user);
}

export function documentServerAttachment(daemon: StartupDaemon, user = START_USER): unknown {
  return daemon.containers.get(DS_ID)?.NetworkSettings.Networks?.[`dsh-team-net-${user}`];
}

export function mutations(requests: readonly StartupRequest[], from = 0) {
  return requests
    .slice(from)
    .filter(({ method }) => method !== 'GET')
    .map(({ method, path, body }) => ({ request: `${method} ${path}`, body }));
}

/** Like Docker: a stopped container leaves every bridge view but keeps its own network configuration. */
export function stopDocumentServer(daemon: StartupDaemon): void {
  const container = daemon.containers.get(DS_ID);
  if (container === undefined) throw new Error('Missing fixture Document Server');
  container.State.Running = false;
  for (const network of daemon.networks.values()) Reflect.deleteProperty(network.Containers, DS_ID);
  for (const attachment of Object.values(container.NetworkSettings.Networks ?? {}))
    Object.assign(attachment as object, { EndpointID: '', IPAddress: '' });
}

/** A started row promoted to a ready running survivor that reconciliation keeps. */
export function markRunning(database: DatabaseHandle, user = START_USER): void {
  database
    .prepare("UPDATE instances SET status = 'running', dsh_cookie = ? WHERE user_id = ?")
    .run(RECONCILE_COOKIE, user);
}

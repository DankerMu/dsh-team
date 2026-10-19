import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSession } from '../src/auth/index.ts';
import { openDatabase } from '../src/db/index.ts';
import { createDockerClient, createOrchestrator } from '../src/orchestrator/index.ts';
import { START_CONTAINER, START_MODEL, START_USER } from './container-start-fixture.ts';
import {
  RECONCILE_COOKIE,
  RECONCILE_LIST,
  seedReconciliation,
} from './container-reconcile-fixture.ts';
import { withUpstream } from './gateway-http-fixture.ts';
import { configureInstanceModel } from './instance-fixture.ts';
import { observeStartup } from './main-startup-fixture.ts';
import type { StartupObservation } from './main-startup-fixture.ts';

const SIBLING = 'mnopqrstuvwx';
const PUBLIC_URL = 'https://team.example:8443';
const ROUTED_BODY = 'healthy sibling survived quarantined startup';

async function quarantineBootstrap(discoveryFailure: boolean, missingBridge = false) {
  let result: StartupObservation | undefined;
  let exercised = false;
  let authenticatedUpstreamRequests = 0;
  // Bind this listener before observeStartup chooses main's nonzero configured port.
  await withUpstream(
    (request, response) => {
      if (request.url === '/quarantine-proof' && request.headers.cookie === RECONCILE_COOKIE) {
        authenticatedUpstreamRequests += 1;
        response.writeHead(200, { 'content-type': 'text/plain' }).end(ROUTED_BODY);
      } else response.writeHead(401).end('Upstream authentication required');
    },
    async (upstream) => {
      let affectedCookie = '';
      let siblingCookie = '';
      let administratorCookie = '';
      let receipt: Record<string, unknown> | undefined;
      let networkId = '';
      let initialBridge: unknown;
      let startupRequestOffset = 0;
      result = await observeStartup(
        undefined,
        undefined,
        { PLATFORM_PUBLIC_URL: PUBLIC_URL },
        undefined,
        {
          async setup({ directory, socketPath, database, daemon, signal }) {
            configureInstanceModel(database);
            seedReconciliation(database, daemon, SIBLING, START_CONTAINER);
            database
              .prepare('UPDATE instances SET upstream_port=? WHERE user_id=?')
              .run(upstream.port, SIBLING);
            const sibling = daemon.containers.get(START_CONTAINER);
            if (sibling === undefined) throw new Error('Missing healthy Engine fixture');
            sibling.NetworkSettings.Ports = {
              '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(upstream.port) }],
            };
            database
              .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
              .run(START_USER, 'quarantined@example.test');
            database
              .prepare(
                "INSERT INTO users VALUES ('zzzzzzzzzzzz', 'admin@example.test', 'unused', 'admin', 'active', 1)",
              )
              .run();
            affectedCookie = `platform_session=${createSession(database, START_USER, Date.now())}`;
            siblingCookie = `platform_session=${createSession(database, SIBLING, Date.now())}`;
            administratorCookie = `platform_session=${createSession(database, 'zzzzzzzzzzzz', Date.now())}`;
            const seccompProfilePath = join(directory, 'seccomp.json');
            await writeFile(seccompProfilePath, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
            const owner = createOrchestrator({
              client: createDockerClient(socketPath),
              database,
              config: {
                upstreamMode: 'published-loopback',
                platformContainerName: 'dsh-team-platform',
              },
            });
            const createPath = `/containers/create?name=dsh-team-u-${START_USER}`;
            // Reject at the external Engine boundary before creating any candidate. The real owner
            // has already durably written the nonce/account/prior-row/network receipt at this point.
            daemon.overrides.set(`POST ${createPath}`, {
              status: 500,
              document: { message: 'Injected external create failure' },
            });
            try {
              await expect(
                owner.startUserContainer({
                  userId: START_USER,
                  config: {
                    userImage: 'dsh-team-user:local',
                    seccompProfilePath,
                    managedConfigDir: join(directory, 'managed'),
                    authority: 'team.example:8443',
                    subnetPool: '172.30.0.0/16',
                  },
                  modelSettings: START_MODEL,
                  modelKey: 'fixture-private-key',
                  signal,
                }),
              ).rejects.toThrow('Container startup failed');
            } finally {
              await owner.drain();
              daemon.overrides.delete(`POST ${createPath}`);
            }
            receipt = database
              .prepare<[string], Record<string, unknown>>(
                'SELECT * FROM creation_attempts WHERE user_id=?',
              )
              .get(START_USER);
            expect(receipt?.container_id).toBeNull();
            if (typeof receipt?.network_id !== 'string')
              throw new Error('Missing captured network');
            networkId = receipt.network_id;
            expect(
              database.prepare('SELECT 1 FROM instances WHERE user_id=?').get(START_USER),
            ).toBeUndefined();
            expect(
              [...daemon.containers.values()].some(
                (row) => row.Name === `/dsh-team-u-${START_USER}`,
              ),
            ).toBe(false);
            initialBridge = structuredClone(daemon.networks.get(networkId));
            expect(initialBridge).toMatchObject({
              Id: networkId,
              Name: `dsh-team-net-${START_USER}`,
              Containers: {},
            });
            if (missingBridge) {
              daemon.networks.delete(networkId);
              initialBridge = undefined;
            }
            daemon.overrides.set(`GET /containers/dsh-team-u-${START_USER}/json`, {
              status: 404,
              document: { message: 'No canonical candidate exists' },
            });
            if (discoveryFailure)
              daemon.overrides.set(`GET ${RECONCILE_LIST}`, {
                status: 500,
                document: { message: 'Injected unrelated discovery failure' },
              });
            startupRequestOffset = daemon.requests.length;
          },
          async exercise(base, signal) {
            exercised = true;
            if (discoveryFailure) throw new Error('Main listened despite failed Docker discovery');
            const healthy = await fetch(`${base}/quarantine-proof`, {
              headers: { cookie: siblingCookie },
              signal,
            });
            expect(healthy.status).toBe(200);
            expect(await healthy.text()).toBe(ROUTED_BODY);
            expect(authenticatedUpstreamRequests).toBe(1);
            const status = await fetch(`${base}/_platform/api/instance`, {
              headers: { cookie: affectedCookie },
              signal,
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual({ status: 'error', reason: 'error' });
            const unavailable = await fetch(`${base}/quarantine-proof`, {
              headers: { cookie: affectedCookie },
              signal,
            });
            expect(unavailable.status).toBe(503);
            expect(await unavailable.json()).toMatchObject({ reason: 'error' });
            expect(authenticatedUpstreamRequests).toBe(1);
            const start = await fetch(`${base}/_platform/api/instance/start`, {
              method: 'POST',
              headers: {
                cookie: affectedCookie,
                origin: PUBLIC_URL,
                'content-type': 'application/json',
              },
              body: '{}',
              signal,
            });
            expect(start.status).toBe(500);
            await start.arrayBuffer();
            const disabled = await fetch(`${base}/_platform/api/admin/users/${START_USER}/status`, {
              method: 'PUT',
              headers: {
                cookie: administratorCookie,
                origin: PUBLIC_URL,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ status: 'disabled' }),
              signal,
            });
            expect(disabled.status).toBe(500);
            await disabled.arrayBuffer();
            // Durable session revocation is allowed; a failed retirement must not take siblings down.
            const stillHealthy = await fetch(`${base}/quarantine-proof`, {
              headers: { cookie: siblingCookie },
              signal,
            });
            expect(stillHealthy.status).toBe(200);
            expect(await stillHealthy.text()).toBe(ROUTED_BODY);
            expect(authenticatedUpstreamRequests).toBe(2);
          },
          async afterExit({ directory, socketPath, daemon, signal }) {
            const mainRequests = daemon.requests.slice(startupRequestOffset);
            expect(
              mainRequests.some(({ method, path }) => method === 'GET' && path === RECONCILE_LIST),
            ).toBe(true);
            if (!discoveryFailure)
              expect(
                mainRequests.some(
                  ({ method, path }) =>
                    method === 'GET' && path === `/containers/dsh-team-u-${START_USER}/json`,
                ),
              ).toBe(true);
            // Main's SQLite handle is closed before this independent public-owner stop proof.
            const database = openDatabase(join(directory, 'platform.db'));
            const owner = createOrchestrator({
              client: createDockerClient(socketPath),
              database,
              config: {
                upstreamMode: 'published-loopback',
                platformContainerName: 'dsh-team-platform',
              },
            });
            try {
              await expect(
                owner.stopUserContainer({
                  userId: START_USER,
                  reason: 'admin',
                  allowMissingInstance: true,
                  signal,
                }),
              ).rejects.toThrow('User container retirement failed');
              expect(
                database.prepare('SELECT * FROM creation_attempts WHERE user_id=?').get(START_USER),
              ).toEqual(receipt);
              expect(
                database.prepare('SELECT 1 FROM instances WHERE user_id=?').get(START_USER),
              ).toBeUndefined();
              expect(daemon.networks.get(networkId)).toEqual(initialBridge);
              const sibling = database
                .prepare<
                  [string],
                  {
                    container_id: string;
                    dsh_cookie: string;
                    status: string;
                    upstream_port: number;
                  }
                >(
                  'SELECT container_id,dsh_cookie,status,upstream_port FROM instances WHERE user_id=?',
                )
                .get(SIBLING);
              expect(sibling?.container_id).toBe(START_CONTAINER);
              expect(sibling?.status).toBe('running');
              expect(sibling?.upstream_port).toBe(upstream.port);
              // Compare secrets without including their values in assertion diagnostics.
              expect(sibling?.dsh_cookie === RECONCILE_COOKIE).toBe(true);
              expect(
                daemon.requests
                  .slice(startupRequestOffset)
                  .some(
                    ({ method, path }) =>
                      method === 'DELETE' &&
                      (path.startsWith('/containers/') || path === `/networks/${networkId}`),
                  ),
              ).toBe(false);
            } finally {
              await owner.drain();
              database.close();
            }
          },
        },
      );
    },
  );
  if (result === undefined) throw new Error('Main startup was not observed');
  return { ...result, exercised, authenticatedUpstreamRequests };
}

it('listens and routes a healthy sibling while retaining an unknown-ID absent creation as a per-user quarantine', async () => {
  const result = await quarantineBootstrap(false);

  expect(result.health).toEqual({ status: 200, body: { status: 'ok' } });
  expect(result.exitCode).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.exercised).toBe(true);
  expect(result.authenticatedUpstreamRequests).toBe(2);
}, 10000);

it.each([
  {
    reason: 'unrelated Docker discovery returns 500',
    discoveryFailure: true,
    missingBridge: false,
  },
  {
    reason: 'an unknown creation attempt has lost its captured bridge',
    discoveryFailure: false,
    missingBridge: true,
  },
])(
  'still exits without listening when $reason',
  async ({ discoveryFailure, missingBridge }) => {
    const result = await quarantineBootstrap(discoveryFailure, missingBridge);

    expect(result.health).toBeNull();
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain('Instance reconciliation failed');
    expect(result.exercised).toBe(false);
    expect(result.authenticatedUpstreamRequests).toBe(0);
  },
  10000,
);

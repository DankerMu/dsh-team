import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createGatewayConnections } from '../src/gateway/index.ts';
import type { GatewayActivity } from '../src/gateway/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import type { InstanceService } from '../src/orchestrator/index.ts';
import {
  START_CONTAINER,
  START_IMAGE,
  START_USER,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';
import { withUpstream } from './gateway-http-fixture.ts';
import type { StartupBarrier, StartupDaemon } from './container-start-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';

export const IDLE_SIBLING = 'mnopqrstuvwx';
export interface IdleContext {
  service: InstanceService;
  database: DatabaseHandle;
  daemon: StartupDaemon;
  app: FastifyInstance | undefined;
  base: string | undefined;
  getActivity: (userId: string) => GatewayActivity;
  control: {
    tasks:
      | 'idle'
      | 'busy'
      | 'unknown'
      | 'rpc-mismatch'
      | 'bad-envelope'
      | 'bad-running'
      | 'missing-items'
      | 'malformed'
      | 'partial'
      | 'oversize'
      | 'oversize-header'
      | 'deadline'
      | 'reset';
    probe: StartupBarrier | undefined;
    probes: number;
  };
  setNow: (now: number) => void;
  holdEngine: (callback: (method: string, path: string) => Promise<undefined> | undefined) => void;
  seedSibling: () => void;
  seedUser: (userId: string, containerId: string) => void;
}

/** Actual service/owner over file SQLite, TCP RPC and Unix Engine system boundaries. */
export async function withIdleInstance(
  run: (context: IdleContext) => Promise<void>,
  application = false,
): Promise<void> {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-idle-boundary-',
    users: { [START_USER]: 'idle@example.test', [IDLE_SIBLING]: 'sibling@example.test' },
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const config = instanceConfig(f.root, { dockerSocketPath: join(f.root, 'engine.sock') });
  const service = createInstanceService({
    database: f.database,
    config,
    client: createDockerClient(config.dockerSocketPath),
  });
  const connections = createGatewayConnections(service.recordActivity);
  const control: IdleContext['control'] = { tasks: 'idle', probe: undefined, probes: 0 };
  let now = 600_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let app: FastifyInstance | undefined;
  try {
    await withUpstream(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof envelope !== 'object' || envelope === null || !('rpcId' in envelope)) {
            response.writeHead(400).end();
            return;
          }
          control.probes++;
          const send = () => {
            if (response.destroyed) return;
            const mode = control.tasks;
            if (mode === 'reset') {
              request.socket.destroy();
              return;
            }
            if (mode === 'deadline') {
              response.writeHead(200).write('{');
              return;
            }
            if (mode === 'malformed') {
              response.writeHead(200).end('{');
              return;
            }
            if (mode === 'oversize') {
              response.writeHead(200).end(Buffer.alloc(1024 * 1024 + 1, 32));
              return;
            }
            const value =
              mode === 'missing-items'
                ? {}
                : {
                    items:
                      mode === 'bad-running'
                        ? [{ running: true }, { running: 'false' }]
                        : [{ running: mode === 'busy' }],
                  };
            const body = JSON.stringify({
              type: mode === 'bad-envelope' ? 'client-request' : 'server-response',
              rpcId: mode === 'rpc-mismatch' ? 'foreign' : envelope.rpcId,
              result: { ok: true, value },
            });
            response
              .writeHead(mode === 'unknown' ? 503 : 200, {
                'content-type': 'application/json',
                ...(mode === 'partial' ? { 'content-length': Buffer.byteLength(body) + 128 } : {}),
                ...(mode === 'oversize-header' ? { 'x-private': 'x'.repeat(9 * 1024) } : {}),
              })
              .end(body);
          };
          if (control.probe === undefined) send();
          else void control.probe.hold().then(send);
        });
      },
      async (target, server) => {
        server.on('upgrade', (_request, socket) => {
          socket.on('error', () => undefined);
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
          );
        });
        writeSettings(f.database, {
          idleMinutes: 1,
          modelBaseUrl: 'http://model.invalid/v1',
          modelApiKey: 'idle-fixture-only',
          models: [{ name: 'office-model' }],
          defaultModel: 'office-model',
        });
        const seed = (userId: string, containerId: string) => {
          f.database
            .prepare("INSERT OR IGNORE INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
            .run(userId, `${userId}@idle.test`);
          f.database
            .prepare(
              `INSERT INTO instances (user_id,status,container_id,image_id,image_tag,upstream_host,upstream_port,dsh_cookie,last_started_at,last_activity_at) VALUES (?, 'running', ?, ?, 'dsh-team-user:local', ?, ?, ?, 101, 202)`,
            )
            .run(userId, containerId, START_IMAGE, target.host, target.port, target.cookie);
          f.daemon.containers.set(containerId, {
            Id: containerId,
            Name: `/dsh-team-u-${userId}`,
            Image: START_IMAGE,
            Config: { Labels: { 'dsh-team.user': userId } },
            State: { Running: true },
            NetworkSettings: {
              Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(target.port) }] },
            },
          });
          f.daemon.attachOwnedNetwork(userId, containerId);
        };
        seed(START_USER, START_CONTAINER);
        if (application) {
          app = await buildApp(config, f.database, undefined, undefined, service);
          await app.listen({ host: '127.0.0.1', port: 0 });
        }
        await run({
          service,
          database: f.database,
          daemon: f.daemon,
          app,
          base:
            app === undefined ? undefined : `http://127.0.0.1:${String(app.addresses()[0]?.port)}`,
          getActivity: app?.getUserActivity ?? connections.getUserActivity,
          control,
          setNow: (value) => {
            now = value;
          },
          holdEngine: (callback) => {
            f.hold(callback);
          },
          seedSibling: () => {
            seed(IDLE_SIBLING, 'd'.repeat(64));
          },
          seedUser: seed,
        });
      },
    );
  } finally {
    control.probe?.release();
    try {
      await connections.close();
      await app?.close();
      await service.close();
    } finally {
      clock.mockRestore();
      await f.close();
    }
  }
}

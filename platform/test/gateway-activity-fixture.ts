import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { PlatformConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import type { InstanceService } from '../src/orchestrator/index.ts';
import { startupUnixOwnerFixture } from './container-start-fixture.ts';
import { observeHttp, reader } from './gateway-http-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';

export interface GatewayActivityContext {
  app: FastifyInstance;
  service: InstanceService;
  database: DatabaseHandle;
  config: PlatformConfig;
  base: string;
  port: number;
  lines: string[];
  holdEngine: (hold: (method: string, path: string) => Promise<undefined> | undefined) => void;
}

export async function withGatewayActivityApp(
  run: (context: GatewayActivityContext) => Promise<void>,
): Promise<void> {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-gateway-activity-',
    users: {},
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  let app: FastifyInstance | undefined;
  let service: InstanceService | undefined;
  try {
    const config = instanceConfig(f.root, {
      dockerSocketPath: join(f.root, 'engine.sock'),
      // These cases qualify fixed safe DB-failure logs, not normal request logging.
      logLevel: 'error',
    });
    service = createInstanceService({
      database: f.database,
      config,
      client: createDockerClient(config.dockerSocketPath),
    });
    const lines: string[] = [];
    app = await buildApp(
      config,
      f.database,
      { write: (line) => lines.push(line) },
      undefined,
      service,
    );
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing activity application port');
    await run({
      app,
      service,
      database: f.database,
      config,
      base,
      port,
      lines,
      holdEngine: (hold) => {
        f.hold(hold);
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await service?.close();
      } finally {
        await f.close();
      }
    }
  }
}

export function seedActivityInstance(
  database: DatabaseHandle,
  userId: string,
  target: GatewayUpstream,
): void {
  database
    .prepare(
      "INSERT INTO instances(user_id,status,upstream_host,upstream_port,dsh_cookie,last_started_at) VALUES (?, 'running', ?, ?, ?, 101)",
    )
    .run(userId, target.host, target.port, target.cookie);
}

export async function connectActivityPeer(port: number) {
  const socket = connect(port, '127.0.0.1');
  const read = reader(socket);
  const closed = Promise.withResolvers<undefined>();
  socket.once('close', () => {
    closed.resolve(undefined);
  });
  try {
    await observeHttp(once(socket, 'connect'));
    return { socket, read, closed: closed.promise };
  } catch (error) {
    socket.destroy();
    await observeHttp(closed.promise);
    throw error;
  }
}

export async function observeActivity(predicate: () => boolean): Promise<void> {
  // Only a bounded real-time wait for an observed server-side state transition;
  // this never advances or substitutes for the controlled activity clock.
  const signal = AbortSignal.timeout(2_000);
  while (!predicate()) await delay(5, undefined, { signal });
}

export function activityUpgradeRequest(port: number, cookie: string, origin: string): string {
  return `GET /activity-ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${origin}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;
}

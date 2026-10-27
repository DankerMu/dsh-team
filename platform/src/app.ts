import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { adminRoutes } from './admin/index.ts';
import {
  createSourceAddressResolver,
  currentSessionRoutes,
  installRequestGuard,
  installSessionHeal,
  loginRoutes,
  logoutRoutes,
  passwordChangeRoutes,
  registrationRoutes,
} from './auth/index.ts';
import type { PlatformConfig } from './config.ts';
import type { DatabaseHandle } from './db/index.ts';
import { healthRoutes } from './health.ts';
import {
  createGatewayConnections,
  gatewayRoutes,
  instanceRoutes,
  type GatewayUpstreamResolver,
  type GatewayActivity,
} from './gateway/index.ts';
import type { InstanceService } from './orchestrator/index.ts';
import { webRoutes } from './web/index.ts';

/**
 * Log fields that must never be written in clear text, whatever the log level.
 * Extend this list in the same change that introduces a new secret-bearing field.
 */
const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers.authorization',
  'res.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.apiKey',
  'req.body.modelApiKey',
  'apiKey',
  'modelApiKey',
  '*.modelApiKey',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.apiKey',
  '*.cookie',
];

/** Destination for log lines; defaults to stdout when omitted. */
export interface LogDestination {
  write(line: string): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    disconnectUserConnections: (userId: string) => Promise<void>;
    getUserActivity: (userId: string) => GatewayActivity;
  }
}

/** Builds the platform HTTP application without binding a port. */
export async function buildApp(
  config: PlatformConfig,
  database: DatabaseHandle,
  logDestination?: LogDestination,
  resolveUpstream?: GatewayUpstreamResolver,
  instanceService?: InstanceService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });
  const connections = createGatewayConnections(instanceService?.recordActivity);
  const gatewayResolver = instanceService?.resolveUpstream ?? resolveUpstream;
  app.decorate('disconnectUserConnections', connections.disconnectUser);
  app.decorate('getUserActivity', connections.getUserActivity);
  // Route plugins' own preClose hooks run after this root drain; cancel outbound work first.
  const shutdown = new AbortController();

  try {
    installRequestGuard(app, config.publicUrl);
    installSessionHeal(app, config.publicUrl, config.cookieSecure);
    const resolveSourceAddress = createSourceAddressResolver(config.trustedProxies);
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: { title: 'DSH Team Platform API', version: '0.1.0' },
      },
    });
    await app.register(healthRoutes);
    await app.register(registrationRoutes, {
      database,
      cookieSecure: config.cookieSecure,
      resolveSourceAddress,
    });
    await app.register(loginRoutes, {
      database,
      cookieSecure: config.cookieSecure,
      resolveSourceAddress,
    });
    await app.register(logoutRoutes, {
      database,
      cookieSecure: config.cookieSecure,
      resolveSourceAddress,
    });
    await app.register(currentSessionRoutes, { database });
    await app.register(passwordChangeRoutes, {
      database,
      cookieSecure: config.cookieSecure,
      resolveSourceAddress,
    });
    await app.register(adminRoutes, {
      database,
      resolveSourceAddress,
      subnetPool: config.subnetPool,
      shutdown: shutdown.signal,
      ...(instanceService === undefined ? {} : { service: instanceService }),
    });
    await app.register(instanceRoutes, {
      database,
      ...(instanceService === undefined ? {} : { service: instanceService }),
    });
    await app.register(webRoutes);
    await app.register(gatewayRoutes, {
      database,
      connections,
      authority: config.authority,
      publicUrl: config.publicUrl,
      cookieSecure: config.cookieSecure,
      ...(gatewayResolver === undefined ? {} : { resolveUpstream: gatewayResolver }),
    });
  } catch (error) {
    await app.close();
    throw error;
  }

  // Node's HTTP close does not retire accepted sockets with no parsed request.
  const unclaimed = new Set<Socket>();
  const responses = new Map<Socket, number>();
  const drained = Promise.withResolvers<undefined>();
  let closing = false;
  function released(this: Socket): void {
    unclaimed.delete(this);
  }
  function accepted(socket: Socket): void {
    if (closing) {
      socket.destroy();
      return;
    }
    unclaimed.add(socket);
    socket.once('close', released);
  }
  function claimed(request: IncomingMessage): void {
    unclaimed.delete(request.socket);
    request.socket.off('close', released);
  }
  function responseReleased(this: Socket): void {
    responses.delete(this);
    if (closing && responses.size === 0) drained.resolve(undefined);
  }
  function requested(request: IncomingMessage, response: ServerResponse): void {
    claimed(request);
    const socket = request.socket;
    if (!responses.has(socket)) socket.once('close', responseReleased);
    responses.set(socket, (responses.get(socket) ?? 0) + 1);
    function settled(): void {
      response.off('finish', settled);
      response.off('close', settled);
      const remaining = (responses.get(socket) ?? 1) - 1;
      if (remaining > 0) {
        responses.set(socket, remaining);
      } else {
        socket.off('close', responseReleased);
        responseReleased.call(socket);
        // Orderly EOF preserves accepted writes; other parsed responses must finish first.
        if (closing && !socket.destroyed) socket.end();
      }
    }
    response.once('finish', settled);
    response.once('close', settled);
  }
  app.server.on('connection', accepted);
  // A handler may initiate shutdown synchronously; claim its transport first.
  app.server.prependListener('request', requested);
  app.server.prependListener('upgrade', claimed);

  async function flushActivity(phase?: 'shutdown'): Promise<void> {
    try {
      await instanceService?.flushActivity(phase);
    } catch {
      app.log.error('Gateway activity persistence failure');
    }
  }
  const activityTimer =
    instanceService === undefined ? undefined : setInterval(() => void flushActivity(), 1_000);
  activityTimer?.unref();
  const idleTimer =
    instanceService === undefined
      ? undefined
      : setInterval(() => {
          void instanceService.checkIdle(connections.getUserActivity).catch(() => {
            app.log.error('Idle instance check failure');
          });
        }, 60_000);
  idleTimer?.unref();

  app.addHook('onClose', async () => {
    app.server.off('connection', accepted);
    app.server.off('request', requested);
    app.server.off('upgrade', claimed);
    // Transport release is complete and the listener is closed before draining
    // activity queued behind lifecycle work; SQLite must outlive both drains.
    await flushActivity('shutdown');
    await instanceService?.close();
    database.close();
  });
  // Fence both admissions and destroy owned transports before any unrelated lifecycle drain.
  // onClose awaits activity and the same service promise before releasing SQLite.
  app.addHook('preClose', async () => {
    closing = true;
    shutdown.abort();
    for (const socket of unclaimed) socket.destroy();
    clearInterval(activityTimer);
    clearInterval(idleTimer);
    void instanceService?.close();
    await connections.close();
    // Node closeIdleConnections treats end() as idle before buffered writes finish.
    if (responses.size !== 0) await drained.promise;
  });
  return app;
}

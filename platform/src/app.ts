import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { adminRoutes } from './admin/index.ts';
import {
  createSourceAddressResolver,
  installRequestGuard,
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
  type GatewayUpstreamResolver,
} from './gateway/index.ts';

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
  }
}

/** Builds the platform HTTP application without binding a port. */
export async function buildApp(
  config: PlatformConfig,
  database: DatabaseHandle,
  logDestination?: LogDestination,
  resolveUpstream?: GatewayUpstreamResolver,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });
  const connections = createGatewayConnections();
  app.decorate('disconnectUserConnections', connections.disconnectUser);

  try {
    installRequestGuard(app, config.publicUrl);
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
    await app.register(passwordChangeRoutes, {
      database,
      cookieSecure: config.cookieSecure,
      resolveSourceAddress,
    });
    await app.register(adminRoutes, { database });
    await app.register(gatewayRoutes, {
      database,
      connections,
      authority: config.authority,
      publicUrl: config.publicUrl,
      ...(resolveUpstream === undefined ? {} : { resolveUpstream }),
    });
  } catch (error) {
    await app.close();
    throw error;
  }

  app.addHook('onClose', (_instance, done) => {
    database.close();
    done();
  });
  return app;
}

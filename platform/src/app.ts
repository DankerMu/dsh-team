import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { loginRoutes, logoutRoutes, registrationRoutes } from './auth/index.ts';
import type { PlatformConfig } from './config.ts';
import type { DatabaseHandle } from './db/index.ts';
import { healthRoutes } from './health.ts';

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
  '*.password',
  '*.token',
  '*.apiKey',
];

/** Destination for log lines; defaults to stdout when omitted. */
export interface LogDestination {
  write(line: string): void;
}

/** Builds the platform HTTP application without binding a port. */
export async function buildApp(
  config: PlatformConfig,
  database: DatabaseHandle,
  logDestination?: LogDestination,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });

  try {
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
    });
    await app.register(loginRoutes, {
      database,
      cookieSecure: config.cookieSecure,
    });
    await app.register(logoutRoutes, {
      database,
      cookieSecure: config.cookieSecure,
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

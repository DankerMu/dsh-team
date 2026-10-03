import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PlatformConfig } from './config.ts';
import { healthRoutes } from './health.ts';

/**
 * Log fields that must never be written in clear text, whatever the log level.
 * Extend this list in the same change that introduces a new secret-bearing field.
 */
const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
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
  logDestination?: LogDestination,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'DSH Team Platform API', version: '0.1.0' },
    },
  });
  await app.register(healthRoutes);

  return app;
}

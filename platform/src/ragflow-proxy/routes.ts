import type { FastifyPluginCallback } from 'fastify';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withRequestAbort } from '../request-abort.ts';
import {
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_VERSION_PATTERN,
  ragflowVersion,
} from './client.ts';
import { INSTANCE_ERRORS } from './instance-auth.ts';

const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
/** A closed-set result that carries the version only when it is `ok`. */
export const RAGFLOW_VERSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    version: { type: 'string', pattern: RAGFLOW_VERSION_PATTERN, maxLength: 64 },
  },
} as const;

/**
 * Instance-facing RAGFlow routes. The root authentication hook has admitted every request that
 * reaches them; an answered request is HTTP 200 with a closed-set `result`.
 */
export const ragflowProxyRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  /** Aborted by the application before it drains in-flight responses. */
  shutdown: AbortSignal;
}> = (app, { database, shutdown }, done) => {
  app.get(
    '/_platform/instance-api/ragflow/version',
    {
      // An implicit HEAD route would reach RAGFlow outside the declared interface.
      exposeHeadRoute: false,
      schema: {
        summary: 'Read the version of the configured RAGFlow for an authenticated instance',
        response: {
          200: RAGFLOW_VERSION_SCHEMA,
          401: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    async (_request, reply) => {
      try {
        return await withRequestAbort(reply, shutdown, (signal) => {
          const settings = readSettings(database);
          return ragflowVersion(
            { baseURL: settings.ragflowBaseUrl, apiKey: settings.ragflowApiKey },
            signal,
            RAGFLOW_TIMEOUT_MS,
          );
        });
      } catch {
        // Storage and cancellation text stay out; the outcome set has no failure of its own.
        app.log.error('RAGFlow proxy version failure');
        return await reply.code(500).send(INSTANCE_ERRORS[500]);
      }
    },
  );
  done();
};

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { modelSnapshot } from '../managed-config/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';
import { ADMIN_ERRORS, EMPTY_BODY_SCHEMA, emptyBodyPolicy } from './empty-body.ts';
import { MODEL_PROBE_DEADLINE_MS, MODEL_PROBE_RESULTS, probeModel } from './model-probe.ts';

const EMPTY_BODY = emptyBodyPolicy('Empty model connection test body required');

/** Current authority after the body is read; entry admission alone is not enough. */
function authorityRejection(database: DatabaseHandle, request: FastifyRequest) {
  const token = readSessionCookie(request.headers.cookie);
  const actor = token === null ? null : getSessionUser(database, token, Date.now(), false);
  if (actor === null) return ADMIN_ERRORS[401];
  return actor.role === 'admin' ? null : ADMIN_ERRORS[403];
}

export const modelConnectionRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  /** Aborted by the application before it drains in-flight responses. */
  shutdown: AbortSignal;
}> = (app, { database, shutdown }, done) => {
  function failure() {
    app.log.error('Administrator model connection test failure');
    return ADMIN_ERRORS[500];
  }
  app.setErrorHandler(EMPTY_BODY.errorHandler(failure));
  app.post<{ Body: unknown }>(
    '/_platform/api/admin/model-config/test',
    {
      validatorCompiler: EMPTY_BODY.validatorCompiler,
      preValidation: EMPTY_BODY.preValidation,
      schema: {
        summary: 'Send one minimal completion request with the saved model configuration',
        body: EMPTY_BODY_SCHEMA,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['result', 'httpStatus', 'elapsedMs'],
            properties: {
              result: { type: 'string', enum: MODEL_PROBE_RESULTS },
              httpStatus: { type: ['integer', 'null'] },
              elapsedMs: { type: 'integer', minimum: 0 },
            },
          },
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          413: ERROR_SCHEMA,
          415: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const owner = new AbortController();
      // The response, not the request stream, closes when the client disconnects before a reply.
      const disconnected = () => {
        owner.abort();
      };
      reply.raw.once('close', disconnected);
      try {
        const rejection = authorityRejection(database, request);
        if (rejection !== null) return await reply.code(rejection.statusCode).send(rejection);
        const outcome = await probeModel(
          modelSnapshot(readSettings(database)),
          AbortSignal.any([owner.signal, shutdown]),
          MODEL_PROBE_DEADLINE_MS,
        );
        // Fixed text and the closed-set code only: errors, URLs and upstream bodies stay out.
        if (outcome.result !== 'ok')
          app.log.warn({ result: outcome.result }, 'Administrator model connection test failed');
        return outcome;
      } catch {
        return await reply.code(500).send(failure());
      } finally {
        reply.raw.off('close', disconnected);
      }
    },
  );
  done();
};

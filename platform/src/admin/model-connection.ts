import type { FastifyPluginCallback } from 'fastify';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { modelSnapshot } from '../managed-config/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';
import {
  ADMIN_ERRORS,
  EMPTY_BODY_SCHEMA,
  emptyBodyPolicy,
  runConnectionTest,
} from './empty-body.ts';
import { MODEL_PROBE_DEADLINE_MS, MODEL_PROBE_RESULTS, probeModel } from './model-probe.ts';

const EMPTY_BODY = emptyBodyPolicy('Empty model connection test body required');

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
    (request, reply) =>
      runConnectionTest(
        {
          database,
          shutdown,
          log: app.log,
          failed: 'Administrator model connection test failed',
          failure,
        },
        request,
        reply,
        (signal) =>
          probeModel(modelSnapshot(readSettings(database)), signal, MODEL_PROBE_DEADLINE_MS),
      ),
  );
  done();
};

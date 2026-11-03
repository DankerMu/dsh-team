import type { FastifyPluginCallback } from 'fastify';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  RAGFLOW_TEST_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_VERSION_PATTERN,
  testRagflowConnection,
} from '../ragflow-proxy/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';
import {
  ADMIN_ERRORS,
  EMPTY_BODY_SCHEMA,
  emptyBodyPolicy,
  runConnectionTest,
} from './empty-body.ts';

const EMPTY_BODY = emptyBodyPolicy('Empty RAGFlow connection test body required');

export const ragflowConnectionRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  /** Aborted by the application before it drains in-flight responses. */
  shutdown: AbortSignal;
}> = (app, { database, shutdown }, done) => {
  function failure() {
    app.log.error('Administrator RAGFlow connection test failure');
    return ADMIN_ERRORS[500];
  }
  app.setErrorHandler(EMPTY_BODY.errorHandler(failure));
  app.post<{ Body: unknown }>(
    '/_platform/api/admin/ragflow-config/test',
    {
      validatorCompiler: EMPTY_BODY.validatorCompiler,
      preValidation: EMPTY_BODY.preValidation,
      schema: {
        summary: 'Read the RAGFlow version, then list one dataset with the saved key',
        body: EMPTY_BODY_SCHEMA,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['result'],
            properties: {
              result: { type: 'string', enum: RAGFLOW_TEST_RESULTS },
              version: { type: 'string', pattern: RAGFLOW_VERSION_PATTERN, maxLength: 64 },
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
          failed: 'Administrator RAGFlow connection test failed',
          failure,
        },
        request,
        reply,
        (signal) => {
          const settings = readSettings(database);
          return testRagflowConnection(
            { baseURL: settings.ragflowBaseUrl, apiKey: settings.ragflowApiKey },
            signal,
            RAGFLOW_TIMEOUT_MS,
          );
        },
      ),
  );
  done();
};

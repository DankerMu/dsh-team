import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withRequestAbort } from '../request-abort.ts';
import {
  RAGFLOW_DATASET_ID_PATTERN,
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_VERSION_PATTERN,
  listRagflowDatasets,
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

/** A closed-set result that carries only each dataset's ID and name when it is `ok`. */
const RAGFLOW_DATASETS_SCHEMA = {
  type: 'object',
  // Closed at both levels so the serializer drops any upstream field a mapping defect let through.
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    datasets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', pattern: RAGFLOW_DATASET_ID_PATTERN },
          name: { type: 'string', minLength: 1 },
        },
      },
    },
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
  /** One read of the saved RAGFlow connection; any failure is the fixed 500 with `failure` logged. */
  async function relay<T>(
    reply: FastifyReply,
    read: (
      settings: { baseURL: string; apiKey: string },
      signal: AbortSignal,
      deadlineMs: number,
    ) => Promise<T>,
    failure: string,
  ): Promise<T> {
    try {
      return await withRequestAbort(reply, shutdown, (signal) => {
        const settings = readSettings(database);
        return read(
          { baseURL: settings.ragflowBaseUrl, apiKey: settings.ragflowApiKey },
          signal,
          RAGFLOW_TIMEOUT_MS,
        );
      });
    } catch {
      // Storage and cancellation text stay out; the outcome set has no failure of its own.
      app.log.error(failure);
      return await reply.code(500).send(INSTANCE_ERRORS[500]);
    }
  }

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
    (_request, reply) => relay(reply, ragflowVersion, 'RAGFlow proxy version failure'),
  );
  app.get(
    '/_platform/instance-api/ragflow/datasets',
    {
      exposeHeadRoute: false,
      schema: {
        summary:
          'List the ID and name of every dataset of the configured RAGFlow for an authenticated ' +
          'instance. Any query string, even a bare "?", answers invalid-request without ' +
          'contacting RAGFlow.',
        response: {
          200: RAGFLOW_DATASETS_SCHEMA,
          401: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    // No querystring schema: Ajv's removeAdditional would silently drop unknown parameters.
    (request, reply) =>
      request.url.includes('?')
        ? Promise.resolve({ result: 'invalid-request' as const })
        : relay(reply, listRagflowDatasets, 'RAGFlow proxy datasets failure'),
  );
  done();
};

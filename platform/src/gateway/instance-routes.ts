import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { InstanceService } from '../orchestrator/index.ts';

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
const ERRORS = {
  400: { statusCode: 400, error: 'Bad Request', message: 'Empty instance start body required' },
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  503: { statusCode: 503, error: 'Service Unavailable', message: 'Instance service unavailable' },
} as const;
const STATES = ['running', 'stopped', 'starting', 'full', 'error', 'unconfigured'];
const RESPONSE = {
  200: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'reason'],
    properties: {
      status: { type: 'string', enum: STATES },
      reason: {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: STATES.filter((state) => state !== 'running') },
        ],
      },
    },
  },
  400: ERROR_SCHEMA,
  401: ERROR_SCHEMA,
  403: ERROR_SCHEMA,
  413: ERROR_SCHEMA,
  415: ERROR_SCHEMA,
  500: ERROR_SCHEMA,
  503: ERROR_SCHEMA,
} as const;

/** Current-session transport only; GET never admits lifecycle work. */
export const instanceRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  service?: InstanceService;
}> = (app, { database, service }, done) => {
  function identity(request: FastifyRequest, renew: boolean) {
    const token = readSessionCookie(request.headers.cookie);
    return token === null ? null : getSessionUser(database, token, Date.now(), renew);
  }
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (code === 400 || code === 413 || code === 415) return reply.code(code).send(ERRORS[code]);
    app.log.error('Instance operation failed');
    return reply.code(500).send(ERRORS[500]);
  });
  app.addHook('onRequest', (request, reply, next) => {
    try {
      if (identity(request, true) === null) {
        void reply.code(401).send(ERRORS[401]);
        return;
      }
      next();
    } catch {
      app.log.error('Instance authentication storage failure');
      void reply.code(500).send(ERRORS[500]);
    }
  });
  app.get(
    '/_platform/api/instance',
    {
      schema: { summary: 'Read the current user instance state', response: RESPONSE },
    },
    (request, reply) => {
      const user = identity(request, false);
      if (user === null) return reply.code(401).send(ERRORS[401]);
      if (service === undefined) return reply.code(503).send(ERRORS[503]);
      return service.status(user.id);
    },
  );
  app.post(
    '/_platform/api/instance/start',
    {
      schema: {
        summary: 'Start or reuse the current user instance',
        headers: {
          type: 'object',
          required: ['origin'],
          properties: { origin: { type: 'string' } },
        },
        body: { type: 'object', additionalProperties: false, properties: {} },
        response: RESPONSE,
      },
      // Reject raw identifiers rather than allowing AJV to remove unknown properties.
      preValidation: (request, reply, next) => {
        const body: unknown = request.body;
        if (
          typeof body !== 'object' ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        ) {
          void reply.code(400).send(ERRORS[400]);
          return;
        }
        next();
      },
    },
    async (request, reply) => {
      // A held body cannot retain an identity revoked/disabled since onRequest admission.
      const user = identity(request, false);
      if (user === null) return reply.code(401).send(ERRORS[401]);
      if (service === undefined) return reply.code(503).send(ERRORS[503]);
      return service.start(user.id);
    },
  );
  done();
};

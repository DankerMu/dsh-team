import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA } from './credentials.ts';
import { readSessionCookie } from './session-cookie.ts';
import { getSessionUser } from './session.ts';

const ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
} as const;
const RESPONSE = {
  200: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'role'],
    properties: {
      email: { type: 'string' },
      role: { type: 'string', enum: ['admin', 'employee'] },
    },
  },
  401: ERROR_RESPONSE_SCHEMA,
  500: ERROR_RESPONSE_SCHEMA,
} as const;

/**
 * Admits only a current platform session (renewing activity) in `onRequest` for every route of
 * this encapsulated plugin; storage failures answer a sanitized 500 with the fixed log line.
 * Returns the handler-side recheck, which does not renew: a revocation since admission yields null.
 */
export function admitCurrentSession(
  app: FastifyInstance,
  database: DatabaseHandle,
  storageFailure: string,
): (request: FastifyRequest) => ReturnType<typeof getSessionUser> {
  function identity(request: FastifyRequest, renew: boolean) {
    const token = readSessionCookie(request.headers.cookie);
    return token === null ? null : getSessionUser(database, token, Date.now(), renew);
  }
  app.addHook('onRequest', (request, reply, next) => {
    try {
      if (identity(request, true) === null) {
        void reply.code(401).send(ERRORS[401]);
        return;
      }
      next();
    } catch {
      app.log.error(storageFailure);
      void reply.code(500).send(ERRORS[500]);
    }
  });
  return (request) => identity(request, false);
}

/** Registers read-only `GET /_platform/api/session`: the current account's email and role. */
export const currentSessionRoutes: FastifyPluginCallback<{ database: DatabaseHandle }> = (
  app,
  { database },
  done,
) => {
  const current = admitCurrentSession(app, database, 'Session lookup storage failure');
  app.setErrorHandler((_error, _request, reply) => {
    app.log.error('Session lookup storage failure');
    return reply.code(500).send(ERRORS[500]);
  });
  app.get(
    '/_platform/api/session',
    { schema: { summary: 'Read the current session account', response: RESPONSE } },
    (request, reply) => {
      const user = current(request);
      if (user === null) return reply.code(401).send(ERRORS[401]);
      return { email: user.email, role: user.role };
    },
  );
  done();
};

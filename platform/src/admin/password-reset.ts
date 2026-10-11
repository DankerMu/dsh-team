import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import {
  deleteUserSessions,
  getSessionUser,
  hashPassword,
  PasswordPolicyError,
  readSessionCookie,
} from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';

const ERRORS = {
  400: ['Bad Request', 'Invalid password reset request'],
  401: ['Unauthorized', 'Unauthorized'],
  403: ['Forbidden', 'Forbidden'],
  404: ['Not Found', 'Account not found'],
  413: ['Payload Too Large', 'Request body too large'],
  415: ['Unsupported Media Type', 'JSON request body required'],
  500: ['Internal Server Error', 'Internal Server Error'],
} as const;
class ResetRejection extends Error {
  readonly code: 400 | 401 | 403 | 404;
  constructor(code: 400 | 401 | 403 | 404) {
    super(ERRORS[code][1]);
    this.code = code;
  }
}

export const passwordResetRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
}> = (app, { database, resolveSourceAddress }, done) => {
  const authorize = (request: FastifyRequest, now: number) => {
    const token = readSessionCookie(request.headers.cookie);
    const actor = token === null ? null : getSessionUser(database, token, now, false);
    if (actor === null) throw new ResetRejection(401);
    if (actor.role !== 'admin') throw new ResetRejection(403);
    return actor;
  };
  const commit = database.transaction((request: FastifyRequest, userId: string, hash: string) => {
    const now = Date.now();
    const actor = authorize(request, now);
    const target = database
      .prepare<[string], { email: string }>('SELECT email FROM users WHERE id=?')
      .get(userId);
    if (target === undefined) throw new ResetRejection(404);
    database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, userId);
    deleteUserSessions(database, userId);
    recordAuditEvent(database, {
      type: 'password.reset',
      createdAt: now,
      actorEmail: actor.email,
      targetEmail: target.email,
      target: userId,
      sourceAddress: resolveSourceAddress(request),
    });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const code =
      error instanceof PasswordPolicyError
        ? 400
        : error instanceof ResetRejection
          ? error.code
          : status === 400 || status === 413 || status === 415
            ? status
            : 500;
    if (code === 500) app.log.error('Administrator password reset failure');
    return reply.code(code).send({
      statusCode: code,
      error: ERRORS[code][0],
      message: error instanceof PasswordPolicyError ? error.message : ERRORS[code][1],
    });
  });
  app.put<{ Params: { userId: string }; Body: unknown }>(
    '/_platform/api/admin/users/:userId/password',
    {
      validatorCompiler: () => (value: unknown) => ({ value }),
      schema: {
        summary: 'Reset an account password and revoke all its platform sessions',
        params: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: { type: 'string', pattern: '^[a-z0-9]{12}$' } },
        },
        body: {
          type: 'object',
          required: ['newPassword'],
          additionalProperties: false,
          properties: { newPassword: { type: 'string', minLength: 6, maxLength: 256 } },
        },
        response: {
          204: { type: 'null' },
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          413: ERROR_SCHEMA,
          415: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const body = request.body;
      if (
        !/^[a-z0-9]{12}$/.test(userId) ||
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('newPassword' in body) ||
        typeof body.newPassword !== 'string'
      )
        throw new ResetRejection(400);
      authorize(request, Date.now());
      const hash = await hashPassword(body.newPassword);
      commit.immediate(request, userId, hash);
      await app.disconnectUserConnections(userId);
      return reply.code(204).send();
    },
  );
  done();
};

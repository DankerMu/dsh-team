import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA, isPlainObject, rejectInvalidBody } from './credentials.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { ORIGIN_HEADERS_SCHEMA } from './request-guard.ts';
import { formatSessionCookie, readSessionCookie } from './session-cookie.ts';
import { createSession, deleteUserSessions, getSessionUser } from './session.ts';
import type { SourceAddressResolver } from './source-address.ts';

const SELECT_PASSWORD = 'SELECT password_hash FROM users WHERE id = ?';
const UPDATE_PASSWORD = 'UPDATE users SET password_hash = ? WHERE id = ?';
const UNAUTHORIZED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Unauthorized',
} as const;
const INCORRECT_PASSWORD = { ...UNAUTHORIZED, message: 'Current password is incorrect' };
const BODY_SCHEMA = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string' },
    newPassword: { type: 'string', minLength: 6, maxLength: 256 },
  },
} as const;

interface PasswordChangeOptions extends FastifyPluginOptions {
  database: DatabaseHandle;
  cookieSecure: boolean;
  resolveSourceAddress: SourceAddressResolver;
}

interface PasswordChangeBody {
  currentPassword: string;
  newPassword: string;
}

interface PasswordRow {
  password_hash: string;
}

/** Registers `POST /_platform/api/change-password`. */
export const passwordChangeRoutes: FastifyPluginCallback<PasswordChangeOptions> = (
  app,
  options,
  done,
) => {
  try {
    const database = options.database;
    const selectPassword = database.prepare<[string], PasswordRow>(SELECT_PASSWORD);
    const updatePassword = database.prepare(UPDATE_PASSWORD);
    const persistChange = database.transaction(
      (
        token: string,
        userId: string,
        verifiedHash: string,
        replacementHash: string,
        sourceAddress: string,
      ): string | null => {
        const now = Date.now();
        const identity = getSessionUser(database, token, now, false);
        if (identity?.id !== userId || selectPassword.get(userId)?.password_hash !== verifiedHash) {
          return null;
        }
        updatePassword.run(replacementHash, userId);
        deleteUserSessions(database, userId);
        const replacementToken = createSession(database, userId, now);
        recordAuditEvent(database, {
          type: 'password.changed',
          createdAt: now,
          actorEmail: identity.email,
          targetEmail: identity.email,
          target: userId,
          sourceAddress,
        });
        return replacementToken;
      },
    );

    app.post<{ Body: PasswordChangeBody }>(
      '/_platform/api/change-password',
      {
        schema: {
          summary: 'Change the password and replace all platform sessions',
          headers: ORIGIN_HEADERS_SCHEMA,
          body: BODY_SCHEMA,
          response: {
            204: { type: 'null' },
            400: ERROR_RESPONSE_SCHEMA,
            401: ERROR_RESPONSE_SCHEMA,
            403: ERROR_RESPONSE_SCHEMA,
            415: ERROR_RESPONSE_SCHEMA,
            500: ERROR_RESPONSE_SCHEMA,
          },
        },
        preValidation: (request, reply, next) => {
          const body: unknown = request.body;
          if (
            !isPlainObject(body) ||
            typeof body.currentPassword !== 'string' ||
            typeof body.newPassword !== 'string'
          ) {
            rejectInvalidBody(reply, 'Invalid password change body');
            return;
          }
          next();
        },
      },
      async (request, reply) => {
        const token = readSessionCookie(request.headers.cookie);
        const identity = token === null ? null : getSessionUser(database, token, Date.now(), false);
        const password = identity === null ? undefined : selectPassword.get(identity.id);
        if (token === null || identity === null || password === undefined) {
          return reply.code(401).send(UNAUTHORIZED);
        }
        const { currentPassword, newPassword } = request.body;
        if (!(await verifyPassword(currentPassword, password.password_hash))) {
          return reply.code(401).send(INCORRECT_PASSWORD);
        }
        const replacementHash = await hashPassword(newPassword);
        const replacementToken = persistChange(
          token,
          identity.id,
          password.password_hash,
          replacementHash,
          options.resolveSourceAddress(request),
        );
        if (replacementToken === null) {
          return reply.code(401).send(UNAUTHORIZED);
        }
        reply.header('set-cookie', formatSessionCookie(replacementToken, options.cookieSecure));
        return reply.code(204).send();
      },
    );
  } catch (error) {
    // catch bindings are unknown; Fastify done() requires Error.
    done(error as Error);
    return;
  }
  done();
};

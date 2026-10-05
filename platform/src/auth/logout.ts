import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA } from './credentials.ts';
import { formatSessionCookie, readSessionCookie } from './session-cookie.ts';
import { deleteSession, getSessionUser } from './session.ts';

const UNAUTHORIZED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: 'Unauthorized',
} as const;

interface LogoutOptions extends FastifyPluginOptions {
  database: DatabaseHandle;
  cookieSecure: boolean;
}

interface SessionIdentity {
  id: string;
  email: string;
  role: 'admin' | 'employee';
}

/** Registers `POST /_platform/api/logout`. */
export const logoutRoutes: FastifyPluginCallback<LogoutOptions> = (app, options, done) => {
  try {
    const persistLogout = options.database.transaction(
      (cookie: string | undefined, now: number, sourceAddress: string): SessionIdentity | null => {
        const token = readSessionCookie(cookie);
        if (token === null) {
          return null;
        }
        const identity = getSessionUser(options.database, token, now);
        if (identity === null) {
          return null;
        }
        deleteSession(options.database, token);
        recordAuditEvent(options.database, {
          type: 'logout.succeeded',
          createdAt: now,
          actorEmail: identity.email,
          targetEmail: identity.email,
          target: identity.id,
          sourceAddress,
        });
        return identity;
      },
    );

    app.post(
      '/_platform/api/logout',
      {
        schema: {
          summary: 'Log out of the current platform session',
          response: {
            204: { type: 'null' },
            401: ERROR_RESPONSE_SCHEMA,
            500: ERROR_RESPONSE_SCHEMA,
          },
        },
      },
      (request, reply) => {
        const cookie = request.headers.cookie;
        const persisted = persistLogout(
          typeof cookie === 'string' ? cookie : undefined,
          Date.now(),
          request.ip,
        );
        if (persisted === null) {
          return reply.code(401).send(UNAUTHORIZED);
        }
        reply.header('set-cookie', formatSessionCookie(null, options.cookieSecure));
        return reply.code(204).send();
      },
    );
  } catch (error) {
    // catch bindings are unknown; Fastify done() requires Error.
    const originalError = error as Error;
    done(originalError);
    return;
  }
  done();
};

import type { FastifyPluginAsync, FastifyPluginOptions } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA, rejectInvalidCredentialBody } from './credentials.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { formatSessionCookie } from './session-cookie.ts';
import { createSession } from './session.ts';
import type { SourceAddressResolver } from './source-address.ts';

const SELECT_USER_BY_EMAIL =
  'SELECT id, email, password_hash, role, status FROM users WHERE email = ?';
const SELECT_USER_BY_ID = 'SELECT id, email, password_hash, role, status FROM users WHERE id = ?';
const INVALID_BODY = 'Invalid login body';
const INVALID_CREDENTIALS = 'Invalid email or password';
const ACCOUNT_DISABLED = 'Account is disabled';
const DUMMY_PASSWORD = 'dummy-password-hash';

const LOGIN_BODY_SCHEMA = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string' },
    password: { type: 'string' },
  },
} as const;

const LOGIN_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['id', 'email', 'role'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'employee'] },
  },
} as const;

interface LoginOptions extends FastifyPluginOptions {
  database: DatabaseHandle;
  cookieSecure: boolean;
  resolveSourceAddress: SourceAddressResolver;
}

interface LoginBody {
  email: string;
  password: string;
}

interface LoginUserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'employee';
  status: 'active' | 'disabled';
}

type PersistLoginResult =
  | { outcome: 'invalid' }
  | { outcome: 'disabled' }
  | { outcome: 'success'; id: string; email: string; role: 'admin' | 'employee'; token: string };

/** Registers `POST /_platform/api/login`. */
export const loginRoutes: FastifyPluginAsync<LoginOptions> = async (app, options) => {
  const dummyHash = await hashPassword(DUMMY_PASSWORD);
  const selectUserByEmail = options.database.prepare<[string], LoginUserRow>(SELECT_USER_BY_EMAIL);
  const selectUserById = options.database.prepare<[string], LoginUserRow>(SELECT_USER_BY_ID);
  const persistLogin = options.database.transaction(
    (
      accountId: string,
      verifiedPasswordHash: string,
      attemptedEmail: string,
      now: number,
      sourceAddress: string,
    ): PersistLoginResult => {
      const current = selectUserById.get(accountId);
      if (current?.password_hash !== verifiedPasswordHash) {
        recordAuditEvent(options.database, {
          type: 'login.failed',
          createdAt: now,
          actorEmail: attemptedEmail,
          sourceAddress,
        });
        return { outcome: 'invalid' };
      }
      if (current.status === 'disabled') {
        recordAuditEvent(options.database, {
          type: 'login.failed',
          createdAt: now,
          actorEmail: attemptedEmail,
          sourceAddress,
        });
        return { outcome: 'disabled' };
      }
      const token = createSession(options.database, current.id, now);
      recordAuditEvent(options.database, {
        type: 'login.succeeded',
        createdAt: now,
        actorEmail: current.email,
        targetEmail: current.email,
        target: current.id,
        sourceAddress,
      });
      return {
        outcome: 'success',
        id: current.id,
        email: current.email,
        role: current.role,
        token,
      };
    },
  );

  app.post<{ Body: LoginBody }>(
    '/_platform/api/login',
    {
      schema: {
        summary: 'Log in with email and password',
        body: LOGIN_BODY_SCHEMA,
        response: {
          200: LOGIN_SUCCESS_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          500: ERROR_RESPONSE_SCHEMA,
        },
      },
      preValidation: rejectInvalidCredentialBody(INVALID_BODY),
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const sourceAddress = options.resolveSourceAddress(request);
      const user = selectUserByEmail.get(email);
      const matched = await verifyPassword(password, user?.password_hash ?? dummyHash);
      if (user === undefined || !matched) {
        recordAuditEvent(options.database, {
          type: 'login.failed',
          createdAt: Date.now(),
          actorEmail: email,
          sourceAddress,
        });
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: INVALID_CREDENTIALS,
        });
      }
      const persisted = persistLogin(user.id, user.password_hash, email, Date.now(), sourceAddress);
      if (persisted.outcome === 'invalid') {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: INVALID_CREDENTIALS,
        });
      }
      if (persisted.outcome === 'disabled') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: ACCOUNT_DISABLED,
        });
      }
      reply.header('set-cookie', formatSessionCookie(persisted.token, options.cookieSecure));
      return reply.code(200).send({
        id: persisted.id,
        email: persisted.email,
        role: persisted.role,
      });
    },
  );
};

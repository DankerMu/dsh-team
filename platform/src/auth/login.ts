import type { FastifyPluginAsync, FastifyPluginOptions } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA, rejectInvalidCredentialBody } from './credentials.ts';
import { createLoginFailureLimiter } from './login-throttle.ts';
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
const TOO_MANY_LOGIN_ATTEMPTS = 'Too many login attempts';
const DUMMY_PASSWORD = 'dummy-password-hash';
const UNAUTHORIZED = {
  statusCode: 401,
  error: 'Unauthorized',
  message: INVALID_CREDENTIALS,
} as const;
const FORBIDDEN = {
  statusCode: 403,
  error: 'Forbidden',
  message: ACCOUNT_DISABLED,
} as const;
const TOO_MANY_REQUESTS = {
  statusCode: 429,
  error: 'Too Many Requests',
  message: TOO_MANY_LOGIN_ATTEMPTS,
} as const;

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

function recordFailedLogin(
  database: DatabaseHandle,
  email: string,
  sourceAddress: string,
  now: number,
): void {
  recordAuditEvent(database, {
    type: 'login.failed',
    createdAt: now,
    actorEmail: email,
    sourceAddress,
  });
}

/** Registers `POST /_platform/api/login`. */
export const loginRoutes: FastifyPluginAsync<LoginOptions> = async (app, options) => {
  const dummyHash = await hashPassword(DUMMY_PASSWORD);
  const limiter = createLoginFailureLimiter();
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
        recordFailedLogin(options.database, attemptedEmail, sourceAddress, now);
        return { outcome: 'invalid' };
      }
      if (current.status === 'disabled') {
        recordFailedLogin(options.database, attemptedEmail, sourceAddress, now);
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
          429: ERROR_RESPONSE_SCHEMA,
          500: ERROR_RESPONSE_SCHEMA,
        },
      },
      preValidation: rejectInvalidCredentialBody(INVALID_BODY),
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const sourceAddress = options.resolveSourceAddress(request);
      const beforeVerify = Date.now();
      if (limiter.isBlocked(email, sourceAddress, beforeVerify)) {
        recordFailedLogin(options.database, email, sourceAddress, beforeVerify);
        return reply.code(429).send(TOO_MANY_REQUESTS);
      }
      const user = selectUserByEmail.get(email);
      const matched = await verifyPassword(password, user?.password_hash ?? dummyHash);
      const now = Date.now();
      if (limiter.isBlocked(email, sourceAddress, now)) {
        recordFailedLogin(options.database, email, sourceAddress, now);
        return reply.code(429).send(TOO_MANY_REQUESTS);
      }
      if (user === undefined || !matched) {
        recordFailedLogin(options.database, email, sourceAddress, now);
        limiter.recordFailure(email, sourceAddress, now);
        return reply.code(401).send(UNAUTHORIZED);
      }
      const persisted = persistLogin(user.id, user.password_hash, email, now, sourceAddress);
      if (persisted.outcome === 'invalid' || persisted.outcome === 'disabled') {
        limiter.recordFailure(email, sourceAddress, Date.now());
        if (persisted.outcome === 'invalid') {
          return reply.code(401).send(UNAUTHORIZED);
        }
        return reply.code(403).send(FORBIDDEN);
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

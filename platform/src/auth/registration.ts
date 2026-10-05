import { randomInt } from 'node:crypto';
import type { FastifyPluginCallback, FastifyPluginOptions } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_RESPONSE_SCHEMA, rejectInvalidCredentialBody } from './credentials.ts';
import { hashPassword } from './password.ts';
import { formatSessionCookie } from './session-cookie.ts';
import { createSession } from './session.ts';
import type { SourceAddressResolver } from './source-address.ts';

const USER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const USER_ID_LENGTH = 12;
const INSERT_USER =
  "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'employee', 'active', ?) ON CONFLICT (email) DO NOTHING";
const INVALID_BODY = 'Invalid registration body';

const REGISTER_BODY_SCHEMA = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string' },
    password: { type: 'string', minLength: 6, maxLength: 256 },
  },
} as const;

const REGISTER_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['id', 'email', 'role'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['employee'] },
  },
} as const;

interface RegistrationOptions extends FastifyPluginOptions {
  database: DatabaseHandle;
  cookieSecure: boolean;
  resolveSourceAddress: SourceAddressResolver;
}

interface RegistrationBody {
  email: string;
  password: string;
}

interface InsertUserStatement {
  run(id: string, email: string, passwordHash: string, createdAt: number): { changes: number };
}

function generateUserId(): string {
  let id = '';
  for (let index = 0; index < USER_ID_LENGTH; index += 1) {
    id += USER_ID_ALPHABET.charAt(randomInt(USER_ID_ALPHABET.length));
  }
  return id;
}

/** Registers `POST /_platform/api/register`. */
export const registrationRoutes: FastifyPluginCallback<RegistrationOptions> = (
  app,
  options,
  done,
) => {
  let insertUser: InsertUserStatement;
  try {
    insertUser = options.database.prepare(INSERT_USER);
  } catch (error) {
    // better-sqlite3 prepare throws SqliteError, an Error; catch bindings are unknown.
    const originalError = error as Error;
    done(originalError);
    return;
  }
  const persistRegistration = options.database.transaction(
    (
      id: string,
      email: string,
      passwordHash: string,
      now: number,
      sourceAddress: string,
    ): string | null => {
      const inserted = insertUser.run(id, email, passwordHash, now);
      if (inserted.changes === 0) {
        return null;
      }
      const token = createSession(options.database, id, now);
      recordAuditEvent(options.database, {
        type: 'account.registered',
        createdAt: now,
        actorEmail: email,
        targetEmail: email,
        target: id,
        sourceAddress,
      });
      return token;
    },
  );
  app.post<{ Body: RegistrationBody }>(
    '/_platform/api/register',
    {
      schema: {
        summary: 'Register an employee account',
        body: REGISTER_BODY_SCHEMA,
        response: {
          201: REGISTER_SUCCESS_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          500: ERROR_RESPONSE_SCHEMA,
        },
      },
      preValidation: rejectInvalidCredentialBody(INVALID_BODY),
    },
    async (request, reply) => {
      const { email } = request.body;
      const id = generateUserId();
      const passwordHash = await hashPassword(request.body.password);
      const now = Date.now();
      const token = persistRegistration(
        id,
        email,
        passwordHash,
        now,
        options.resolveSourceAddress(request),
      );
      if (token === null) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Email already registered',
        });
      }
      reply.header('set-cookie', formatSessionCookie(token, options.cookieSecure));
      return reply.code(201).send({ id, email, role: 'employee' as const });
    },
  );
  done();
};

import type { FastifyPluginCallback } from 'fastify';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import { modelConfigRoutes } from './model-config.ts';
import { runtimeConfigRoutes } from './runtime-config.ts';
import { accountStatusRoutes } from './account-status.ts';
import { passwordResetRoutes } from './password-reset.ts';
import { instanceRestartRoutes } from './instance-restart.ts';
import type { InstanceService } from '../orchestrator/index.ts';
import type { DatabaseHandle } from '../db/index.ts';

interface AccountQuery {
  page: number;
  pageSize: number;
  search?: string;
}
interface AccountRow {
  id: string;
  email: string;
  role: 'admin' | 'employee';
  status: 'active' | 'disabled';
  createdAt: number;
}
interface InstanceRow {
  userId: string;
  email: string;
  status: 'not-created' | 'stopped' | 'starting' | 'running' | 'error';
  lastStartedAt: number | null;
  lastActivityAt: number | null;
  lastError: string | null;
}
const ERRORS = {
  400: { statusCode: 400, error: 'Bad Request', message: 'Invalid pagination' },
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
} as const;
const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'email', 'role', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'employee'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
    createdAt: { type: 'integer' },
  },
} as const;
const INSTANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'email', 'status', 'lastStartedAt', 'lastActivityAt', 'lastError'],
  properties: {
    userId: { type: 'string' },
    email: { type: 'string' },
    status: { type: 'string', enum: ['not-created', 'stopped', 'starting', 'running', 'error'] },
    lastStartedAt: { type: ['integer', 'null'] },
    lastActivityAt: { type: ['integer', 'null'] },
    lastError: { type: ['string', 'null'] },
  },
} as const;
const ACCOUNT_FILTER = ' FROM users WHERE instr(email, ?) > 0';

export const adminRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
  subnetPool: string;
  service?: InstanceService;
}> = (app, { database, resolveSourceAddress, subnetPool, service }, done) => {
  app.addHook('onRequest', (request, reply, next) => {
    try {
      const token = readSessionCookie(request.headers.cookie);
      const user = token === null ? null : getSessionUser(database, token, Date.now());
      if (user === null) {
        void reply.code(401).send(ERRORS[401]);
        return;
      }
      if (user.role !== 'admin') {
        void reply.code(403).send(ERRORS[403]);
        return;
      }
    } catch {
      app.log.error('Administrator authorization storage failure');
      void reply.code(500).send(ERRORS[500]);
      return;
    }
    next();
  });
  const list = database.transaction((search: string, pageSize: number, offset: number) => {
    const count = database
      .prepare<[string], { total: number }>('SELECT COUNT(*) AS total' + ACCOUNT_FILTER)
      .get(search);
    if (count === undefined) throw new Error('Missing account count');
    const items = database
      .prepare<[string, number, number], AccountRow>(
        'SELECT id, email, role, status, created_at AS createdAt' +
          ACCOUNT_FILTER +
          ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      )
      .all(search, pageSize, offset);
    return { items, total: count.total };
  });
  app.get<{ Querystring: AccountQuery }>(
    '/_platform/api/admin/users',
    {
      schema: {
        summary: 'List accounts as an administrator',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string', maxLength: 254 },
            page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'page', 'pageSize', 'total'],
            properties: {
              items: { type: 'array', items: ACCOUNT_SCHEMA },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              total: { type: 'integer' },
            },
          },
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) => {
      const { page, pageSize, search = '' } = request.query;
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset)) return reply.code(400).send(ERRORS[400]);
      try {
        return { ...list(search.trim().toLowerCase(), pageSize, offset), page, pageSize };
      } catch {
        app.log.error('Administrator account query storage failure');
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
  app.get(
    '/_platform/api/admin/instances',
    {
      schema: {
        summary: 'List persisted instance states as an administrator',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: INSTANCE_SCHEMA } },
          },
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    (_request, reply) => {
      try {
        const items = database
          .prepare<[], InstanceRow>(
            `SELECT users.id AS userId, users.email AS email,
              COALESCE(instances.status, 'not-created') AS status,
              instances.last_started_at AS lastStartedAt,
              instances.last_activity_at AS lastActivityAt, instances.last_error AS lastError
            FROM users LEFT JOIN instances ON instances.user_id = users.id
            ORDER BY users.created_at DESC, users.id DESC`,
          )
          .all();
        return { items };
      } catch {
        app.log.error('Administrator instance query storage failure');
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
  app.register(modelConfigRoutes, { database, resolveSourceAddress });
  app.register(runtimeConfigRoutes, { database, resolveSourceAddress, subnetPool });
  app.register(passwordResetRoutes, { database, resolveSourceAddress });
  const pending = new Set<string>();
  app.register(accountStatusRoutes, {
    database,
    resolveSourceAddress,
    pending,
    ...(service === undefined ? {} : { service }),
  });
  app.register(instanceRestartRoutes, {
    database,
    resolveSourceAddress,
    pending,
    ...(service === undefined ? {} : { service }),
  });
  done();
};

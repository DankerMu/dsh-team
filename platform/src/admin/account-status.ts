import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import { deleteUserSessions, getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { InstanceService } from '../orchestrator/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';

type AccountStatus = 'active' | 'disabled';
interface Target {
  id: string;
  email: string;
  role: 'admin' | 'employee';
  status: AccountStatus;
}
const ERRORS = {
  400: { statusCode: 400, error: 'Bad Request', message: 'Invalid account status request' },
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  404: { statusCode: 404, error: 'Not Found', message: 'Account not found' },
  409: { statusCode: 409, error: 'Conflict', message: 'Account status operation in progress' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  503: { statusCode: 503, error: 'Service Unavailable', message: 'Instance service unavailable' },
} as const;
class StatusRejection extends Error {
  readonly status: 401 | 403 | 404 | 409;
  constructor(status: 401 | 403 | 404 | 409, message: string = ERRORS[status].message) {
    super(message);
    this.status = status;
  }
}
function requestedStatus(body: unknown): AccountStatus | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  if (Object.keys(body).length !== 1 || !('status' in body)) return undefined;
  return body.status === 'active' || body.status === 'disabled' ? body.status : undefined;
}

export const accountStatusRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
  pending: Set<string>;
  service?: InstanceService;
}> = (app, { database, resolveSourceAddress, service, pending }, done) => {
  function authorize(request: FastifyRequest, now: number) {
    const token = readSessionCookie(request.headers.cookie);
    const actor = token === null ? null : getSessionUser(database, token, now, false);
    if (actor === null) throw new StatusRejection(401);
    if (actor.role !== 'admin') throw new StatusRejection(403);
    return actor;
  }
  const commit = database.transaction(
    (request: FastifyRequest, userId: string, status: AccountStatus, apply: boolean) => {
      const now = Date.now();
      const actor = authorize(request, now);
      const target = database
        .prepare<[string], Target>('SELECT id,email,role,status FROM users WHERE id=?')
        .get(userId);
      if (target === undefined) throw new StatusRejection(404);
      if (status === 'disabled') {
        if (actor.id === userId) throw new StatusRejection(409, 'Cannot disable your own account');
        if (target.role === 'admin' && target.status === 'active') {
          const other = database
            .prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' AND id<>?")
            .get(userId);
          if (other === undefined)
            throw new StatusRejection(409, 'Cannot disable the last active administrator');
        }
      }
      if (target.status === status || !apply) return target.status;
      database.prepare('UPDATE users SET status=? WHERE id=?').run(status, userId);
      if (status === 'disabled') deleteUserSessions(database, userId);
      recordAuditEvent(database, {
        type: status === 'disabled' ? 'account.disabled' : 'account.enabled',
        createdAt: now,
        actorEmail: actor.email,
        targetEmail: target.email,
        target: userId,
        sourceAddress: resolveSourceAddress(request),
      });
      return status;
    },
  );
  async function retire(userId: string, lifecycle: InstanceService): Promise<void> {
    let disconnectFailed = false;
    try {
      await app.disconnectUserConnections(userId);
    } catch {
      // Retirement still follows the attempted disconnect; durable revocation is never undone.
      disconnectFailed = true;
    }
    await lifecycle.stop(userId, 'disabled');
    if (disconnectFailed) throw new Error('Account connection cleanup failed');
  }
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415)
      return reply.code(status).send(ERRORS[status]);
    app.log.error('Administrator account status operation failure');
    return reply.code(500).send(ERRORS[500]);
  });
  app.put<{ Params: { userId: string }; Body: unknown }>(
    '/_platform/api/admin/users/:userId/status',
    {
      validatorCompiler: () => (value: unknown) => ({ value }),
      schema: {
        summary: 'Disable or enable an account as an administrator',
        params: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: { type: 'string', pattern: '^[a-z0-9]{12}$' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['active', 'disabled'] } },
        },
        response: {
          204: { type: 'null' },
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          409: ERROR_SCHEMA,
          413: ERROR_SCHEMA,
          415: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      const status = requestedStatus(request.body);
      if (!/^[a-z0-9]{12}$/.test(userId) || status === undefined)
        return reply.code(400).send(ERRORS[400]);
      if (pending.has(userId)) return reply.code(409).send(ERRORS[409]);
      pending.add(userId);
      try {
        // Offline active→active is an authorized no-op; mutations require lifecycle ownership.
        const current = commit.immediate(
          request,
          userId,
          status,
          status === 'disabled' && service !== undefined,
        );
        if (status === 'active' && current === 'active') return await reply.code(204).send();
        if (service === undefined) return await reply.code(503).send(ERRORS[503]);
        if (status === 'disabled') await retire(userId, service);
        else if (current === 'disabled') {
          await retire(userId, service);
          commit.immediate(request, userId, status, true);
        }
        return await reply.code(204).send();
      } catch (error) {
        if (error instanceof StatusRejection)
          return await reply
            .code(error.status)
            .send({ ...ERRORS[error.status], message: error.message });
        app.log.error('Administrator account status operation failure');
        return await reply.code(500).send(ERRORS[500]);
      } finally {
        // Accepted teardown belongs to the operation, not to the HTTP client's lifetime.
        pending.delete(userId);
      }
    },
  );
  done();
};

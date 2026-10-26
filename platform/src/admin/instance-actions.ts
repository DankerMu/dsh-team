import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { InstanceService } from '../orchestrator/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';
import { ADMIN_ERRORS, EMPTY_BODY_SCHEMA, emptyBodyPolicy } from './empty-body.ts';

interface Target {
  userId: string;
  email: string;
  accountStatus: 'active' | 'disabled';
  instanceStatus: 'running' | 'stopped' | 'starting' | 'error' | null;
}
const EMPTY_BODY = emptyBodyPolicy('Empty instance action body required');
const ERRORS = {
  ...ADMIN_ERRORS,
  400: EMPTY_BODY.invalid,
  404: { statusCode: 404, error: 'Not Found', message: 'Instance not found' },
  409: { statusCode: 409, error: 'Conflict', message: 'Instance action conflict' },
  503: { statusCode: 503, error: 'Service Unavailable', message: 'Instance service unavailable' },
} as const;
const RECEIPT = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'status', 'reason'],
  properties: {
    userId: { type: 'string' },
    status: {
      type: 'string',
      enum: ['running', 'stopped', 'starting', 'full', 'error', 'unconfigured'],
    },
    reason: {
      anyOf: [
        { type: 'null' },
        { type: 'string', enum: ['stopped', 'starting', 'full', 'error', 'unconfigured'] },
      ],
    },
  },
} as const;
const FAILURE_RESPONSES = {
  400: ERROR_SCHEMA,
  401: ERROR_SCHEMA,
  403: ERROR_SCHEMA,
  404: ERROR_SCHEMA,
  409: ERROR_SCHEMA,
  413: ERROR_SCHEMA,
  415: ERROR_SCHEMA,
  500: ERROR_SCHEMA,
  503: ERROR_SCHEMA,
};
class InstanceActionRejection extends Error {
  readonly status: 401 | 403 | 404 | 409 | 503;
  constructor(status: 401 | 403 | 404 | 409 | 503) {
    super(ERRORS[status].message);
    this.status = status;
  }
}

export const instanceActionRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
  pending: Set<string>;
  service?: InstanceService;
}> = (app, { database, resolveSourceAddress, pending, service }, done) => {
  const select = database.prepare<[string], Target>(
    `SELECT users.id AS userId, users.email, users.status AS accountStatus,
      instances.status AS instanceStatus FROM users
      LEFT JOIN instances ON instances.user_id=users.id WHERE users.id=?`,
  );
  function actor(request: FastifyRequest) {
    const token = readSessionCookie(request.headers.cookie);
    const current = token === null ? null : getSessionUser(database, token, Date.now(), false);
    if (current === null) throw new InstanceActionRejection(401);
    if (current.role !== 'admin') throw new InstanceActionRejection(403);
    return current;
  }
  function target(userId: string): Target {
    const current = select.get(userId);
    if (current?.instanceStatus == null) throw new InstanceActionRejection(404);
    if (current.accountStatus !== 'active') throw new InstanceActionRejection(409);
    return current;
  }
  function check(request: FastifyRequest, userId: string) {
    return { actor: actor(request), target: target(userId) };
  }
  async function restart(request: FastifyRequest, userId: string, lifecycle: InstanceService) {
    check(request, userId);
    await app.disconnectUserConnections(userId);
    check(request, userId);
    await lifecycle.stop(userId, 'admin');
    const admission = check(request, userId);
    // No await or database mutation between current authority and synchronous service admission.
    const result = await lifecycle.start(userId);
    if (result.status === 'starting' || result.status === 'running') {
      recordAuditEvent(database, {
        type: 'instance.restarted',
        createdAt: Date.now(),
        actorEmail: admission.actor.email,
        targetEmail: admission.target.email,
        target: userId,
        sourceAddress: resolveSourceAddress(request),
      });
    }
    return { userId, status: result.status, reason: result.reason };
  }
  async function resetConfig(request: FastifyRequest, userId: string, lifecycle: InstanceService) {
    check(request, userId);
    await app.disconnectUserConnections(userId);
    let admission = check(request, userId);
    await lifecycle.resetConfig(userId, () => {
      admission = check(request, userId);
    });
    recordAuditEvent(database, {
      type: 'instance.config-reset',
      createdAt: Date.now(),
      actorEmail: admission.actor.email,
      targetEmail: admission.target.email,
      target: userId,
      sourceAddress: resolveSourceAddress(request),
    });
  }
  async function execute<Result>(
    request: FastifyRequest,
    userIds: string[],
    operation: (
      request: FastifyRequest,
      userId: string,
      lifecycle: InstanceService,
    ) => Promise<Result>,
  ): Promise<Result[]> {
    actor(request);
    if (userIds.length === 0) return [];
    // Validate and claim the whole captured set before any asynchronous or destructive operation.
    for (const userId of userIds) {
      const current = target(userId);
      if (
        pending.has(userId) ||
        current.instanceStatus === 'starting' ||
        service?.hasStartupWork(userId) === true
      )
        throw new InstanceActionRejection(409);
    }
    if (service === undefined) throw new InstanceActionRejection(503);
    for (const userId of userIds) pending.add(userId);
    try {
      const items: Result[] = [];
      for (const userId of userIds) items.push(await operation(request, userId, service));
      return items;
    } finally {
      // These claims outlive a disconnected HTTP client, but never own service lifecycle ordering.
      for (const userId of userIds) pending.delete(userId);
    }
  }
  function failure(error: unknown) {
    if (error instanceof InstanceActionRejection) return ERRORS[error.status];
    app.log.error('Administrator instance action failure');
    return ERRORS[500];
  }
  app.setErrorHandler(EMPTY_BODY.errorHandler(failure));
  for (const action of ['restart', 'reset-config'] as const) {
    app.post<{ Params: { userId: string }; Body: unknown }>(
      `/_platform/api/admin/instances/:userId/${action}`,
      {
        validatorCompiler: EMPTY_BODY.validatorCompiler,
        preValidation: EMPTY_BODY.preValidation,
        schema: {
          summary:
            action === 'restart'
              ? 'Restart an existing active account instance and return startup admission'
              : 'Restore an existing active account instance configuration without restarting',
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['userId'],
            properties: { userId: { type: 'string', pattern: '^[a-z0-9]{12}$' } },
          },
          body: EMPTY_BODY_SCHEMA,
          response: {
            ...(action === 'restart' ? { 200: RECEIPT } : { 204: { type: 'null' } }),
            ...FAILURE_RESPONSES,
          },
        },
      },
      async (request, reply) => {
        const { userId } = request.params;
        if (!/^[a-z0-9]{12}$/.test(userId)) return reply.code(400).send(ERRORS[400]);
        try {
          if (action === 'reset-config') {
            await execute(request, [userId], resetConfig);
            return await reply.code(204).send();
          }
          const items = await execute(request, [userId], restart);
          return items[0];
        } catch (error) {
          const response = failure(error);
          return reply.code(response.statusCode).send(response);
        }
      },
    );
  }
  app.post<{ Body: unknown }>(
    '/_platform/api/admin/instances/restart-running',
    {
      validatorCompiler: EMPTY_BODY.validatorCompiler,
      preValidation: EMPTY_BODY.preValidation,
      schema: {
        summary: 'Restart the once-captured running instance set and return startup admissions',
        body: EMPTY_BODY_SCHEMA,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: RECEIPT } },
          },
          ...FAILURE_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      try {
        actor(request);
        const selected = database
          .prepare<[], { userId: string }>(
            "SELECT user_id AS userId FROM instances WHERE status='running' ORDER BY user_id",
          )
          .all();
        return {
          items: await execute(
            request,
            selected.map(({ userId }) => userId),
            restart,
          ),
        };
      } catch (error) {
        const response = failure(error);
        return reply.code(response.statusCode).send(response);
      }
    },
  );
  done();
};

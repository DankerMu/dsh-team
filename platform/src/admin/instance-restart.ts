import type {
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
  HookHandlerDoneFunction,
} from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import type { InstanceService } from '../orchestrator/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';

interface Target {
  userId: string;
  email: string;
  accountStatus: 'active' | 'disabled';
  instanceStatus: 'running' | 'stopped' | 'starting' | 'error' | null;
}
const ERRORS = {
  400: { statusCode: 400, error: 'Bad Request', message: 'Empty instance restart body required' },
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  404: { statusCode: 404, error: 'Not Found', message: 'Instance not found' },
  409: { statusCode: 409, error: 'Conflict', message: 'Instance restart conflict' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
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
class RestartRejection extends Error {
  readonly status: 401 | 403 | 404 | 409 | 503;
  constructor(status: 401 | 403 | 404 | 409 | 503) {
    super(ERRORS[status].message);
    this.status = status;
  }
}
function validateBody(
  request: FastifyRequest,
  reply: FastifyReply,
  next: HookHandlerDoneFunction,
): void {
  const body: unknown = request.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    void reply.code(400).send(ERRORS[400]);
    return;
  }
  next();
}

export const instanceRestartRoutes: FastifyPluginCallback<{
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
    if (current === null) throw new RestartRejection(401);
    if (current.role !== 'admin') throw new RestartRejection(403);
    return current;
  }
  function target(userId: string): Target {
    const current = select.get(userId);
    if (current?.instanceStatus == null) throw new RestartRejection(404);
    if (current.accountStatus !== 'active') throw new RestartRejection(409);
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
  async function execute(request: FastifyRequest, userIds: string[]) {
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
        throw new RestartRejection(409);
    }
    if (service === undefined) throw new RestartRejection(503);
    for (const userId of userIds) pending.add(userId);
    try {
      const items = [];
      for (const userId of userIds) items.push(await restart(request, userId, service));
      return items;
    } finally {
      // These claims outlive a disconnected HTTP client, but never own service lifecycle ordering.
      for (const userId of userIds) pending.delete(userId);
    }
  }
  function failure(error: unknown) {
    if (error instanceof RestartRejection) return ERRORS[error.status];
    app.log.error('Administrator instance restart failure');
    return ERRORS[500];
  }
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415)
      return reply.code(status).send(ERRORS[status]);
    const response = failure(error);
    return reply.code(response.statusCode).send(response);
  });
  const body = { type: 'object', additionalProperties: false, properties: {} };
  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/_platform/api/admin/instances/:userId/restart',
    {
      validatorCompiler: () => (value: unknown) => ({ value }),
      preValidation: validateBody,
      schema: {
        summary: 'Restart an existing active account instance and return startup admission',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['userId'],
          properties: { userId: { type: 'string', pattern: '^[a-z0-9]{12}$' } },
        },
        body,
        response: { 200: RECEIPT, ...FAILURE_RESPONSES },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      if (!/^[a-z0-9]{12}$/.test(userId)) return reply.code(400).send(ERRORS[400]);
      try {
        const items = await execute(request, [userId]);
        return items[0];
      } catch (error) {
        const response = failure(error);
        return reply.code(response.statusCode).send(response);
      }
    },
  );
  app.post<{ Body: unknown }>(
    '/_platform/api/admin/instances/restart-running',
    {
      validatorCompiler: () => (value: unknown) => ({ value }),
      preValidation: validateBody,
      schema: {
        summary: 'Restart the once-captured running instance set and return startup admissions',
        body,
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

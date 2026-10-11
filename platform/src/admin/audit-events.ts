import type { FastifyPluginCallback } from 'fastify';
import { queryAuditEvents, validateStopReason } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { ERROR_SCHEMA } from './config-route.ts';

type AuditQuery = Parameters<typeof queryAuditEvents>[1];
const INVALID_QUERY = { statusCode: 400, error: 'Bad Request', message: 'Invalid audit query' };
const STORAGE_FAILURE = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const NULLABLE_STRING = { type: ['string', 'null'] } as const;
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'createdAt',
    'type',
    'actorEmail',
    'targetEmail',
    'target',
    'sourceAddress',
    'details',
  ],
  properties: {
    id: { type: 'integer' },
    createdAt: { type: 'integer' },
    type: { type: 'string' },
    actorEmail: NULLABLE_STRING,
    targetEmail: NULLABLE_STRING,
    target: NULLABLE_STRING,
    sourceAddress: NULLABLE_STRING,
    details: {
      type: 'object',
      additionalProperties: false,
      properties: { reason: { type: 'string', enum: ['idle', 'admin', 'disabled', 'error'] } },
    },
  },
} as const;
const TIME_SCHEMA = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

function projectDetails(value: unknown) {
  if (typeof value !== 'object' || value === null || !('reason' in value)) return {};
  validateStopReason(value.reason);
  return { reason: value.reason };
}

export const auditEventRoutes: FastifyPluginCallback<{ database: DatabaseHandle }> = (
  app,
  { database },
  done,
) => {
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400) return reply.code(400).send(INVALID_QUERY);
    app.log.error('Administrator audit query storage failure');
    return reply.code(500).send(STORAGE_FAILURE);
  });
  app.get<{ Querystring: AuditQuery }>(
    '/_platform/api/admin/audit-events',
    {
      schema: {
        summary: 'Query audit events as an administrator',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            eventType: { type: 'string', minLength: 1, maxLength: 128 },
            email: { type: 'string', maxLength: 254 },
            from: TIME_SCHEMA,
            to: TIME_SCHEMA,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'page', 'pageSize'],
            properties: {
              items: { type: 'array', items: ITEM_SCHEMA },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
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
      const { page, pageSize, email } = request.query;
      if (!Number.isSafeInteger((page - 1) * pageSize)) return reply.code(400).send(INVALID_QUERY);
      const rows = queryAuditEvents(database, {
        ...request.query,
        ...(email === undefined ? {} : { email: email.trim().toLowerCase() }),
      });
      const items = rows.map(
        ({ id, createdAt, type, actorEmail, targetEmail, target, sourceAddress, details }) => ({
          id,
          createdAt,
          type,
          actorEmail,
          targetEmail,
          target,
          sourceAddress,
          details: projectDetails(details),
        }),
      );
      return { items, page, pageSize };
    },
  );
  done();
};

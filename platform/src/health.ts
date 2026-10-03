import type { FastifyPluginCallback } from 'fastify';

const HEALTH_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['ok'] } },
} as const;

/** Registers `GET /healthz`, the liveness probe used by smoke tests and the orchestrator. */
export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get(
    '/healthz',
    {
      schema: {
        summary: 'Liveness probe',
        response: { 200: HEALTH_RESPONSE_SCHEMA },
      },
    },
    () => ({ status: 'ok' as const }),
  );
  done();
};

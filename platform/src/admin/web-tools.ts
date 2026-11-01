import type { FastifyPluginCallback } from 'fastify';
import { isPlainObject, registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['webToolsEnabled'],
  properties: { webToolsEnabled: { type: 'boolean' } },
} as const;

export const webToolsRoutes: FastifyPluginCallback<AdminConfigOptions> = (app, options, done) => {
  registerConfigRoute(app, options, {
    name: 'web-tools',
    path: '/_platform/api/admin/web-tools',
    auditType: 'web-tools.updated',
    bodySchema: SCHEMA,
    responseSchema: SCHEMA,
    invalidMessage: 'Invalid web tools setting; provide exactly { webToolsEnabled: boolean }',
    patch(body) {
      if (!isPlainObject(body) || Object.keys(body).join() !== 'webToolsEnabled') return null;
      const { webToolsEnabled } = body;
      if (typeof webToolsEnabled !== 'boolean') return null;
      return { webToolsEnabled };
    },
    project(settings) {
      return { webToolsEnabled: settings.webToolsEnabled };
    },
  });
  done();
};

import type { FastifyPluginCallback } from 'fastify';
import { REGISTRY_URL } from '../db/index.ts';
import { ClientConfigValidationError, isPlainObject, registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pluginRegistries', 'registryProbeEnabled'],
  properties: {
    pluginRegistries: {
      type: 'array',
      minItems: 1,
      description: 'First item is the install registry, the rest are fallbacks.',
      items: { type: 'string' },
    },
    registryProbeEnabled: { type: 'boolean' },
  },
} as const;

export const pluginSourcesRoutes: FastifyPluginCallback<AdminConfigOptions> = (
  app,
  options,
  done,
) => {
  registerConfigRoute(app, options, {
    name: 'plugin-sources',
    path: '/_platform/api/admin/plugin-sources',
    auditType: 'plugin-sources.updated',
    bodySchema: SCHEMA,
    responseSchema: SCHEMA,
    invalidMessage:
      'Invalid plugin sources; provide exactly { pluginRegistries: [http(s) URL, …], registryProbeEnabled: boolean } with at least one registry',
    patch(body) {
      if (
        !isPlainObject(body) ||
        Object.keys(body).sort().join() !== 'pluginRegistries,registryProbeEnabled'
      )
        return null;
      const { pluginRegistries, registryProbeEnabled } = body;
      if (typeof registryProbeEnabled !== 'boolean') return null;
      if (!Array.isArray(pluginRegistries) || pluginRegistries.length === 0) return null;
      // Array.isArray narrows to any[]; unknown[] keeps each item checked below.
      const items = pluginRegistries as unknown[];
      const index = items.findIndex((url) => typeof url !== 'string' || !REGISTRY_URL.test(url));
      // Registry URLs may carry userinfo credentials, so the message names only the index.
      if (index !== -1)
        throw new ClientConfigValidationError(
          `pluginRegistries[${String(index)}] must be an http(s) URL without whitespace`,
        );
      return { pluginRegistries: [...items], registryProbeEnabled };
    },
    project(settings) {
      return {
        pluginRegistries: [...settings.pluginRegistries],
        registryProbeEnabled: settings.registryProbeEnabled,
      };
    },
  });
  done();
};

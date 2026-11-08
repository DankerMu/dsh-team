import type { FastifyPluginCallback } from 'fastify';
import { isRagflowBaseUrl } from '../db/index.ts';
import { isPlainObject } from '../plain-object.ts';
import { registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const INPUT_FIELDS = ['baseURL', 'apiKey'];

export const ragflowConfigRoutes: FastifyPluginCallback<AdminConfigOptions> = (
  app,
  options,
  done,
) => {
  registerConfigRoute(app, options, {
    name: 'ragflow',
    path: '/_platform/api/admin/ragflow-config',
    auditType: 'ragflow-config.updated',
    // Contract documentation only: patch() and the settings layer own validation.
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['baseURL'],
      properties: {
        baseURL: { type: 'string', minLength: 1, maxLength: 2048 },
        apiKey: { type: 'string', minLength: 1 },
      },
    },
    responseSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['baseURL', 'apiKeyConfigured'],
      properties: { baseURL: { type: 'string' }, apiKeyConfigured: { type: 'boolean' } },
    },
    invalidMessage:
      'Invalid RAGFlow configuration; provide { baseURL: http(s) URL without credentials, query or fragment, apiKey?: non-blank string }',
    patch(body) {
      if (!isPlainObject(body) || Object.keys(body).some((key) => !INPUT_FIELDS.includes(key)))
        return null;
      const { baseURL, apiKey } = body;
      if (typeof baseURL !== 'string' || !isRagflowBaseUrl(baseURL)) return null;
      if (!Object.hasOwn(body, 'apiKey')) return { ragflowBaseUrl: baseURL };
      if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
      return { ragflowBaseUrl: baseURL, ragflowApiKey: apiKey };
    },
    project(settings) {
      return {
        baseURL: settings.ragflowBaseUrl,
        apiKeyConfigured: settings.ragflowApiKey.trim() !== '',
      };
    },
  });
  done();
};

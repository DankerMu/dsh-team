import type { FastifyPluginCallback } from 'fastify';
import type { Settings } from '../db/index.ts';
import { registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';
const PATH = '/_platform/api/admin/model-config';
const MODEL_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string' },
      contextWindow: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
  },
} as const;
const SAFE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseURL', 'apiKeyConfigured', 'models', 'defaultModel'],
  properties: {
    baseURL: { type: 'string' },
    apiKeyConfigured: { type: 'boolean' },
    models: MODEL_SCHEMA,
    defaultModel: { type: 'string' },
  },
} as const;
const INPUT_FIELDS = ['baseURL', 'apiKey', 'models', 'defaultModel'];

function project(settings: Settings) {
  return {
    baseURL: settings.modelBaseUrl,
    apiKeyConfigured: settings.modelApiKey.trim() !== '',
    models: settings.models,
    defaultModel: settings.defaultModel,
  };
}

export const modelConfigRoutes: FastifyPluginCallback<AdminConfigOptions> = (
  app,
  options,
  done,
) => {
  registerConfigRoute(app, options, {
    name: 'model',
    path: PATH,
    auditType: 'model-config.updated',
    invalidMessage: 'Invalid model configuration',
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['baseURL', 'models', 'defaultModel'],
      properties: {
        baseURL: { type: 'string', minLength: 1 },
        apiKey: { type: 'string', minLength: 1 },
        models: MODEL_SCHEMA,
        defaultModel: { type: 'string', minLength: 1 },
      },
    },
    responseSchema: SAFE_SCHEMA,
    project,
    patch(body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
      // Raw model entries remain unknown until the canonical settings parser validates them.
      const input = body as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => !INPUT_FIELDS.includes(key)) ||
        typeof input.baseURL !== 'string' ||
        input.baseURL.trim() === '' ||
        typeof input.defaultModel !== 'string' ||
        input.defaultModel.trim() === '' ||
        !Object.hasOwn(input, 'models') ||
        (Object.hasOwn(input, 'apiKey') &&
          (typeof input.apiKey !== 'string' || input.apiKey.trim() === ''))
      )
        return null;
      return {
        modelBaseUrl: input.baseURL,
        models: input.models,
        defaultModel: input.defaultModel,
        ...(Object.hasOwn(input, 'apiKey') ? { modelApiKey: input.apiKey } : {}),
      };
    },
  });
  done();
};

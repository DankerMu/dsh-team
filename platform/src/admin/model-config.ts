import type { FastifyPluginCallback } from 'fastify';
import type { Settings } from '../db/index.ts';
import { isPlainObject } from '../plain-object.ts';
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

function hasUnknownModelFields(models: unknown): boolean {
  if (!Array.isArray(models)) return false;
  const entries: readonly unknown[] = models;
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    for (const key in entry) {
      if (Object.hasOwn(entry, key) && !Object.hasOwn(MODEL_SCHEMA.items.properties, key)) {
        return true;
      }
    }
  }
  return false;
}

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
      if (!isPlainObject(body)) return null;
      if (
        Object.keys(body).some((key) => !INPUT_FIELDS.includes(key)) ||
        hasUnknownModelFields(body.models) ||
        typeof body.baseURL !== 'string' ||
        body.baseURL.trim() === '' ||
        typeof body.defaultModel !== 'string' ||
        body.defaultModel.trim() === '' ||
        !Object.hasOwn(body, 'models') ||
        (Object.hasOwn(body, 'apiKey') &&
          (typeof body.apiKey !== 'string' || body.apiKey.trim() === ''))
      )
        return null;
      return {
        modelBaseUrl: body.baseURL,
        models: body.models,
        defaultModel: body.defaultModel,
        ...(Object.hasOwn(body, 'apiKey') ? { modelApiKey: body.apiKey } : {}),
      };
    },
  });
  done();
};

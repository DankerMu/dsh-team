import type { FastifyPluginCallback } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import { readSettings, writeSettings, SettingsValidationError } from '../db/index.ts';
import type { DatabaseHandle, Settings } from '../db/index.ts';

interface ModelConfigOptions {
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
}
const PATH = '/_platform/api/admin/model-config';
const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
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
const RESPONSE_SCHEMA = {
  200: SAFE_SCHEMA,
  400: ERROR_SCHEMA,
  401: ERROR_SCHEMA,
  403: ERROR_SCHEMA,
  413: ERROR_SCHEMA,
  415: ERROR_SCHEMA,
  500: ERROR_SCHEMA,
};
const ERRORS = {
  400: { statusCode: 400, error: 'Bad Request', message: 'Invalid model configuration' },
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
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

export const modelConfigRoutes: FastifyPluginCallback<ModelConfigOptions> = (
  app,
  { database, resolveSourceAddress },
  done,
) => {
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415)
      return reply.code(status).send(ERRORS[status]);
    app.log.error('Administrator model configuration storage failure');
    return reply.code(500).send(ERRORS[500]);
  });
  app.get(
    PATH,
    {
      schema: { summary: 'Read administrator model configuration', response: RESPONSE_SCHEMA },
    },
    (_request, reply) => {
      try {
        return project(readSettings(database));
      } catch {
        app.log.error('Administrator model configuration storage failure');
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
  app.put<{ Body: unknown }>(
    PATH,
    {
      schema: {
        summary: 'Save administrator model configuration',
        body: {
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
        response: RESPONSE_SCHEMA,
      },
      // Preserve raw JSON types. The handler and canonical settings parser validate without AJV coercion.
      validatorCompiler: () => (value: unknown) => ({ value }),
    },
    (request, reply) => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        return reply.code(400).send(ERRORS[400]);
      // The raw JSON object is narrowed field by field; model entries stay unknown for the canonical parser.
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
        return reply.code(400).send(ERRORS[400]);
      try {
        const commit = database.transaction(() => {
          const now = Date.now();
          const token = readSessionCookie(request.headers.cookie);
          const actor = token === null ? null : getSessionUser(database, token, now, false);
          if (actor === null) return reply.code(401).send(ERRORS[401]);
          if (actor.role !== 'admin') return reply.code(403).send(ERRORS[403]);
          // Corrupt persisted fields are storage failures, not invalid submitted values.
          readSettings(database);
          try {
            writeSettings(database, {
              modelBaseUrl: input.baseURL,
              models: input.models,
              defaultModel: input.defaultModel,
              ...(Object.hasOwn(input, 'apiKey') ? { modelApiKey: input.apiKey } : {}),
            });
          } catch (error) {
            if (!(error instanceof SettingsValidationError)) throw error;
            return reply.code(400).send({ ...ERRORS[400], message: error.message });
          }
          recordAuditEvent(database, {
            type: 'model-config.updated',
            createdAt: now,
            actorEmail: actor.email,
            sourceAddress: resolveSourceAddress(request),
          });
          return project(readSettings(database));
        });
        return commit();
      } catch {
        app.log.error('Administrator model configuration storage failure');
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
  done();
};

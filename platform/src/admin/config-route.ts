import type { FastifyInstance, FastifySchema } from 'fastify';
import { recordAuditEvent } from '../audit/index.ts';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { SourceAddressResolver } from '../auth/index.ts';
import { readSettings, writeSettings, SettingsValidationError } from '../db/index.ts';
import type { DatabaseHandle, Settings } from '../db/index.ts';

export interface AdminConfigOptions {
  database: DatabaseHandle;
  resolveSourceAddress: SourceAddressResolver;
}
interface ConfigDescriptor {
  name: 'model' | 'runtime';
  path: string;
  auditType: 'model-config.updated' | 'runtime-config.updated';
  bodySchema: FastifySchema['body'];
  responseSchema: FastifySchema['body'];
  invalidMessage: string;
  validationGuidance?: string;
  patch(body: unknown): Record<string, unknown> | null;
  project(settings: Settings): Record<string, unknown>;
  validate?(settings: Settings): void;
}
const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
const ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  403: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
  413: { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' },
  415: { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
} as const;

class ClientConfigValidationError extends Error {}

/** Internal transport/commit boundary for administrator configuration descriptors. */
export function registerConfigRoute(
  app: FastifyInstance,
  { database, resolveSourceAddress }: AdminConfigOptions,
  descriptor: ConfigDescriptor,
): void {
  const invalid = { statusCode: 400, error: 'Bad Request', message: descriptor.invalidMessage };
  const response = {
    200: descriptor.responseSchema,
    400: ERROR_SCHEMA,
    401: ERROR_SCHEMA,
    403: ERROR_SCHEMA,
    413: ERROR_SCHEMA,
    415: ERROR_SCHEMA,
    500: ERROR_SCHEMA,
  };
  const storageFailure = `Administrator ${descriptor.name} configuration storage failure`;
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 400) return reply.code(400).send(invalid);
    if (status === 413 || status === 415) return reply.code(status).send(ERRORS[status]);
    app.log.error(storageFailure);
    return reply.code(500).send(ERRORS[500]);
  });
  app.get(
    descriptor.path,
    {
      schema: { summary: `Read administrator ${descriptor.name} configuration`, response },
    },
    (_request, reply) => {
      try {
        return descriptor.project(readSettings(database));
      } catch {
        app.log.error(storageFailure);
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
  app.put<{ Body: unknown }>(
    descriptor.path,
    {
      schema: {
        summary: `Save administrator ${descriptor.name} configuration`,
        body: descriptor.bodySchema,
        response,
      },
      // The descriptor checks the envelope; canonical settings validation owns raw value domains.
      validatorCompiler: () => (value: unknown) => ({ value }),
    },
    (request, reply) => {
      const patch = descriptor.patch(request.body);
      if (patch === null) return reply.code(400).send(invalid);
      try {
        const commit = database.transaction(() => {
          const now = Date.now();
          const token = readSessionCookie(request.headers.cookie);
          const actor = token === null ? null : getSessionUser(database, token, now, false);
          if (actor === null) return reply.code(401).send(ERRORS[401]);
          if (actor.role !== 'admin') return reply.code(403).send(ERRORS[403]);
          // Persisted corruption must escape the client-validation catch as a storage failure.
          readSettings(database);
          try {
            writeSettings(database, patch);
          } catch (error) {
            if (!(error instanceof SettingsValidationError)) throw error;
            throw new ClientConfigValidationError(error.message);
          }
          if (descriptor.validate !== undefined) {
            const settings = readSettings(database);
            try {
              descriptor.validate(settings);
            } catch (error) {
              // Descriptor validation errors are safe client guidance, not storage failures.
              if (!(error instanceof Error)) throw error;
              throw new ClientConfigValidationError(error.message);
            }
          }
          recordAuditEvent(database, {
            type: descriptor.auditType,
            createdAt: now,
            actorEmail: actor.email,
            sourceAddress: resolveSourceAddress(request),
          });
          return descriptor.project(readSettings(database));
        });
        return commit();
      } catch (error) {
        // Catch only after the transaction has rolled back any settings writes.
        if (error instanceof ClientConfigValidationError) {
          const message =
            descriptor.validationGuidance === undefined
              ? error.message
              : `${error.message}. ${descriptor.validationGuidance}`;
          return reply.code(400).send({ ...invalid, message });
        }
        app.log.error(storageFailure);
        return reply.code(500).send(ERRORS[500]);
      }
    },
  );
}

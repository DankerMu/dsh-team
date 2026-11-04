import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const ORIGIN_HEADERS_SCHEMA = {
  type: 'object',
  required: ['origin'],
  properties: { origin: { type: 'string' } },
} as const;

const INVALID_ORIGIN = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Invalid request origin',
} as const;
const JSON_REQUIRED = {
  statusCode: 415,
  error: 'Unsupported Media Type',
  message: 'JSON request body required',
} as const;
const SAFE_METHODS: Readonly<Record<string, true | undefined>> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
};

/** Origin is an exact configured value and must occur in exactly one physical header. */
export function hasValidOrigin(request: IncomingMessage, publicUrl: string): boolean {
  if (request.headers.origin !== publicUrl) return false;
  let origins = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'origin') origins += 1;
  }
  return origins === 1;
}

/** The media type before any parameter, trimmed and lowercased, is exactly `application/json`. */
export function isJsonMediaType(contentType: string | undefined): boolean {
  const parameterStart = contentType?.indexOf(';') ?? -1;
  const mediaType = parameterStart === -1 ? contentType : contentType?.slice(0, parameterStart);
  return mediaType?.trim().toLowerCase() === 'application/json';
}

/** Installs the platform mutation boundary on the root app, before route plugins. */
export function installRequestGuard(app: FastifyInstance, publicUrl: string): void {
  app.addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (
      route === undefined ||
      !route.startsWith('/_platform/api/') ||
      SAFE_METHODS[request.method] === true
    ) {
      done();
      return;
    }

    if (!hasValidOrigin(request.raw, publicUrl)) {
      void reply.code(403).send(INVALID_ORIGIN);
      return;
    }

    if (!isJsonMediaType(request.headers['content-type'])) {
      void reply.code(415).send(JSON_REQUIRED);
      return;
    }
    done();
  });
}

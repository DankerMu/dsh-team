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

    if (request.headers.origin !== publicUrl) {
      void reply.code(403).send(INVALID_ORIGIN);
      return;
    }
    // Count physical headers too: Node's duplicate-header policy must not authorize them.
    let origins = 0;
    const headers = request.raw.rawHeaders;
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index]?.toLowerCase() === 'origin') {
        origins += 1;
      }
    }
    if (origins !== 1) {
      void reply.code(403).send(INVALID_ORIGIN);
      return;
    }

    const contentType = request.headers['content-type'];
    const parameterStart = contentType?.indexOf(';') ?? -1;
    const mediaType = parameterStart === -1 ? contentType : contentType?.slice(0, parameterStart);
    if (mediaType?.trim().toLowerCase() !== 'application/json') {
      void reply.code(415).send(JSON_REQUIRED);
      return;
    }
    done();
  });
}

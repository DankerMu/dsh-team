import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, readSessionCookie } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';

const ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  404: { statusCode: 404, error: 'Not Found', message: 'Not Found' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  503: { statusCode: 503, error: 'Service Unavailable', message: 'Instance unavailable' },
} as const;
const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

function platformPath(url: string): boolean {
  // Absolute-form targets have the same namespace without URL path normalization.
  const path = url.replace(/^https?:\/\/[^/?#]*/i, '').split('?', 1)[0];
  return path === '/healthz' || path === '/_platform' || path?.startsWith('/_platform/') === true;
}

function pageRequest(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return (request.headers.accept ?? '').split(',').some((item) => {
    const [mediaType, ...parameters] = item.toLowerCase().split(';');
    if (mediaType?.trim() !== 'text/html') return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  });
}

export const gatewayRoutes: FastifyPluginCallback<{ database: DatabaseHandle }> = (
  app,
  { database },
  done,
) => {
  function status(request: IncomingMessage): keyof typeof ERRORS {
    if (platformPath(request.url ?? '/')) return 404;
    try {
      const token = readSessionCookie(request.headers.cookie);
      return token !== null && getSessionUser(database, token, Date.now()) !== null ? 503 : 401;
    } catch {
      // Authentication storage failures must not reveal database or credential details.
      app.log.error('Gateway authentication storage failure');
      return 500;
    }
  }
  function admit(request: FastifyRequest, reply: FastifyReply): void {
    const code = status(request.raw);
    if (code === 401 && pageRequest(request)) {
      void reply.redirect('/_platform/login', 302);
      return;
    }
    void reply.code(code).send(ERRORS[code]);
  }
  app.all(
    '/*',
    {
      schema: {
        hide: true,
        response: {
          302: { type: 'string' },
          401: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
      onRequest: admit,
    },
    admit,
  );
  function rejectUpgrade(request: IncomingMessage, socket: Duplex): void {
    socket.on('error', () => {
      socket.destroy();
    });
    // Flush the rejection, then release both halves even if the peer withholds FIN.
    socket.once('finish', () => {
      socket.destroy();
    });
    const code = status(request);
    socket.end(
      `HTTP/1.1 ${String(code)} ${ERRORS[code].error}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  app.server.on('upgrade', rejectUpgrade);
  app.addHook('onClose', (_instance, closeDone) => {
    app.server.removeListener('upgrade', rejectUpgrade);
    closeDone();
  });
  done();
};

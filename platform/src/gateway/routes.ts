import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser, hasValidOrigin, readSessionCookie } from '../auth/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import {
  BAD_GATEWAY,
  forwardHttp,
  forwardWebSocket,
  rejectUpgrade,
  requestTarget,
} from './http.ts';
import type { GatewayUpstreamResolver } from './types.ts';

const ERRORS = {
  401: { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
  404: { statusCode: 404, error: 'Not Found', message: 'Not Found' },
  500: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
  502: BAD_GATEWAY,
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
  const path = requestTarget(url).split('?', 1)[0];
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

export const gatewayRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  authority: string;
  publicUrl: string;
  resolveUpstream?: GatewayUpstreamResolver;
}> = (app, { database, authority, publicUrl, resolveUpstream }, done) => {
  function admission(request: IncomingMessage): string | keyof typeof ERRORS {
    if (platformPath(request.url ?? '/')) return 404;
    try {
      const token = readSessionCookie(request.headers.cookie);
      return token === null ? 401 : (getSessionUser(database, token, Date.now())?.id ?? 401);
    } catch {
      // Authentication storage failures must not reveal database or credential details.
      app.log.error('Gateway authentication storage failure');
      return 500;
    }
  }
  function admit(request: FastifyRequest, reply: FastifyReply): void {
    const code = admission(request.raw);
    if (typeof code === 'string') {
      try {
        const upstream = resolveUpstream?.(code);
        if (upstream !== undefined) {
          forwardHttp(request, reply, upstream, authority);
          return;
        }
        void reply.code(503).send(ERRORS[503]);
      } catch {
        app.log.error('Gateway upstream resolution failed');
        void reply.code(502).send(BAD_GATEWAY);
      }
      return;
    }
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
          502: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
      onRequest: admit,
    },
    admit,
  );
  const upgrades = new Set<Duplex>();
  let closing = false;
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (closing) {
      socket.on('error', () => {
        socket.destroy();
      });
      socket.destroy();
      return;
    }
    upgrades.add(socket);
    socket.once('close', () => {
      upgrades.delete(socket);
    });
    const selected = admission(request);
    if (typeof selected !== 'string') {
      rejectUpgrade(socket, selected);
      return;
    }
    if (!hasValidOrigin(request, publicUrl)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 400);
      return;
    }
    try {
      const target = resolveUpstream?.(selected);
      if (target === undefined) {
        rejectUpgrade(socket, 503);
        return;
      }
      forwardWebSocket(request, socket, head, target, authority, () => {
        app.log.error('Gateway WebSocket upstream failed');
      });
    } catch {
      app.log.error('Gateway upstream resolution failed');
      rejectUpgrade(socket, 502);
    }
  }
  app.server.on('upgrade', upgrade);
  app.addHook('preClose', async () => {
    closing = true;
    await Promise.all(
      [...upgrades].map((socket) => {
        const closed = Promise.withResolvers<undefined>();
        socket.once('close', () => {
          closed.resolve(undefined);
        });
        socket.destroy();
        return closed.promise;
      }),
    );
  });
  app.addHook('onClose', (_instance, closeDone) => {
    app.server.removeListener('upgrade', upgrade);
    closeDone();
  });
  done();
};

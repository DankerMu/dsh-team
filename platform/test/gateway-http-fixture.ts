import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, RequestListener, RequestOptions, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { GatewayUpstream, GatewayUpstreamResolver } from '../src/gateway/index.ts';
import {
  cookieHeaders,
  injectRegister,
  readPublicIdentity,
  sessionCookieToken,
  withApp,
} from './auth-fixture.ts';

export async function withUpstream(
  handler: RequestListener,
  run: (target: GatewayUpstream, server: Server) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Missing upstream address');
    await run(
      { host: '127.0.0.1', port: address.port, cookie: `dsh-auth=test-${String(address.port)}` },
      server,
    );
  } finally {
    const closed = once(server, 'close');
    server.close();
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}

export async function withForwardingApp(
  resolveUpstream: GatewayUpstreamResolver,
  run: (context: {
    base: string;
    app: FastifyInstance;
    database: DatabaseHandle;
    cookie: string;
    userId: string;
    lines: string[];
  }) => Promise<void>,
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const registration = await injectRegister(app, {
        email: 'forward@example.com',
        password: 'test-password',
      });
      const userId = readPublicIdentity(registration.json<unknown>()).id;
      const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registration))}`;
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      await run({ base, app, database, cookie, userId, lines });
    },
    false,
    [],
    resolveUpstream,
  );
}

export async function sendHttp(
  base: string,
  options: RequestOptions,
  body?: string | Buffer,
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }>();
  // A failed real peer must be bounded; successful completion is response end.
  const call = request(base, { ...options, signal: AbortSignal.timeout(5_000) }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.once('error', reject);
    response.once('end', () => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      });
    });
  });
  call.once('error', reject);
  call.end(body);
  return promise;
}

export async function observeHttp<T>(observation: Promise<T>): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  // A deadline fails a stalled peer observation; it never stands in for an event.
  const deadline = AbortSignal.timeout(2_000);
  deadline.addEventListener(
    'abort',
    () => {
      reject(new Error('HTTP peer observation did not settle'));
    },
    { once: true },
  );
  return Promise.race([observation, promise]);
}

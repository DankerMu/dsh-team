import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, RequestListener, RequestOptions, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
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
  signal?: AbortSignal,
): Promise<void> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  const abort = () => {
    for (const socket of sockets) socket.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  let primary: unknown;
  let failed = false;
  try {
    signal?.throwIfAborted();
    // Acquire the actual listener before observing cancellation: racing a rejected listening
    // promise against abort can otherwise leave listen() completing after teardown.
    const started = Promise.withResolvers<undefined>();
    const listening = () => {
      started.resolve(undefined);
    };
    const startupFailed = (error: Error) => {
      started.reject(error);
    };
    server.once('listening', listening);
    server.once('error', startupFailed);
    try {
      try {
        server.listen(0, '127.0.0.1');
      } catch (error) {
        started.reject(error);
      }
      await started.promise;
    } finally {
      server.removeListener('listening', listening);
      server.removeListener('error', startupFailed);
    }
    signal?.throwIfAborted();
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Missing upstream address');
    await run(
      {
        outcome: 'running',
        host: '127.0.0.1',
        port: address.port,
        cookie: `dsh-auth=test-${String(address.port)}`,
      },
      server,
    );
  } catch (error) {
    primary = error;
    failed = true;
  }
  signal?.removeEventListener('abort', abort);
  const cleanup: unknown[] = [];
  try {
    const socketClosures = [...sockets].map((socket) => {
      const closed = Promise.withResolvers<undefined>();
      socket.once('close', () => {
        closed.resolve(undefined);
      });
      socket.destroy();
      return closed.promise;
    });
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await observeHttp(closed, 2_000);
    }
    await observeHttp(Promise.all(socketClosures), 2_000);
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length !== 0) {
    if (failed)
      throw new AggregateError([primary, ...cleanup], 'Upstream operation and cleanup failed', {
        cause: primary,
      });
    throw cleanup[0];
  }
  if (failed) throw primary;
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
  trailers: IncomingHttpHeaders;
  body: Buffer;
}> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    headers: IncomingHttpHeaders;
    trailers: IncomingHttpHeaders;
    body: Buffer;
  }>();
  // A failed real peer must be bounded; successful completion is response end.
  const signal =
    options.signal === undefined
      ? AbortSignal.timeout(5_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]);
  let responseClosed: Promise<void> | undefined;
  const call = request(base, { ...options, signal }, (response) => {
    const closed = Promise.withResolvers<undefined>();
    responseClosed = closed.promise;
    response.once('close', () => {
      closed.resolve(undefined);
    });
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.once('error', reject);
    response.once('end', () => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        trailers: response.trailers,
        body: Buffer.concat(chunks),
      });
    });
  });
  call.once('error', reject);
  const closed = Promise.withResolvers<undefined>();
  call.once('close', () => {
    closed.resolve(undefined);
  });
  call.end(body);
  try {
    return await promise;
  } finally {
    call.destroy();
    await Promise.all([closed.promise, responseClosed]);
  }
}

export async function observeHttp<T>(observation: Promise<T>, timeoutMs = 2_000): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  // A deadline fails a stalled real peer; it never stands in for an event.
  const deadline = setTimeout(() => {
    reject(new Error('HTTP peer observation did not settle'));
  }, timeoutMs);
  deadline.unref();
  return Promise.race([observation, promise]).finally(() => {
    clearTimeout(deadline);
  });
}

export type ReadPeer = (size: number | string) => Promise<Buffer>;
export function reader(socket: Duplex, head = Buffer.alloc(0)): ReadPeer {
  let bytes: Buffer = head;
  let failed: Error | undefined;
  let notify: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 65536) failed = new Error('Unexpected test peer payload');
    notify?.();
  });
  socket.on('error', () => {
    failed = new Error('Test peer failed');
    notify?.();
  });
  socket.on('close', () => {
    failed = new Error('Test peer closed');
    notify?.();
  });
  return async (size) => {
    const pending = Promise.withResolvers<Buffer>();
    const check = () => {
      const length = typeof size === 'number' ? size : bytes.indexOf(size) + size.length;
      const available = typeof size === 'number' ? bytes.length >= size : bytes.includes(size);
      if (available) {
        const result = bytes.subarray(0, length);
        bytes = bytes.subarray(length);
        pending.resolve(result);
      } else if (failed !== undefined) pending.reject(failed);
    };
    notify = check;
    check();
    try {
      return await observeHttp(pending.promise);
    } finally {
      notify = undefined;
    }
  };
}

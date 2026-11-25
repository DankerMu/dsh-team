import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, RequestListener, RequestOptions, Server } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
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

// observeHttp's default bound on one peer event; it fails a stalled peer, never stands in for one.
// Measured (#687) with a 60s bound, 10 runs of the secondary-table files at 1-minute load 68-84:
// every single-event site settled within 87ms, about 23x below this. An aggregate observation (a
// whole transfer) passes its own named bound. It is a fixed bound below vitest's default 5s case
// budget, not one derived from it; sendHttp's close wait spends it after HTTP_SEND_MS (see there).
const HTTP_OBSERVATION_MS = 2000;

// sendHttp's default bound on one send, response end included; it fails a stalled peer.
// Measured (#719) over the seven gateway caller files and the ragflow-proxy datasets, documents and
// retrieval files, 5 runs at 1-minute load 67-85 (745 sends, 0 failed): the largest successful send
// took 400.2ms, so this is about 6x above it. 10x (4002ms) does not fit: 4002 + 2000 > 5000. This
// is the largest value that keeps HTTP_SEND_MS + HTTP_OBSERVATION_MS (the close wait) = 4500ms
// below vitest's default 5s case budget, which these callers run under.
export const HTTP_SEND_MS = 2500;

// The send bound for callers with far larger case budgets whose sends are legitimately slower:
// instance-idle.docker.test.ts (real DSH and cold container starts, 900s case budget) and the
// stream warmup (first request to a new child beside a 400MiB transfer, 60s case budget). It keeps
// those callers' send bound at today's 5s, well inside those budgets.
export const HTTP_SEND_SLOW_MS = 5000;

/**
 * Settles an operation whose cleanup ran regardless: a cleanup failure never hides the
 * operation's failure, which leaves first as the cause of the aggregate.
 */
export function settleWithCleanup<T>(
  message: string,
  outcome: { value: T } | { error: unknown },
  cleanup: { error: unknown } | undefined,
): T {
  if ('error' in outcome) {
    if (cleanup === undefined) throw outcome.error;
    throw new AggregateError([outcome.error, cleanup.error], message, { cause: outcome.error });
  }
  if (cleanup !== undefined) throw cleanup.error;
  return outcome.value;
}

export async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an owned TCP port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

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
  let outcome: { value: undefined } | { error: unknown } = { value: undefined };
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
    outcome = { error };
  }
  signal?.removeEventListener('abort', abort);
  let cleanup: { error: unknown } | undefined;
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
      await observeHttp(closed, HTTP_OBSERVATION_MS, 'upstream server close');
    }
    await observeHttp(Promise.all(socketClosures), HTTP_OBSERVATION_MS, 'upstream sockets close');
  } catch (error) {
    cleanup = { error };
  }
  settleWithCleanup('Upstream operation and cleanup failed', outcome, cleanup);
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

interface SentHttp {
  status: number;
  headers: IncomingHttpHeaders;
  trailers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Sends one request and reads its whole response within `sendMs`. An aborted send fails naming the
 * request and its phase, with Node's AbortError as the cause; other request errors pass unchanged.
 */
export async function sendHttp(
  base: string,
  options: RequestOptions,
  body?: string | Buffer,
  sendMs = HTTP_SEND_MS,
): Promise<SentHttp> {
  const { promise, resolve, reject } = Promise.withResolvers<SentHttp>();
  // A failed real peer must be bounded; successful completion is response end.
  const bound = AbortSignal.timeout(sendMs);
  const signal = options.signal === undefined ? bound : AbortSignal.any([options.signal, bound]);
  let phase = 'response headers';
  let responseClosed: Promise<undefined> | undefined;
  const call = request(base, { ...options, signal }, (response) => {
    phase = 'response body';
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
  // Node's own method and path, so a call that gives neither names GET /.
  const name = `sendHttp ${call.method} ${call.path}`;
  let outcome: { value: SentHttp } | { error: unknown };
  try {
    outcome = { value: await promise };
  } catch (error) {
    const aborted = signal.aborted && error instanceof Error && error.name === 'AbortError';
    const why = bound.aborted
      ? `exceeded the ${String(sendMs)}ms send bound`
      : 'aborted by the caller';
    outcome = { error: aborted ? new Error(`${name}: ${phase} ${why}`, { cause: error }) : error };
  }
  call.destroy();
  let cleanup: { error: unknown } | undefined;
  try {
    await observeHttp(
      Promise.all([closed.promise, responseClosed]),
      HTTP_OBSERVATION_MS,
      `${name}: close`,
    );
  } catch (error) {
    cleanup = { error };
  }
  return settleWithCleanup(`${name}: send and close failed`, outcome, cleanup);
}

export async function observeHttp<T>(
  observation: Promise<T>,
  timeoutMs = HTTP_OBSERVATION_MS,
  label?: string,
): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const message = 'HTTP peer observation did not settle';
  // A deadline fails a stalled real peer; it never stands in for an event.
  const deadline = setTimeout(() => {
    reject(new Error(label === undefined ? message : `${message}: ${label}`));
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
      return await observeHttp(pending.promise, HTTP_OBSERVATION_MS, 'peer read');
    } finally {
      notify = undefined;
    }
  };
}

/** Sends a raw upgrade the gateway must refuse and returns its response head. */
export async function rejectedUpgrade(
  base: string,
  cookie: string,
  fields: readonly string[],
  path = '/ws',
): Promise<string> {
  const address = new URL(base);
  const socket = connect(Number(address.port), address.hostname);
  const read = reader(socket);
  const closed = once(socket, 'close');
  // A refused handshake never validates its per-run RFC6455 nonce.
  const key = randomBytes(16).toString('base64');
  try {
    await once(socket, 'connect');
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n${fields.join('\r\n')}\r\n\r\n`,
    );
    const headers = (await read('\r\n\r\n')).toString();
    await observeHttp(closed, HTTP_OBSERVATION_MS, 'rejected upgrade close');
    return headers;
  } finally {
    socket.destroy();
  }
}

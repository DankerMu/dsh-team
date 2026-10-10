import { request, STATUS_CODES } from 'node:http';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
} from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayUpstream } from './types.ts';

const HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
export const BAD_GATEWAY = {
  statusCode: 502,
  error: 'Bad Gateway',
  message: 'Instance unavailable',
} as const;
const BAD_GATEWAY_BODY = JSON.stringify(BAD_GATEWAY);

export function requestTarget(url: string): string {
  const target = url.replace(/^https?:\/\/[^/?#]*/i, '');
  return target === '' || target.startsWith('?') ? `/${target}` : target;
}

export function forwardHeaders(
  headers: IncomingHttpHeaders,
  credential: 'cookie' | 'set-cookie',
): OutgoingHttpHeaders {
  const blocked = new Set(HOP_HEADERS);
  blocked.add(credential);
  for (const name of headers.connection?.split(',') ?? []) blocked.add(name.trim().toLowerCase());
  // An empty null-prototype map safely accepts any HTTP token as a header name.
  const result = Object.create(null) as OutgoingHttpHeaders;
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name)) result[name] = value;
  }
  // Reframe decoded request bytes even for methods that Node will not auto-chunk.
  if (
    credential === 'cookie' &&
    result['content-length'] === undefined &&
    (headers['transfer-encoding'] !== undefined || headers['content-length'] !== undefined)
  ) {
    result['transfer-encoding'] = 'chunked';
  }
  return result;
}

export function forwardHttp(
  incoming: FastifyRequest,
  reply: FastifyReply,
  target: GatewayUpstream,
  authority: string,
): void {
  reply.hijack();
  let outgoing: ClientRequest | undefined;
  let upstream: IncomingMessage | undefined;
  let cancelled = false;
  let failed = false;
  function release(): void {
    if (outgoing !== undefined) incoming.raw.unpipe(outgoing);
    upstream?.destroy();
    outgoing?.destroy();
  }
  function cancel(): void {
    cancelled = true;
    release();
  }
  function fail(): void {
    if (failed) return;
    failed = true;
    release();
    if (cancelled || reply.raw.destroyed || reply.raw.writableEnded) return;
    incoming.log.error('Gateway upstream request failed');
    if (reply.raw.headersSent) reply.raw.destroy();
    else
      reply.raw
        .writeHead(502, { 'content-type': 'application/json', connection: 'close' })
        .end(BAD_GATEWAY_BODY);
  }
  incoming.raw.once('aborted', cancel);
  incoming.raw.on('error', cancel);
  reply.raw.on('error', cancel);
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) cancel();
  });
  try {
    const headers = forwardHeaders(incoming.headers, 'cookie');
    headers.host = authority;
    headers.cookie = target.cookie;
    outgoing = request(
      {
        hostname: target.host,
        port: target.port,
        method: incoming.method,
        path: requestTarget(incoming.raw.url ?? '/'),
        headers,
        agent: false,
      },
      (response) => {
        upstream = response;
        response.on('error', fail);
        response.once('aborted', fail);
        if (cancelled || response.statusCode === undefined) {
          fail();
          return;
        }
        reply.raw.writeHead(response.statusCode, forwardHeaders(response.headers, 'set-cookie'));
        response.pipe(reply.raw);
      },
    );
    outgoing.on('error', fail);
    outgoing.once('upgrade', (_response, socket) => {
      socket.destroy();
      fail();
    });
    incoming.raw.pipe(outgoing);
  } catch {
    // Invalid trusted endpoint/header data must never become a credential-bearing exception response.
    fail();
  }
}

export function rejectUpgrade(
  socket: Duplex,
  code: 400 | 401 | 403 | 404 | 500 | 502 | 503,
  body = '',
): void {
  socket.on('error', () => {
    socket.destroy();
  });
  socket.once('finish', () => {
    socket.destroy();
  });
  const contentType = body === '' ? '' : 'Content-Type: application/json\r\n';
  socket.end(
    `HTTP/1.1 ${String(code)} ${STATUS_CODES[code] ?? 'Error'}\r\nConnection: close\r\n${contentType}Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
  );
}

export function forwardWebSocket(
  incoming: IncomingMessage,
  client: Duplex,
  head: Buffer,
  target: GatewayUpstream,
  authority: string,
  logFailure: () => void,
): void {
  let outgoing: ClientRequest | undefined;
  let upstream: Duplex | undefined;
  let closed = false;
  let upgraded = false;
  let forwardingClient = false;
  let draining = false;
  const release = () => {
    if (upstream !== undefined) {
      client.unpipe(upstream);
      upstream.unpipe(client);
    }
    upstream?.destroy();
    outgoing?.destroy();
  };
  const cancel = () => {
    if (closed) return;
    closed = true;
    release();
    client.destroy();
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    release();
    logFailure();
    if (upgraded) client.destroy();
    else rejectUpgrade(client, 502);
  };
  const drain = () => {
    if (closed || draining) return;
    if (!upgraded || upstream === undefined) {
      cancel();
      return;
    }
    draining = true;
    // EOF ends admission in both directions, not ownership of already accepted writes.
    client.unpipe(upstream);
    upstream.unpipe(client);
    client.pause();
    upstream.pause();
    // Keep the registered client alive until upstream writes finish, so shutdown can still cancel.
    upstream.once('finish', () => {
      if (closed) return;
      client.once('finish', cancel);
      client.end();
    });
    upstream.end();
  };
  client.pause();
  client.on('error', cancel);
  client.once('close', cancel);
  client.once('end', drain);
  const forwardClient = (socket: Duplex) => {
    if (closed) {
      socket.destroy();
      return;
    }
    if (forwardingClient) return;
    forwardingClient = true;
    if (head.length !== 0) client.unshift(head);
    // Keep the head and early frames in one backpressured stream, including before 101.
    client.pipe(socket, { end: false });
  };
  try {
    const headers = forwardHeaders(incoming.headers, 'cookie');
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers.host = authority;
    headers.cookie = target.cookie;
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    outgoing = request({
      hostname: target.host,
      port: target.port,
      method: incoming.method,
      path: requestTarget(incoming.url ?? '/'),
      headers,
      agent: false,
    });
    outgoing.once('socket', (socket) => {
      upstream = socket;
      if (closed) socket.destroy();
    });
    outgoing.once('finish', () => {
      // Node emits finish from the final HTTP socket.write callback: frames follow headers.
      if (upstream !== undefined) forwardClient(upstream);
    });
    outgoing.on('error', fail);
    outgoing.once('response', (response) => {
      response.destroy();
      fail();
    });
    outgoing.once('upgrade', (response, socket, upstreamHead) => {
      if (closed) {
        socket.destroy();
        return;
      }
      upstream = socket;
      socket.on('error', fail);
      socket.once('close', () => {
        // Node's allowHalfOpen:false upstream can close normally while client writes still drain.
        if (!draining || !socket.readableEnded || !socket.writableFinished) cancel();
      });
      socket.once('end', drain);
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket') {
        fail();
        return;
      }
      const responseHeaders = forwardHeaders(response.headers, 'set-cookie');
      responseHeaders.connection = 'Upgrade';
      responseHeaders.upgrade = 'websocket';
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value])
          lines.push(`${name}: ${String(item)}`);
      }
      upgraded = true;
      client.write(`${lines.join('\r\n')}\r\n\r\n`);
      // A validated 101 also proves the peer received the headers if finish is not emitted yet.
      forwardClient(socket);
      if (upstreamHead.length !== 0) socket.unshift(upstreamHead);
      // The EOF owner drains both destinations before paired destruction.
      socket.pipe(client, { end: false });
    });
    outgoing.end();
  } catch {
    // Trusted endpoint/header failures must not expose either credential.
    fail();
  }
}

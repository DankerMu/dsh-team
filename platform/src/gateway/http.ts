import { request } from 'node:http';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
} from 'node:http';
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

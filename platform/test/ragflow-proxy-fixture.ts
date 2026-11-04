import { once } from 'node:events';
import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { withApp } from './auth-fixture.ts';
import { observeHttp, sendHttp } from './gateway-http-fixture.ts';
import { instanceToken, instanceTokenHash, seedInstance } from './instance-token-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';

export const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };

interface Answer {
  readonly status: number;
  readonly body: string;
}
interface SendOptions {
  readonly method?: string;
  readonly token?: boolean;
  /** Sent verbatim; no Content-Type is added unless `contentType` is given. */
  readonly body?: string;
  readonly contentType?: string;
}
export interface Proxy {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  readonly base: string;
  readonly token: string;
  /** Every log line the application has written so far. */
  readonly lines: readonly string[];
  /** One real HTTP request whose target is sent verbatim, so a bare "?" survives. */
  readonly send: (path: string, options?: SendOptions) => Promise<Answer>;
  /** Raw bytes over a fresh socket, read until the platform closes it. */
  readonly raw: (head: string) => Promise<string>;
}
interface ProxyOptions {
  /** The owned fake RAGFlow; its authority must never be echoed. */
  readonly upstream: ModelUpstream;
  readonly key: string;
  /** Upstream or employee text that must never reach a response or a log line. */
  readonly markers: readonly string[];
  /** The saved address; an empty string saves nothing. Defaults to the fake RAGFlow. */
  readonly baseURL?: string | undefined;
}

/** The body of a raw HTTP/1.1 answer. */
export function rawBody(text: string): string {
  return text.slice(text.indexOf('\r\n\r\n') + 4);
}

/**
 * Real loopback listener in network mode with one running instance and its token. Afterwards
 * neither responses nor logs carry the token, its hash, the RAGFlow authority, key or markers.
 */
export async function withProxy(
  options: ProxyOptions,
  run: (proxy: Proxy) => Promise<void>,
): Promise<void> {
  const { upstream, key } = options;
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, { userId: 'owner', token, host: '127.0.0.1' });
      if (options.baseURL !== '')
        writeSettings(database, {
          ragflowBaseUrl: options.baseURL ?? upstream.origin,
          ragflowApiKey: key,
        });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const texts: string[] = [];
      const send: Proxy['send'] = async (
        path,
        { method = 'GET', token: withToken = true, body: payload, contentType } = {},
      ) => {
        const headers: Record<string, string> = {};
        if (withToken) headers.authorization = `Bearer ${token}`;
        if (contentType !== undefined) headers['content-type'] = contentType;
        const response = await sendHttp(base, { method, path, headers }, payload);
        const body = response.body.toString('utf8');
        texts.push(body);
        return { status: response.status, body };
      };
      const raw: Proxy['raw'] = async (head) => {
        const address = new URL(base);
        const socket = connect(Number(address.port), address.hostname);
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        const closed = once(socket, 'close');
        try {
          await once(socket, 'connect');
          socket.write(head);
          await observeHttp(closed);
        } finally {
          socket.destroy();
        }
        const text = Buffer.concat(chunks).toString('utf8');
        texts.push(text);
        return text;
      };

      await run({ app, database, base, token, lines, send, raw });

      const output = texts.join('') + lines.join('');
      const leaks = [token, instanceTokenHash(token), new URL(upstream.origin).host, key];
      for (const leak of [...leaks, ...options.markers]) expect(output.includes(leak)).toBe(false);
    },
    false,
    [],
    undefined,
    { upstreamMode: 'network' },
  );
}

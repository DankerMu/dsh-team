import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** Owned loopback OpenAI-shaped completion upstream; never a real provider. */
export const UPSTREAM_KEY = 'owned-loopback-model-key';
export const UPSTREAM_MODEL = 'owned-model';

interface UpstreamRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}
type Handler = (request: UpstreamRequest, response: ServerResponse, socket: Socket) => void;

/** Answers like the delivered OpenAI-compatible wire: exact path and bearer key, else 404/401. */
export function completionHandler(path = '/v1/chat/completions', marker = ''): Handler {
  return (request, response) => {
    if (request.method !== 'POST' || request.path !== path) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `not found ${marker}` } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `invalid key ${marker}` } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'owned-completion',
        object: 'chat.completion',
        model: UPSTREAM_MODEL,
        choices: [
          { index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'length' },
        ],
      }),
    );
  };
}

export interface ModelUpstream {
  readonly origin: string;
  readonly requests: UpstreamRequest[];
  /** Resolves when the n-th (1-based) received request's socket closes. */
  socketClosed(index: number): Promise<undefined>;
  /** Resolves when the n-th (1-based) request has been fully received. */
  received(index: number): Promise<undefined>;
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

export async function startModelUpstream(
  handler: Handler = completionHandler(),
): Promise<ModelUpstream> {
  let current = handler;
  const requests: UpstreamRequest[] = [];
  const closures: PromiseWithResolvers<undefined>[] = [];
  const arrivals: PromiseWithResolvers<undefined>[] = [];
  const at = (list: PromiseWithResolvers<undefined>[], index: number) => {
    let entry = list[index - 1];
    while (entry === undefined) {
      list.push(Promise.withResolvers<undefined>());
      entry = list[index - 1];
    }
    return entry;
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const received: UpstreamRequest = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(received);
      const index = requests.length;
      request.socket.once('close', () => {
        at(closures, index).resolve(undefined);
      });
      at(arrivals, index).resolve(undefined);
      current(received, response, request.socket);
    });
  });
  const listening = Promise.withResolvers<undefined>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(undefined);
  });
  await listening.promise;
  // listen(0, host) on a TCP server always reports an AddressInfo object.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    socketClosed: (index) => at(closures, index).promise,
    received: (index) => at(arrivals, index).promise,
    setHandler(next) {
      current = next;
    },
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<undefined>();
      server.close(() => {
        closed.resolve(undefined);
      });
      await closed.promise;
    },
  };
}

/** A loopback port that was bound and released, so a connect attempt is refused. */
export async function refusedOrigin(): Promise<string> {
  const upstream = await startModelUpstream();
  await upstream.close();
  return upstream.origin;
}

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import { listRagflowDatasets } from '../src/ragflow-proxy/index.ts';
import { withApp } from './auth-fixture.ts';
import { observeHttp, sendHttp } from './gateway-http-fixture.ts';
import { instanceToken, instanceTokenHash, seedInstance } from './instance-token-fixture.ts';
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';

const DATASETS = '/_platform/instance-api/ragflow/datasets';
const LIST_PATH = '/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const IDS = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')] as const;
type Handler = Parameters<ModelUpstream['setHandler']>[0];

/** An rc2 list row: every field beside `id` and `name` carries the marker and must be dropped. */
function row(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    description: MARKER,
    avatar: `data:image/png;base64,${MARKER}`,
    tenant_avatar: `data:image/png;base64,${MARKER}`,
    nickname: MARKER,
    tenant_id: randomBytes(16).toString('hex'),
    chunk_count: 3,
    document_count: 1,
  };
}

/** Answers like RAGFlow v1.0.0-rc2's bearer-checked dataset list; anything else is a marked 404. */
function ragflowHandler(rows: Record<string, unknown>[]): Handler {
  return (request, response) => {
    const answer = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: MARKER, ...body }));
    };
    if (request.method !== 'GET' || request.path !== LIST_PATH) answer(404, { code: 404 });
    else if (request.headers.authorization !== `Bearer ${RAGFLOW_KEY}`)
      answer(401, { code: 401, data: null });
    else answer(200, { code: 0, data: rows, total_datasets: rows.length });
  };
}

let upstream: ModelUpstream;
beforeEach(async () => {
  upstream = await startModelUpstream(
    ragflowHandler([row(IDS[0], '制度库'), row(IDS[1], '产品库')]),
  );
});
afterEach(async () => {
  await upstream.close();
});

interface Answer {
  readonly status: number;
  readonly body: string;
}
interface Proxy {
  readonly base: string;
  readonly token: string;
  /** One real HTTP request whose target is sent verbatim, so a bare "?" survives. */
  readonly send: (path: string, options?: { method?: string; token?: boolean }) => Promise<Answer>;
  /** Raw bytes over a fresh socket, read until the platform closes it. */
  readonly raw: (head: string) => Promise<string>;
}

/**
 * Real loopback listener in network mode with one running instance and its token. Afterwards
 * neither responses nor logs carry the token, its hash, the RAGFlow authority, key or marker.
 */
async function withProxy(
  run: (proxy: Proxy) => Promise<void>,
  options: { readonly baseURL?: string } = {},
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, { userId: 'owner', token, host: '127.0.0.1' });
      if (options.baseURL !== '')
        writeSettings(database, {
          ragflowBaseUrl: options.baseURL ?? upstream.origin,
          ragflowApiKey: RAGFLOW_KEY,
        });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const texts: string[] = [];
      const send: Proxy['send'] = async (
        path,
        { method = 'GET', token: withToken = true } = {},
      ) => {
        const headers = withToken ? { authorization: `Bearer ${token}` } : {};
        const response = await sendHttp(base, { method, path, headers });
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

      await run({ base, token, send, raw });

      const output = texts.join('') + lines.join('');
      const leaks = [token, instanceTokenHash(token), new URL(upstream.origin).host, RAGFLOW_KEY];
      for (const leak of [...leaks, MARKER]) expect(output.includes(leak)).toBe(false);
    },
    false,
    [],
    undefined,
    { upstreamMode: 'network' },
  );
}

it('lists every dataset once with the key and returns only ids and names', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(DATASETS);

    expect(answer.status).toBe(200);
    expect(answer.body).toBe(
      JSON.stringify({
        result: 'ok',
        datasets: [
          { id: IDS[0], name: '制度库' },
          { id: IDS[1], name: '产品库' },
        ],
      }),
    );
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', LIST_PATH],
    ]);
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${RAGFLOW_KEY}`);
  });
});

it('answers an empty dataset list as ok with no datasets', async () => {
  upstream.setHandler(ragflowHandler([]));
  await withProxy(async ({ send }) => {
    const answer = await send(DATASETS);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'ok', datasets: [] }]);
  });
});

it('answers not-configured without contacting RAGFlow', async () => {
  await withProxy(
    async ({ send }) => {
      const answer = await send(DATASETS);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'not-configured' }]);
      expect(upstream.requests).toEqual([]);
    },
    { baseURL: '' },
  );
});

it('reports HTTP 200 with a non-zero code as upstream-error', async () => {
  upstream.setHandler((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 102, data: [], total_datasets: 0, message: MARKER }));
  });
  await withProxy(async ({ send }) => {
    const answer = await send(DATASETS);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'upstream-error' }]);
    expect(upstream.requests).toHaveLength(1);
  });
});

it('reports a refused port as unavailable', async () => {
  const refused = await refusedOrigin();
  await withProxy(
    async ({ send }) => {
      const answer = await send(DATASETS);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'unavailable' }]);
    },
    { baseURL: refused },
  );
});

it('reaches the deadline before a status and while the list body stalls', async () => {
  const settings = { baseURL: upstream.origin, apiKey: RAGFLOW_KEY };
  upstream.setHandler(() => undefined);
  const silent = await listRagflowDatasets(settings, new AbortController().signal, 200);
  await upstream.socketClosed(1);
  upstream.setHandler((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"code":0,"data":[');
  });
  const stalled = await listRagflowDatasets(settings, new AbortController().signal, 200);

  expect(silent).toEqual({ result: 'timeout' });
  expect(stalled).toEqual({ result: 'timeout' });
  expect(upstream.requests.map(({ path }) => path)).toEqual([LIST_PATH, LIST_PATH]);
  await upstream.socketClosed(2);
});

it.each([`${DATASETS}?page=2`, `${DATASETS}?`])(
  'answers %s with invalid-request without contacting RAGFlow',
  async (path) => {
    await withProxy(async ({ send }) => {
      const answer = await send(path);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([
        200,
        { result: 'invalid-request' },
      ]);
      expect(upstream.requests).toEqual([]);
    });
  },
);

it('answers a request without a token with the fixed 401 and no RAGFlow request', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(DATASETS, { token: false });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([401, UNAUTHORIZED]);
    expect(upstream.requests).toEqual([]);
  });
});

it('answers an authenticated HEAD with the platform 404 and no RAGFlow request', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(DATASETS, { method: 'HEAD' });

    expect(answer.status).toBe(404);
    expect(upstream.requests).toEqual([]);
  });
});

it('authenticates an absolute-form target before routing it to the dataset list', async () => {
  await withProxy(async ({ raw }) => {
    const text = await raw(
      `GET http://h${DATASETS} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`,
    );

    expect(text).toMatch(/^HTTP\/1\.1 401 /);
    expect(JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4))).toEqual(UNAUTHORIZED);
    expect(upstream.requests).toEqual([]);
  });
});

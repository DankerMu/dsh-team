import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { retrieveRagflow } from '../src/ragflow-proxy/index.ts';
import { administrator } from './admin-config-fixture.ts';
import { jsonRequestHeaders } from './auth-fixture.ts';
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';
import { UNAUTHORIZED, withProxy as withRagflowProxy } from './ragflow-proxy-fixture.ts';
import type { Proxy } from './ragflow-proxy-fixture.ts';

const RETRIEVAL = '/_platform/instance-api/ragflow/retrieval';
const RETRIEVAL_CONFIG = '/_platform/api/admin/retrieval-config';
const LIST_PATH = '/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
const QUESTION_MARKER = `owned-question-marker-${randomBytes(8).toString('hex')}`;
const CONTENT_MARKER = `owned-content-marker-${randomBytes(8).toString('hex')}`;
const LIBRARY_1 = randomBytes(16).toString('hex');
const LIBRARY_2 = randomBytes(16).toString('hex');
const CONTENT = '年假需提前三天在系统中申请。';
const CHUNK = { content: CONTENT, documentName: '员工手册.txt', datasetName: '库一' };
type Handler = Parameters<ModelUpstream['setHandler']>[0];

/** An rc2 retrieval chunk: every field the proxy drops carries the upstream marker. */
function chunk(datasetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomBytes(16).toString('hex'),
    content: CONTENT,
    content_ltks: MARKER,
    document_id: randomBytes(16).toString('hex'),
    document_keyword: '员工手册.txt',
    dataset_id: datasetId,
    highlight: MARKER,
    image_id: MARKER,
    important_keywords: [MARKER],
    questions: [MARKER],
    similarity: MARKER,
    term_similarity: MARKER,
    vector_similarity: MARKER,
    doc_type_kwd: MARKER,
    positions: [],
    ...extra,
  };
}
function retrieved(chunks: unknown[]): Record<string, unknown> {
  return { code: 0, data: { chunks, doc_aggs: [{ doc_name: MARKER }], labels: [MARKER] } };
}

/**
 * Answers like RAGFlow v1.0.0-rc2 behind a bearer check: the dataset list holds only library 1,
 * and the retrieval answers with `retrieval`; every answer carries the marker as its message.
 */
function ragflowHandler(
  retrieval: Record<string, unknown> = retrieved([chunk(LIBRARY_1)]),
): Handler {
  return (request, response) => {
    const answer = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: MARKER, ...body }));
    };
    if (request.headers.authorization !== `Bearer ${RAGFLOW_KEY}`)
      answer(401, { code: 401, data: null });
    else if (request.method === 'GET' && request.path === LIST_PATH)
      answer(200, {
        code: 0,
        data: [{ id: LIBRARY_1, name: '库一', avatar: MARKER, tenant_avatar: MARKER }],
        total_datasets: 1,
      });
    else if (request.method === 'POST' && request.path === '/api/v1/retrieval')
      answer(200, retrieval);
    else answer(200, { code: 404, data: null });
  };
}

let upstream: ModelUpstream;
beforeEach(async () => {
  upstream = await startModelUpstream(ragflowHandler());
});
afterEach(async () => {
  await upstream.close();
});

/** The proxy over the owned fake RAGFlow; no marker may reach a response or a log line. */
function withProxy(
  run: (proxy: Proxy) => Promise<void>,
  options: { readonly baseURL?: string; readonly markers?: readonly string[] } = {},
): Promise<void> {
  return withRagflowProxy(
    {
      upstream,
      key: RAGFLOW_KEY,
      markers: [MARKER, QUESTION_MARKER, ...(options.markers ?? [])],
      baseURL: options.baseURL,
    },
    run,
  );
}

/** One authenticated retrieval of `datasetIds`; `fields` replace or add body members. */
async function retrieve(
  proxy: Proxy,
  datasetIds: readonly string[],
  fields: Record<string, unknown> = {},
): Promise<{ status: number; outcome: unknown }> {
  const body = JSON.stringify({ question: `年假 ${QUESTION_MARKER}`, datasetIds, ...fields });
  const answer = await proxy.send(RETRIEVAL, {
    method: 'POST',
    body,
    contentType: 'application/json',
  });
  return { status: answer.status, outcome: JSON.parse(answer.body) };
}
/** The JSON body of the n-th request the fake RAGFlow received. */
function upstreamBody(index: number): Record<string, unknown> {
  const text = upstream.requests[index]?.body ?? 'null';
  // The proxy always posts a JSON object; anything else fails the following assertions.
  return JSON.parse(text) as Record<string, unknown>;
}

it('retrieves only from the existing library and reports the deleted one as excluded', async () => {
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, [LIBRARY_1, LIBRARY_2]);

    expect(answer).toStrictEqual({
      status: 200,
      outcome: { result: 'ok', excluded: [LIBRARY_2], chunks: [CHUNK] },
    });
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', LIST_PATH],
      ['POST', '/api/v1/retrieval'],
    ]);
    const retrieval = upstream.requests[1];
    expect(retrieval?.headers.authorization).toBe(`Bearer ${RAGFLOW_KEY}`);
    expect(retrieval?.headers['content-type']).toBe('application/json');
    expect(upstreamBody(1)).toStrictEqual({
      question: `年假 ${QUESTION_MARKER}`,
      dataset_ids: [LIBRARY_1],
      page: 1,
      page_size: 8,
      similarity_threshold: 0.2,
      keywords_similarity_weight: 0.7,
      rerank_candidates_count: 64,
      include_knowledge_compilation: false,
    });
  });
});

it('answers no-results without retrieving when every requested library is gone', async () => {
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, [LIBRARY_2]);

    expect(answer).toStrictEqual({
      status: 200,
      outcome: { result: 'no-results', excluded: [LIBRARY_2] },
    });
    expect(upstream.requests.map(({ path }) => path)).toEqual([LIST_PATH]);
  });
});

it('rejects an empty scope as invalid-request without contacting RAGFlow', async () => {
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, []);

    expect(answer).toStrictEqual({ status: 200, outcome: { result: 'invalid-request' } });
    expect(upstream.requests).toEqual([]);
  });
});

it.each([{ top_k: 1024 }, { similarity_threshold: 0 }])(
  'rejects an instance-supplied retrieval parameter %j as invalid-request without contacting RAGFlow',
  async (fields) => {
    await withProxy(async (proxy) => {
      const answer = await retrieve(proxy, [LIBRARY_1], fields);

      expect(answer).toStrictEqual({ status: 200, outcome: { result: 'invalid-request' } });
      expect(upstream.requests).toEqual([]);
    });
  },
);

it('applies administrator retrieval parameters to the very next retrieval without a restart', async () => {
  await withProxy(async (proxy) => {
    const { cookie } = await administrator(proxy.app, proxy.database);
    const save = async (retrievalTopK: number, retrievalRerankId: string) => {
      const response = await fetch(`${proxy.base}${RETRIEVAL_CONFIG}`, {
        method: 'PUT',
        headers: jsonRequestHeaders({ cookie }),
        body: JSON.stringify({
          retrievalTopK,
          retrievalSimilarityThreshold: 0.2,
          retrievalKeywordsWeight: 0.7,
          retrievalRerankId,
        }),
      });
      expect([response.status, await response.json()]).toEqual([
        200,
        expect.objectContaining({ retrievalTopK, retrievalRerankId }),
      ]);
    };
    const sent = async () => {
      expect((await retrieve(proxy, [LIBRARY_1])).outcome).toMatchObject({ result: 'ok' });
      return upstreamBody(upstream.requests.length - 1);
    };

    const initial = await sent();
    await save(3, 'bge-reranker-v2-m3@Xinference');
    const reduced = await sent();
    await save(100, 'bge-reranker-v2-m3@Xinference');
    const widened = await sent();
    await save(100, '');
    const unranked = await sent();

    expect(initial).toMatchObject({ page_size: 8, rerank_candidates_count: 64 });
    expect(initial).not.toHaveProperty('rerank_id');
    expect(reduced).toMatchObject({
      page_size: 3,
      rerank_id: 'bge-reranker-v2-m3@Xinference',
      rerank_candidates_count: 64,
    });
    expect(widened).toMatchObject({
      page_size: 100,
      rerank_id: 'bge-reranker-v2-m3@Xinference',
      rerank_candidates_count: 100,
    });
    expect(unranked).toMatchObject({ page_size: 100, rerank_candidates_count: 100 });
    expect(unranked).not.toHaveProperty('rerank_id');
  });
});

it('fails the whole retrieval when one chunk lies outside the retrieved libraries', async () => {
  const stray = chunk(randomBytes(16).toString('hex'), { content: CONTENT_MARKER });
  upstream.setHandler(ragflowHandler(retrieved([chunk(LIBRARY_1), stray])));
  await withProxy(
    async (proxy) => {
      const answer = await retrieve(proxy, [LIBRARY_1]);

      expect(answer).toStrictEqual({ status: 200, outcome: { result: 'upstream-error' } });
      expect(upstream.requests).toHaveLength(2);
    },
    { markers: [CONTENT_MARKER, CONTENT] },
  );
});

it('reports HTTP 200 with code 102 as upstream-error', async () => {
  upstream.setHandler(ragflowHandler({ code: 102, data: null }));
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, [LIBRARY_1]);

    expect(answer).toStrictEqual({ status: 200, outcome: { result: 'upstream-error' } });
    expect(upstream.requests).toHaveLength(2);
  });
});

it('reaches the retrieval deadline after a successful preflight as timeout', async () => {
  const listing = ragflowHandler();
  upstream.setHandler((request, response, socket) => {
    // The retrieval never answers; the preflight list does.
    if (request.method === 'GET') listing(request, response, socket);
  });

  const outcome = await retrieveRagflow(
    {
      baseURL: upstream.origin,
      apiKey: RAGFLOW_KEY,
      retrievalTopK: 8,
      retrievalSimilarityThreshold: 0.2,
      retrievalKeywordsWeight: 0.7,
      retrievalRerankId: '',
    },
    { question: '年假', datasetIds: [LIBRARY_1] },
    new AbortController().signal,
    200,
  );

  expect(outcome).toStrictEqual({ result: 'timeout' });
  expect(upstream.requests.map(({ method }) => method)).toEqual(['GET', 'POST']);
  await upstream.socketClosed(2);
});

it('reports a refused port as unavailable', async () => {
  const refused = await refusedOrigin();
  await withProxy(
    async (proxy) => {
      const answer = await retrieve(proxy, [LIBRARY_1]);

      expect(answer).toStrictEqual({ status: 200, outcome: { result: 'unavailable' } });
    },
    { baseURL: refused },
  );
});

it('reports a retrieval without chunks as no-results, not an error', async () => {
  upstream.setHandler(ragflowHandler(retrieved([])));
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, [LIBRARY_1]);

    expect(answer).toStrictEqual({ status: 200, outcome: { result: 'no-results', excluded: [] } });
    expect(upstream.requests).toHaveLength(2);
  });
});

it('returns no positions field for a chunk whose positions are empty', async () => {
  await withProxy(async (proxy) => {
    const answer = await proxy.send(RETRIEVAL, {
      method: 'POST',
      body: JSON.stringify({ question: '年假', datasetIds: [LIBRARY_1] }),
      contentType: 'application/json',
    });

    expect(answer.body).toBe(JSON.stringify({ result: 'ok', excluded: [], chunks: [CHUNK] }));
    expect(answer.body).not.toContain('positions');
  });
});

it('answers a non-JSON retrieval with the fixed 415 without contacting RAGFlow', async () => {
  await withProxy(async (proxy) => {
    const answer = await proxy.send(RETRIEVAL, {
      method: 'POST',
      body: JSON.stringify({ question: '年假', datasetIds: [LIBRARY_1] }),
      contentType: 'text/plain',
    });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      415,
      { statusCode: 415, error: 'Unsupported Media Type', message: 'JSON request body required' },
    ]);
    expect(upstream.requests).toEqual([]);
  });
});

it('answers a retrieval without a token or Origin with the fixed 401 and no RAGFlow request', async () => {
  await withProxy(async (proxy) => {
    const answer = await proxy.send(RETRIEVAL, {
      method: 'POST',
      token: false,
      body: JSON.stringify({ question: '年假', datasetIds: [LIBRARY_1] }),
      contentType: 'application/json',
    });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([401, UNAUTHORIZED]);
    expect(upstream.requests).toEqual([]);
  });
});

it('keeps dropped upstream fields, the question, the address and the key out of responses and logs', async () => {
  await withProxy(async (proxy) => {
    const answer = await retrieve(proxy, [LIBRARY_1, LIBRARY_2]);

    expect(answer.outcome).toStrictEqual({
      result: 'ok',
      excluded: [LIBRARY_2],
      chunks: [CHUNK],
    });
    // The fixture's sweep then covers every response and log line for both markers.
    expect(upstream.requests[1]?.body).toContain(QUESTION_MARKER);
    expect(proxy.lines.some((line) => line.includes(RETRIEVAL))).toBe(true);
  });
});

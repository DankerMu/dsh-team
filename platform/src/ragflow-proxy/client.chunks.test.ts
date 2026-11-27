import { expect, it, vi } from 'vitest';
import { listRagflowChunks } from './client.ts';

const KEY = 'owned-nonsecret-ragflow-key';
const BASE = 'https://kb.invalid';
const DATASET = 'd'.repeat(32);
const DOCUMENT = 'e'.repeat(32);
const CHUNKS_URL = `https://kb.invalid/api/v1/datasets/${DATASET}/documents/${DOCUMENT}/chunks`;

type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
type Respond = (request: Request, signal: AbortSignal) => Promise<Response> | Response;
function sender(respond: Respond) {
  return vi.fn<Send>((request, init) => Promise.resolve(respond(request, init.signal)));
}

/**
 * A RAGFlow v1.0.0-rc2 list-chunks row as its Go service (`internal/service/chunk/chunk.go`)
 * sends it: `chunk_id` and `content_with_weight`, no `content` or `document_id`.
 */
function chunkRow(index: number, text = `第 ${String(index)} 段`): Record<string, unknown> {
  return {
    chunk_id: index.toString(16).padStart(16, '0'),
    content_with_weight: text,
    docnm_kwd: 'expense-policy.txt',
    doc_id: DOCUMENT,
    kb_id: DATASET,
    important_kwd: ['dropped'],
    question_kwd: [],
    img_id: '',
    available_int: 1,
    positions: [],
  };
}
/** rc2's document summary beside the rows; the proxy reads only its `id` and `dataset_id`. */
const DOC = {
  id: DOCUMENT,
  dataset_id: DATASET,
  name: 'expense-policy.txt',
  chunk_count: 2,
  location: 'dropped-location',
  thumbnail: 'data:image/png;base64,AAAA',
};
function chunkPage(
  chunks: unknown,
  total: unknown = Array.isArray(chunks) ? chunks.length : 0,
  doc: unknown = DOC,
): string {
  return JSON.stringify({ code: 0, data: { chunks, doc, total }, message: 'success' });
}
function chunks(
  send: Send,
  query: { page: number; pageSize: number } = { page: 2, pageSize: 30 },
  settings = { baseURL: BASE, apiKey: KEY },
  deadlineMs = 1_000,
) {
  return listRagflowChunks(
    settings,
    DATASET,
    DOCUMENT,
    query,
    new AbortController().signal,
    deadlineMs,
    send,
  );
}
/** A body that stays open until the request signal aborts, like undici's fetch body. */
function heldBody(signal: AbortSignal, first: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
      signal.addEventListener('abort', () => {
        controller.error(signal.reason);
      });
    },
  });
}

it.each([
  ['an empty address', { baseURL: '', apiKey: KEY }],
  ['an empty key', { baseURL: BASE, apiKey: '' }],
  ['a key that cannot form a header', { baseURL: BASE, apiKey: `${KEY}\nX-Injected: 1` }],
])('lists no chunks for %s and reports not-configured', async (_label, settings) => {
  const send = sender(() => new Response(chunkPage([])));

  expect(await chunks(send, undefined, settings)).toEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it('reads one chunk page with the key and returns only the total and each text in order', async () => {
  const send = sender(() => new Response(chunkPage([chunkRow(1), chunkRow(2)], 2)));

  const outcome = await chunks(send);

  expect(outcome).toEqual({
    result: 'ok',
    total: 2,
    chunks: [{ content: '第 1 段' }, { content: '第 2 段' }],
  });
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0]?.[0];
  // Neither `available` nor `keywords`: disabled chunks are shown, nothing is searched.
  expect([request?.method, request?.url, request?.redirect]).toEqual([
    'GET',
    `${CHUNKS_URL}?page=2&page_size=30`,
    'manual',
  ]);
  expect(request?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
});

it('keeps a chunk text verbatim, markup and surrounding whitespace included', async () => {
  const text = '  <b>x</b>\n<script>alert(1)</script>  ';
  const send = sender(() => new Response(chunkPage([chunkRow(1, text), chunkRow(2, '')], 9)));

  expect(await chunks(send)).toEqual({
    result: 'ok',
    total: 9,
    chunks: [{ content: text }, { content: '' }],
  });
});

it('reports a page past the end as ok with no chunks and the upstream total', async () => {
  expect(await chunks(sender(() => new Response(chunkPage([], 2))))).toEqual({
    result: 'ok',
    total: 2,
    chunks: [],
  });
});

it('accepts a page exactly as long as the requested page size', async () => {
  const send = sender(() => new Response(chunkPage([chunkRow(1), chunkRow(2)], 7)));

  expect((await chunks(send, { page: 1, pageSize: 2 })).result).toBe('ok');
});

it.each([
  ['an existing document in a library the key cannot see (code 403)', '{"code":403}'],
  ['an existing document in a library the key cannot find (code 404)', '{"code":404}'],
])('maps %s at HTTP 200 to invalid-request', async (_label, body) => {
  expect(await chunks(sender(() => new Response(body)))).toEqual({ result: 'invalid-request' });
});

it.each([
  [
    'a missing document or library (HTTP 500, code 500)',
    () => new Response('{"code":500,"data":null,"message":"x"}', { status: 500 }),
    'upstream-error',
  ],
  [
    'another non-zero code at HTTP 200',
    () => new Response('{"code":102,"data":null}'),
    'upstream-error',
  ],
  ['a rejected key (code 401)', () => new Response('{"code":401}'), 'not-configured'],
  ['a rejected key status', () => new Response(null, { status: 403 }), 'not-configured'],
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
] as const)('maps %s to its closed result', async (_label, respond, result) => {
  expect(await chunks(sender(respond))).toEqual({ result });
});

it.each([
  ['another document', chunkPage([chunkRow(1)], 1, { ...DOC, id: 'f'.repeat(32) })],
  [
    'a document of another library',
    chunkPage([chunkRow(1)], 1, { ...DOC, dataset_id: 'f'.repeat(32) }),
  ],
  ['a document without an id', chunkPage([chunkRow(1)], 1, { dataset_id: DATASET })],
  ['a document without a library', chunkPage([chunkRow(1)], 1, { id: DOCUMENT })],
  ['a missing document', JSON.stringify({ code: 0, data: { chunks: [chunkRow(1)], total: 1 } })],
  ['a null document', chunkPage([chunkRow(1)], 1, null)],
  ['another document on an empty page', chunkPage([], 0, { ...DOC, id: 'f'.repeat(32) })],
  ['more rows than the page size', chunkPage([chunkRow(1), chunkRow(2), chunkRow(3)], 3)],
  [
    'a row without content_with_weight',
    chunkPage([{ ...chunkRow(1), content_with_weight: undefined }]),
  ],
  ['a row with only the stale content field', chunkPage([{ chunk_id: '1', content: 'x' }])],
  ['a numeric content_with_weight', chunkPage([{ ...chunkRow(1), content_with_weight: 7 }])],
  ['a null row', chunkPage([null])],
  ['a string row', chunkPage(['x'])],
  ['non-array chunks', chunkPage({ 0: chunkRow(1) }, 1)],
  ['a negative total', chunkPage([], -1)],
  ['a fractional total', chunkPage([], 1.5)],
  ['a string total', chunkPage([], '0')],
  ['a missing total', JSON.stringify({ code: 0, data: { chunks: [], doc: DOC } })],
  ['a null data', JSON.stringify({ code: 0, data: null })],
])('rejects the whole page with %s as upstream-error', async (_label, body) => {
  const send = sender(() => new Response(body));

  expect(await chunks(send, { page: 1, pageSize: 2 })).toEqual({ result: 'upstream-error' });
});

it('reads a chunk page larger than 64 KiB and rejects one byte over 8 MiB unread', async () => {
  const padded = JSON.stringify({
    code: 0,
    data: { chunks: [chunkRow(1)], doc: DOC, total: 1 },
    padding: 'x'.repeat(8_388_608 - 800),
  });
  const pulls: number[] = [];
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.push(pulls.length);
      controller.enqueue(new Uint8Array(pulls.length === 1 ? 8_388_609 : 1_048_576));
    },
  });

  const large = await chunks(sender(() => new Response(padded)));
  const rejected = await chunks(sender(() => new Response(oversized)));

  expect(new TextEncoder().encode(padded).byteLength).toBeLessThanOrEqual(8_388_608);
  expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(65_536);
  expect(large).toEqual({ result: 'ok', total: 1, chunks: [{ content: '第 1 段' }] });
  expect(rejected).toEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it('reports a chunk page that stalls past the deadline as timeout', async () => {
  const send = sender((_request, signal) => new Response(heldBody(signal, '{"code":0,')));

  expect(await chunks(send, undefined, undefined, 20)).toEqual({ result: 'timeout' });
});

it('propagates an external cancellation while reading chunks instead of classifying it', async () => {
  const owner = new AbortController();
  const send = sender((_request, signal) => {
    queueMicrotask(() => {
      owner.abort();
    });
    return new Response(heldBody(signal, '{'));
  });

  await expect(
    listRagflowChunks(
      { baseURL: BASE, apiKey: KEY },
      DATASET,
      DOCUMENT,
      { page: 1, pageSize: 10 },
      owner.signal,
      60_000,
      send,
    ),
  ).rejects.toThrow();
});

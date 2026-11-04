import type {
  FastifyError,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { isJsonMediaType } from '../auth/index.ts';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withRequestAbort } from '../request-abort.ts';
import {
  MAX_DATASETS,
  RAGFLOW_DATASET_ID_PATTERN,
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_VERSION_PATTERN,
  listRagflowDatasets,
  listRagflowDocuments,
  ragflowVersion,
  retrieveRagflow,
} from './client.ts';
import type { RagflowDocumentsQuery, RagflowRetrievalRequest, RagflowSettings } from './client.ts';
import { INSTANCE_ERRORS } from './instance-auth.ts';

const ERROR_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;
/** A closed-set result that carries the version only when it is `ok`. */
export const RAGFLOW_VERSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    version: { type: 'string', pattern: RAGFLOW_VERSION_PATTERN, maxLength: 64 },
  },
} as const;

/** Listed datasets and documents. */
const ENTRIES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    // Closed at both levels so the serializer drops any upstream field a mapping defect let through.
    additionalProperties: false,
    required: ['id', 'name'],
    properties: {
      id: { type: 'string', pattern: RAGFLOW_DATASET_ID_PATTERN },
      name: { type: 'string', minLength: 1 },
    },
  },
} as const;
/** A closed-set result that carries only each dataset's ID and name when it is `ok`. */
const RAGFLOW_DATASETS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    datasets: ENTRIES_SCHEMA,
  },
} as const;
/** A closed-set result that carries the filtered total and one page of documents when `ok`. */
const RAGFLOW_DOCUMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    total: { type: 'integer', minimum: 0 },
    documents: ENTRIES_SCHEMA,
  },
} as const;
const DATASET_ID = new RegExp(RAGFLOW_DATASET_ID_PATTERN);
const PAGE_PATTERN = '^[1-9][0-9]{0,5}$';
const PAGE = new RegExp(PAGE_PATTERN);
// rc2 silently replaces a page size outside 1..100 with 10 instead of rejecting it.
const PAGE_SIZE_PATTERN = '^(100|[1-9][0-9]?)$';
const PAGE_SIZE = new RegExp(PAGE_SIZE_PATTERN);
const MAX_KEYWORDS_BYTES = 256;
const MAX_QUESTION_BYTES = 4_096;
// A 4096-byte question and 1000 IDs take about 35 KB.
const RETRIEVAL_BODY_LIMIT = 65_536;
/** A closed-set result that carries the excluded IDs when retrieved and the chunks when `ok`. */
const RAGFLOW_RETRIEVAL_SCHEMA = {
  type: 'object',
  // Closed at both levels so the serializer drops any upstream field a mapping defect let through.
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { type: 'string', enum: RAGFLOW_RESULTS },
    excluded: { type: 'array', items: { type: 'string', pattern: RAGFLOW_DATASET_ID_PATTERN } },
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'documentName', 'datasetName'],
        properties: {
          content: { type: 'string' },
          documentName: { type: 'string', minLength: 1 },
          datasetName: { type: 'string', minLength: 1 },
          positions: {
            type: 'array',
            description:
              "RAGFlow's position tuples, present only when it has any. Their meaning depends " +
              'on the file type; for a PDF the first number is the 1-based page.',
            minItems: 1,
            maxItems: 1_024,
            items: { type: 'array', minItems: 5, maxItems: 5, items: { type: 'number' } },
          },
        },
      },
    },
  },
} as const;
/** Documents the request; the handler's own check is the authority. */
const RETRIEVAL_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'datasetIds'],
  properties: {
    question: {
      type: 'string',
      description: `Must not be blank; at most ${String(MAX_QUESTION_BYTES)} UTF-8 bytes.`,
    },
    datasetIds: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_DATASETS,
      uniqueItems: true,
      items: { type: 'string', pattern: RAGFLOW_DATASET_ID_PATTERN },
    },
  },
} as const;

/**
 * Empty or only whitespace as rc2 trims it: Go's TrimSpace also strips U+0085, which JS `trim`
 * keeps, so a text that looks non-blank here would reach rc2 empty.
 */
function isBlank(text: string): boolean {
  return /^[\s\u0085]*$/u.test(text);
}

/** The decoded name/value pairs of a raw request target, or null when any item is malformed. */
function queryFields(url: string): Map<string, string> | null {
  // The router stops at "#" while the raw target keeps it; no fragment is a request.
  if (url.includes('#')) return null;
  const start = url.indexOf('?');
  const fields = new Map<string, string>();
  if (start === -1) return fields;
  // URLSearchParams never rejects: it keeps "%zz" and turns "%ff" into U+FFFD.
  const decode = (text: string) => decodeURIComponent(text.replaceAll('+', ' '));
  for (const item of url.slice(start + 1).split('&')) {
    const split = item.indexOf('=');
    if (split === -1) return null;
    let name: string;
    let value: string;
    try {
      name = decode(item.slice(0, split));
      value = decode(item.slice(split + 1));
    } catch {
      // URIError: an escape that is not percent-encoded UTF-8.
      return null;
    }
    if (fields.has(name)) return null;
    fields.set(name, value);
  }
  return fields;
}

/**
 * The page a document request asks for, parsed from the raw target because Ajv's
 * `removeAdditional` and type coercion rewrite `request.query`; null for anything else.
 */
function documentsQuery(url: string): RagflowDocumentsQuery | null {
  const fields = queryFields(url);
  if (fields === null) return null;
  const page = fields.get('page');
  const pageSize = fields.get('page_size');
  const keywords = fields.get('keywords');
  // Any key beside these three is unknown.
  if (fields.size !== (keywords === undefined ? 2 : 3)) return null;
  if (page === undefined || !PAGE.test(page)) return null;
  if (pageSize === undefined || !PAGE_SIZE.test(pageSize)) return null;
  if (keywords === undefined) return { page: Number(page), pageSize: Number(pageSize) };
  // A blank filter would silently list every document.
  if (isBlank(keywords) || Buffer.byteLength(keywords) > MAX_KEYWORDS_BYTES) return null;
  return { page: Number(page), pageSize: Number(pageSize), keywords };
}

const isDatasetId = (value: unknown): value is string =>
  typeof value === 'string' && DATASET_ID.test(value);

/** 1..1000 distinct dataset IDs, or null for anything else. */
function datasetIdsOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DATASETS) return null;
  const ids: readonly unknown[] = value;
  if (!ids.every(isDatasetId) || new Set(ids).size !== ids.length) return null;
  return ids;
}

/** The question and scope of a retrieval body, or null for anything else. */
function retrievalRequest(body: unknown): RagflowRetrievalRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  // Any other key, retrieval parameters included, is not the instance's to send.
  if (Object.keys(body).length !== 2 || !('question' in body) || !('datasetIds' in body))
    return null;
  const { question } = body;
  if (typeof question !== 'string' || isBlank(question)) return null;
  if (Buffer.byteLength(question) > MAX_QUESTION_BYTES) return null;
  const datasetIds = datasetIdsOf(body.datasetIds);
  // The question is forwarded verbatim, untrimmed.
  return datasetIds === null ? null : { question, datasetIds };
}

/** Refuses any media type but JSON before the body is read; the root hook has run first. */
function requireJson(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  if (isJsonMediaType(request.headers['content-type'])) {
    done();
    return;
  }
  void reply.code(415).send(INSTANCE_ERRORS[415]);
}

/**
 * Maps a retrieval body error. Fastify's own handler would log the error object, whose text can
 * quote the request, so every other error is the fixed 500 with fixed log text.
 */
function retrievalBodyError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Prototype-poisoning keys fail as invalid JSON as well.
  if (
    error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
  ) {
    void reply.code(200).send({ result: 'invalid-request' });
    return;
  }
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    void reply.code(413).send(INSTANCE_ERRORS[413]);
    return;
  }
  request.log.error('RAGFlow proxy retrieval request failure');
  void reply.code(500).send(INSTANCE_ERRORS[500]);
}

/**
 * Instance-facing RAGFlow routes. The root authentication hook has admitted every request that
 * reaches them; an answered request is HTTP 200 with a closed-set `result`.
 */
export const ragflowProxyRoutes: FastifyPluginCallback<{
  database: DatabaseHandle;
  /** Aborted by the application before it drains in-flight responses. */
  shutdown: AbortSignal;
}> = (app, { database, shutdown }, done) => {
  /**
   * One read of the saved RAGFlow connection and retrieval parameters; any failure is the fixed
   * 500 with `failure` logged.
   */
  async function relay<T>(
    reply: FastifyReply,
    read: (settings: RagflowSettings, signal: AbortSignal, deadlineMs: number) => Promise<T>,
    failure: string,
  ): Promise<T> {
    try {
      return await withRequestAbort(reply, shutdown, (signal) => {
        const settings = readSettings(database);
        return read(
          {
            baseURL: settings.ragflowBaseUrl,
            apiKey: settings.ragflowApiKey,
            retrievalTopK: settings.retrievalTopK,
            retrievalSimilarityThreshold: settings.retrievalSimilarityThreshold,
            retrievalKeywordsWeight: settings.retrievalKeywordsWeight,
            retrievalRerankId: settings.retrievalRerankId,
          },
          signal,
          RAGFLOW_TIMEOUT_MS,
        );
      });
    } catch {
      // Storage and cancellation text stay out; the outcome set has no failure of its own.
      app.log.error(failure);
      return await reply.code(500).send(INSTANCE_ERRORS[500]);
    }
  }

  app.get(
    '/_platform/instance-api/ragflow/version',
    {
      // An implicit HEAD route would reach RAGFlow outside the declared interface.
      exposeHeadRoute: false,
      schema: {
        summary: 'Read the version of the configured RAGFlow for an authenticated instance',
        response: {
          200: RAGFLOW_VERSION_SCHEMA,
          401: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    (_request, reply) => relay(reply, ragflowVersion, 'RAGFlow proxy version failure'),
  );
  app.get(
    '/_platform/instance-api/ragflow/datasets',
    {
      exposeHeadRoute: false,
      schema: {
        summary:
          'List the ID and name of every dataset of the configured RAGFlow for an authenticated ' +
          'instance. Any query string, even a bare "?", answers invalid-request without ' +
          'contacting RAGFlow.',
        response: {
          200: RAGFLOW_DATASETS_SCHEMA,
          401: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    // No querystring schema: Ajv's removeAdditional would silently drop unknown parameters.
    (request, reply) =>
      request.url.includes('?')
        ? Promise.resolve({ result: 'invalid-request' as const })
        : relay(reply, listRagflowDatasets, 'RAGFlow proxy datasets failure'),
  );
  app.get<{ Params: { id: string } }>(
    '/_platform/instance-api/ragflow/datasets/:id/documents',
    {
      exposeHeadRoute: false,
      // The schemas document the contract; the handler's own raw parse is the authority.
      attachValidation: true,
      schema: {
        summary:
          'List one page of the ID and name of the documents of one dataset of the configured ' +
          'RAGFlow, oldest first, for an authenticated instance. keywords filters by file name ' +
          "with RAGFlow's unescaped LIKE semantics and must not be blank. A malformed dataset " +
          'ID, a fragment, a repeated, unknown or valueless key, an undecodable escape and a ' +
          'dataset the key cannot see answer invalid-request.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: RAGFLOW_DATASET_ID_PATTERN } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['page', 'page_size'],
          properties: {
            page: { type: 'string', pattern: PAGE_PATTERN },
            page_size: { type: 'string', pattern: PAGE_SIZE_PATTERN },
            keywords: {
              type: 'string',
              description: `Must not be blank; at most ${String(MAX_KEYWORDS_BYTES)} UTF-8 bytes.`,
            },
          },
        },
        response: {
          200: RAGFLOW_DOCUMENTS_SCHEMA,
          401: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) => {
      const id = request.params.id;
      const query = documentsQuery(request.url);
      if (query === null || !DATASET_ID.test(id))
        return Promise.resolve({ result: 'invalid-request' as const });
      return relay(
        reply,
        (settings, signal, deadlineMs) =>
          listRagflowDocuments(settings, id, query, signal, deadlineMs),
        'RAGFlow proxy documents failure',
      );
    },
  );
  app.post(
    '/_platform/instance-api/ragflow/retrieval',
    {
      bodyLimit: RETRIEVAL_BODY_LIMIT,
      // Ajv's removeAdditional would silently drop top_k and its coercion would turn "abc" into
      // ["abc"]; the schema documents the contract and the handler's own check is the authority.
      validatorCompiler: () => (value: unknown) => ({ value }),
      onRequest: requireJson,
      errorHandler: retrievalBodyError,
      schema: {
        summary:
          'Retrieve chunks of the given datasets of the configured RAGFlow with the saved ' +
          'retrieval parameters for an authenticated instance. Requested datasets that no ' +
          'longer exist are dropped and listed in excluded; when none remains nothing is ' +
          'retrieved and the result is no-results. Any other body key, a blank question, an ' +
          'empty, repeated or malformed dataset ID and unparseable JSON answer invalid-request.',
        body: RETRIEVAL_BODY_SCHEMA,
        response: {
          200: RAGFLOW_RETRIEVAL_SCHEMA,
          401: ERROR_SCHEMA,
          413: ERROR_SCHEMA,
          415: ERROR_SCHEMA,
          500: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) => {
      const retrieval = retrievalRequest(request.body);
      if (retrieval === null) return Promise.resolve({ result: 'invalid-request' as const });
      return relay(
        reply,
        (settings, signal, deadlineMs) => retrieveRagflow(settings, retrieval, signal, deadlineMs),
        'RAGFlow proxy retrieval failure',
      );
    },
  );
  done();
};

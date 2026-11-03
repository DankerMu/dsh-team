import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { readSettings } from '../db/index.ts';
import type { DatabaseHandle } from '../db/index.ts';
import { withRequestAbort } from '../request-abort.ts';
import {
  RAGFLOW_DATASET_ID_PATTERN,
  RAGFLOW_RESULTS,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_VERSION_PATTERN,
  listRagflowDatasets,
  listRagflowDocuments,
  ragflowVersion,
} from './client.ts';
import type { RagflowDocumentsQuery } from './client.ts';
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
  // rc2 trims the filter, so a blank one would silently list every document.
  if (keywords.trim() === '' || Buffer.byteLength(keywords) > MAX_KEYWORDS_BYTES) return null;
  return { page: Number(page), pageSize: Number(pageSize), keywords };
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
  /** One read of the saved RAGFlow connection; any failure is the fixed 500 with `failure` logged. */
  async function relay<T>(
    reply: FastifyReply,
    read: (
      settings: { baseURL: string; apiKey: string },
      signal: AbortSignal,
      deadlineMs: number,
    ) => Promise<T>,
    failure: string,
  ): Promise<T> {
    try {
      return await withRequestAbort(reply, shutdown, (signal) => {
        const settings = readSettings(database);
        return read(
          { baseURL: settings.ragflowBaseUrl, apiKey: settings.ragflowApiKey },
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
            keywords: { type: 'string', minLength: 1, maxLength: MAX_KEYWORDS_BYTES },
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
  done();
};

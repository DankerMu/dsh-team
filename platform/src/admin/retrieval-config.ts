import type { FastifyPluginCallback } from 'fastify';
import { isPlainObject } from '../plain-object.ts';
import { registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const FIELDS = [
  'retrievalTopK',
  'retrievalSimilarityThreshold',
  'retrievalKeywordsWeight',
  'retrievalRerankId',
];
const RATIO_SCHEMA = { type: 'number', minimum: 0, maximum: 1 } as const;
// Contract documentation only: patch() checks the envelope and the settings layer owns domains.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: FIELDS,
  properties: {
    retrievalTopK: { type: 'integer', minimum: 1, maximum: 100 },
    retrievalSimilarityThreshold: RATIO_SCHEMA,
    retrievalKeywordsWeight: RATIO_SCHEMA,
    retrievalRerankId: { type: 'string' },
  },
} as const;
const DOMAINS =
  'Allowed domains: retrievalTopK: integer 1..100 (returned chunk count); ' +
  'retrievalSimilarityThreshold, retrievalKeywordsWeight: finite numbers 0..1; ' +
  'retrievalRerankId: rerank model ID without surrounding whitespace, or empty for no reranking';

export const retrievalConfigRoutes: FastifyPluginCallback<AdminConfigOptions> = (
  app,
  options,
  done,
) => {
  registerConfigRoute(app, options, {
    name: 'retrieval',
    path: '/_platform/api/admin/retrieval-config',
    auditType: 'retrieval-config.updated',
    bodySchema: SCHEMA,
    responseSchema: SCHEMA,
    invalidMessage: `Invalid retrieval configuration; provide exactly ${FIELDS.join(', ')}. ${DOMAINS}`,
    validationGuidance: DOMAINS,
    patch(body) {
      // Whole replacement: every field is required and writeSettings validates raw values.
      if (
        !isPlainObject(body) ||
        Object.keys(body).some((key) => !FIELDS.includes(key)) ||
        FIELDS.some((key) => !Object.hasOwn(body, key))
      )
        return null;
      return body;
    },
    validate(settings) {
      // RAGFlow receives a nonempty ID verbatim as rerank_id; whitespace would fail every search.
      const id = settings.retrievalRerankId;
      if (id !== '' && id.trim() !== id)
        throw new Error(
          'retrievalRerankId must be empty or a rerank model ID without surrounding whitespace',
        );
    },
    project(settings) {
      return {
        retrievalTopK: settings.retrievalTopK,
        retrievalSimilarityThreshold: settings.retrievalSimilarityThreshold,
        retrievalKeywordsWeight: settings.retrievalKeywordsWeight,
        retrievalRerankId: settings.retrievalRerankId,
      };
    },
  });
  done();
};

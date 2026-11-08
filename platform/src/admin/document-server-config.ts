import type { FastifyPluginCallback } from 'fastify';
import { documentServerMode, isRagflowBaseUrl } from '../db/index.ts';
import { isPlainObject } from '../plain-object.ts';
import { registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const EXTERNAL_FIELDS = ['mode', 'url', 'jwtSecret'];
const URL_SCHEMA = { type: 'string', minLength: 1, maxLength: 2048 } as const;

/** `{ mode: 'external', url, jwtSecret? }`: an omitted JWT keeps the stored one. */
function externalPatch(body: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.keys(body).some((key) => !EXTERNAL_FIELDS.includes(key))) return null;
  const { url, jwtSecret } = body;
  if (typeof url !== 'string' || !isRagflowBaseUrl(url)) return null;
  if (!Object.hasOwn(body, 'jwtSecret')) return { documentServerUrl: url };
  if (typeof jwtSecret !== 'string' || jwtSecret.trim() === '') return null;
  return { documentServerUrl: url, documentServerJwtSecret: jwtSecret };
}

export const documentServerConfigRoutes: FastifyPluginCallback<
  AdminConfigOptions & { documentServerBundled: boolean }
> = (app, options, done) => {
  registerConfigRoute(app, options, {
    name: 'document-server',
    path: '/_platform/api/admin/document-server',
    auditType: 'document-server-config.updated',
    // Contract documentation only: patch(), validate() and the settings layer own validation.
    bodySchema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['bundled'] } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'url'],
          properties: {
            mode: { type: 'string', enum: ['external'] },
            url: URL_SCHEMA,
            jwtSecret: { type: 'string', minLength: 1 },
          },
        },
      ],
    },
    responseSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'bundledConfigured', 'url', 'jwtConfigured'],
      properties: {
        mode: { type: 'string', enum: ['bundled', 'external'] },
        bundledConfigured: { type: 'boolean' },
        url: { type: 'string' },
        jwtConfigured: { type: 'boolean' },
      },
    },
    invalidMessage:
      "Invalid Document Server configuration; provide { mode: 'bundled' } or { mode: 'external', url: http(s) URL without credentials, query or fragment, jwtSecret?: non-blank string }",
    patch(body) {
      if (!isPlainObject(body)) return null;
      if (body.mode === 'external') return externalPatch(body);
      if (body.mode !== 'bundled' || Object.keys(body).length !== 1) return null;
      // Switching back to the bundled server clears the external pair.
      return { documentServerUrl: '', documentServerJwtSecret: '' };
    },
    validate(settings) {
      // The stored address and JWT are both empty (bundled) or both set (external).
      if ((settings.documentServerUrl === '') !== (settings.documentServerJwtSecret === ''))
        throw new Error('External Document Server requires jwtSecret');
    },
    project(settings) {
      return {
        mode: documentServerMode(settings),
        bundledConfigured: options.documentServerBundled,
        url: settings.documentServerUrl,
        jwtConfigured: settings.documentServerJwtSecret !== '',
      };
    },
  });
  done();
};

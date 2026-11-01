import type { FastifyPluginCallback } from 'fastify';
import { CATALOG_STATES, catalogStates } from '../plugin-catalog/index.ts';
import type { PluginCatalog } from '../plugin-catalog/index.ts';
import { isPlainObject, registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const STATE_SCHEMA = { type: 'string', enum: CATALOG_STATES } as const;
const BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      description: 'Every catalog id exactly once; required entries must be forced-on.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'state'],
        properties: { id: { type: 'string' }, state: STATE_SCHEMA },
      },
    },
  },
} as const;
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'package', 'name', 'category', 'imageDefaultEnabled', 'state'],
        properties: {
          id: { type: 'string' },
          package: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string', enum: ['required', 'manageable'] },
          imageDefaultEnabled: { type: 'boolean' },
          state: STATE_SCHEMA,
        },
      },
    },
  },
} as const;

/** The submitted state per catalog id, or null unless it names every catalog id exactly once. */
function submittedStates(body: unknown, size: number): Map<unknown, unknown> | null {
  if (!isPlainObject(body) || Object.keys(body).join() !== 'entries') return null;
  const { entries } = body;
  if (!Array.isArray(entries) || entries.length !== size) return null;
  const states = new Map<unknown, unknown>();
  for (const item of entries as unknown[]) {
    if (!isPlainObject(item) || Object.keys(item).sort().join() !== 'id,state') return null;
    states.set(item.id, item.state);
  }
  return states.size === size ? states : null;
}

export const pluginCatalogRoutes: FastifyPluginCallback<
  AdminConfigOptions & { catalog: PluginCatalog }
> = (app, { catalog, ...options }, done) => {
  registerConfigRoute(app, options, {
    name: 'plugin-catalog',
    path: '/_platform/api/admin/plugin-catalog',
    auditType: 'plugin-catalog.updated',
    bodySchema: BODY_SCHEMA,
    responseSchema: RESPONSE_SCHEMA,
    invalidMessage:
      'Invalid plugin catalog; provide exactly { entries: [{ id, state }] } covering every catalog entry once. ' +
      `Allowed states: ${CATALOG_STATES.join(' | ')}; required entries must be forced-on`,
    patch(body) {
      const states = submittedStates(body, catalog.entries.length);
      if (states === null) return null;
      const pluginCatalog: Record<string, unknown> = {};
      for (const { id, category } of catalog.entries) {
        const state = states.get(id);
        if (typeof state !== 'string' || !CATALOG_STATES.some((allowed) => allowed === state))
          return null;
        if (category === 'required') {
          if (state !== 'forced-on') return null;
        } else pluginCatalog[id] = state;
      }
      // The whole map is replaced, so ids that left the catalog disappear on save.
      return { pluginCatalog };
    },
    project(settings) {
      return { entries: catalogStates(catalog, settings) };
    },
  });
  done();
};

import type { FastifyPluginCallback } from 'fastify';
import { PERMISSION_TIERS } from '../db/index.ts';
import { validateSubnetPool } from '../orchestrator/index.ts';
import { registerConfigRoute } from './config-route.ts';
import type { AdminConfigOptions } from './config-route.ts';

const FIELDS = [
  'idleMinutes',
  'cpuCores',
  'memoryMiB',
  'maxRunningInstances',
  'defaultPermissionTier',
];
const INTEGER_SCHEMA = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: FIELDS,
  properties: {
    idleMinutes: INTEGER_SCHEMA,
    cpuCores: { type: 'number', exclusiveMinimum: 0, maximum: Number.MAX_VALUE },
    memoryMiB: INTEGER_SCHEMA,
    maxRunningInstances: {
      ...INTEGER_SCHEMA,
      description: 'Must not exceed the configured PLATFORM_SUBNET_POOL capacity in /28 subnets.',
    },
    defaultPermissionTier: { type: 'string', enum: PERMISSION_TIERS },
  },
} as const;
const DOMAINS =
  'Allowed domains: idleMinutes, memoryMiB, maxRunningInstances: positive safe integers 1..9007199254740991; ' +
  'cpuCores: finite positive number (> 0), fractional cores allowed; ' +
  `defaultPermissionTier: ${PERMISSION_TIERS.join(' | ')}`;

export const runtimeConfigRoutes: FastifyPluginCallback<
  AdminConfigOptions & { subnetPool: string }
> = (app, options, done) => {
  registerConfigRoute(app, options, {
    name: 'runtime',
    path: '/_platform/api/admin/runtime-config',
    auditType: 'runtime-config.updated',
    bodySchema: SCHEMA,
    responseSchema: SCHEMA,
    invalidMessage: `Invalid runtime configuration; provide exactly ${FIELDS.join(', ')}. ${DOMAINS}`,
    validationGuidance: DOMAINS,
    patch(body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
      // Envelope only: canonical writeSettings validates all raw values without coercion.
      const input = body as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => !FIELDS.includes(key)) ||
        FIELDS.some((key) => !Object.hasOwn(input, key))
      )
        return null;
      return input;
    },
    validate(settings) {
      validateSubnetPool(options.subnetPool, settings.maxRunningInstances);
    },
    project(settings) {
      return {
        idleMinutes: settings.idleMinutes,
        cpuCores: settings.cpuCores,
        memoryMiB: settings.memoryMiB,
        maxRunningInstances: settings.maxRunningInstances,
        defaultPermissionTier: settings.defaultPermissionTier,
      };
    },
  });
  done();
};

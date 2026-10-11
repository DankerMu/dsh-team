import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { PlatformConfig } from '../src/config.ts';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import type { DockerClient } from '../src/orchestrator/index.ts';
import { startupOwnerFixture } from './container-start-fixture.ts';

export function instanceConfig(
  root: string,
  overrides: Partial<PlatformConfig> = {},
): PlatformConfig {
  return {
    ...loadConfig({
      PLATFORM_PUBLIC_URL: 'http://instance.example',
      PLATFORM_DATA_DIR: root,
      PLATFORM_UPSTREAM_MODE: 'published-loopback',
      PLATFORM_COOKIE_SECURE: 'false',
    }),
    port: 0,
    logLevel: 'silent',
    seccompProfilePath: join(root, 'seccomp.json'),
    ...overrides,
  };
}

/** Exercise both real public identity endpoints; no seeded employee/session bypass. */
export async function registerInstanceUser(base: string, origin: string, email: string) {
  const headers = { origin, 'content-type': 'application/json' };
  const payload = JSON.stringify({ email, password: 'instance-acceptance-password' });
  const registered = await fetch(`${base}/_platform/api/register`, {
    method: 'POST',
    headers,
    body: payload,
  });
  expect(registered.status).toBe(201);
  const identity: unknown = await registered.json();
  if (
    typeof identity !== 'object' ||
    identity === null ||
    !('id' in identity) ||
    typeof identity.id !== 'string'
  )
    throw new Error('Missing registered identity');
  const loggedIn = await fetch(`${base}/_platform/api/login`, {
    method: 'POST',
    headers,
    body: payload,
  });
  expect(loggedIn.status).toBe(200);
  const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
  if (cookie?.startsWith('platform_session=') !== true) throw new Error('Missing platform session');
  await loggedIn.arrayBuffer();
  return { id: identity.id, cookie };
}

export async function instanceServiceFixture(adapt?: (client: DockerClient) => DockerClient) {
  const context = await startupOwnerFixture();
  const service = createInstanceService({
    ...context,
    client: adapt?.(context.client) ?? context.client,
    config: instanceConfig(context.root, context.input.config),
  });
  return {
    ...context,
    service,
    async close() {
      await service.close();
      context.database.close();
      await rm(context.root, { recursive: true, force: true });
    },
  };
}

export function configureInstanceModel(database: DatabaseHandle) {
  writeSettings(database, {
    modelBaseUrl: 'http://model.invalid/v1',
    modelApiKey: 'service-key',
    models: [{ name: 'office-model' }],
    defaultModel: 'office-model',
  });
}

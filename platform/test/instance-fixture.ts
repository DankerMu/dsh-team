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
import { sessionCookieToken } from './auth-fixture.ts';
import { caseBudget } from './trusted-docker-fixture.ts';

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
export async function registerInstanceUser(
  base: string,
  origin: string,
  email: string,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  const headers = { origin, 'content-type': 'application/json' };
  const payload = JSON.stringify({ email, password: 'instance-acceptance-password' });
  const registered = await request(`${base}/_platform/api/register`, {
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
  const loggedIn = await request(`${base}/_platform/api/login`, {
    method: 'POST',
    headers,
    body: payload,
  });
  expect(loggedIn.status).toBe(200);
  const cookie = `platform_session=${sessionCookieToken(loggedIn.headers.getSetCookie())}`;
  const registrationCookie = `platform_session=${sessionCookieToken(registered.headers.getSetCookie())}`;
  await loggedIn.arrayBuffer();
  return { id: identity.id, cookie, registrationCookie };
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

/** Hold only the Engine's follow stream; other readiness diagnostics remain real. */
export function heldReadinessLogs(message: string) {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let aborted = false;
  return {
    entered: entered.promise,
    get aborted() {
      return aborted;
    },
    release() {
      release.resolve(undefined);
    },
    adapt: (client: DockerClient): DockerClient => {
      return {
        ...client,
        async *logs(path, signal) {
          if (!path.includes('follow=true')) {
            yield* client.logs(path, signal);
            return;
          }
          entered.resolve(undefined);
          const cancel = () => {
            aborted = true;
            release.resolve(undefined);
          };
          signal?.addEventListener('abort', cancel, { once: true });
          try {
            if (signal?.aborted) cancel();
            await release.promise;
            throw new Error(message);
          } finally {
            signal?.removeEventListener('abort', cancel);
          }
        },
      };
    },
  };
}

// The readiness wait from the start's answer; caseBudget cuts each poll fetch to the case deadline.
const READINESS_FAILURE_WAIT_MS = 5000;

/** Bounded readiness polls; each timeout exit names its elapsed ms, poll count and DB status. */
export function readinessPolls(
  f: { readonly base: string; readonly database: DatabaseHandle },
  cookie: string,
  deadline: number,
) {
  const budget = caseBudget(deadline);
  const since = Date.now();
  let polls = 0;
  const stalled = (reason: string, cause?: unknown) => {
    const row: unknown = f.database.prepare('SELECT status FROM instances').get();
    const seen = `${String(Date.now() - since)}ms: polls=${String(polls)} db=${JSON.stringify(row)}`;
    const api = 'Readiness failure was not reflected by the public API';
    return new Error(`${api} (${reason}) after ${seen}`, { cause });
  };
  return async () => {
    // The wait's own deadline, checked before each further poll as the loop once checked it.
    if (Date.now() >= since + READINESS_FAILURE_WAIT_MS) throw stalled('wait expired');
    let signal: AbortSignal;
    try {
      signal = AbortSignal.timeout(budget.limit('readiness poll', READINESS_FAILURE_WAIT_MS));
    } catch (error) {
      throw stalled('case deadline passed', error);
    }
    polls += 1;
    try {
      const response = await fetch(`${f.base}/_platform/api/instance`, {
        headers: { cookie },
        signal,
      });
      const current: unknown = await response.json();
      return { status: response.status, current };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw stalled('poll aborted', error);
      throw error;
    }
  };
}

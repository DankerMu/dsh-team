import { join } from 'node:path';
import { expect } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { PlatformConfig } from '../src/config.ts';

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

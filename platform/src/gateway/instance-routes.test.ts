import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  cookieHeaders,
  injectRegister,
  jsonRequestHeaders,
  PUBLIC_ORIGIN,
  sessionCookieToken,
  withApp,
} from '../../test/auth-fixture.ts';
import { startupOwnerFixture } from '../../test/container-start-fixture.ts';
import { instanceConfig } from '../../test/instance-fixture.ts';
import { buildApp } from '../app.ts';
import { createInstanceService } from '../orchestrator/index.ts';

it.each(['GET', 'POST'] as const)(
  'declares the offline %s entrypoint but requires a current session',
  async (method) => {
    await withApp(async (app) => {
      const url = method === 'GET' ? '/_platform/api/instance' : '/_platform/api/instance/start';
      const headers = method === 'GET' ? {} : jsonRequestHeaders();
      const anonymous = await app.inject({
        method,
        url,
        headers,
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(anonymous.statusCode).toBe(401);
      const registered = await injectRegister(app, {
        email: 'instance@example.test',
        password: 'test-password',
      });
      const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
      const offline = await app.inject({
        method,
        url,
        headers: { ...headers, cookie },
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(offline.statusCode).toBe(503);
      expect(offline.json()).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Instance service unavailable',
      });
      await app.ready();
      const document = app.swagger();
      expect(document.paths?.[url]).toBeDefined();
    });
  },
);

it.each([
  '{"userId":"abcdefghijkl"}',
  '[{}]',
  'null',
  '{"modelApiKey":"submitted-secret"}',
  '{broken-private-value',
])('rejects nonempty or malformed startup bodies without echoing input: %s', async (payload) => {
  await withApp(async (app, _database, lines) => {
    const registered = await injectRegister(app, {
      email: 'instance@example.test',
      password: 'test-password',
    });
    const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
    const response = await app.inject({
      method: 'POST',
      url: '/_platform/api/instance/start',
      headers: jsonRequestHeaders({ cookie }),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Empty instance start body required',
    });
    expect(response.body + lines.join('')).not.toContain('submitted-secret');
    expect(response.body + lines.join('')).not.toContain('broken-private-value');
  });
});

it('projects actual service states and never accepts a requested sibling identity', async () => {
  const f = await startupOwnerFixture();
  const config = instanceConfig(f.root, { ...f.input.config, publicUrl: PUBLIC_ORIGIN });
  const service = createInstanceService({ ...f, config });
  const app = await buildApp(config, f.database, undefined, undefined, service);
  try {
    const registered = await injectRegister(app, {
      email: 'actual@example.test',
      password: 'test-password',
    });
    const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
    const headers = jsonRequestHeaders({ cookie, 'x-user-id': 'abcdefghijkl' });
    const status = await app.inject({
      url: '/_platform/api/instance?userId=abcdefghijkl',
      headers,
    });
    const started = await app.inject({
      method: 'POST',
      url: '/_platform/api/instance/start?userId=abcdefghijkl',
      headers,
      payload: '{}',
    });
    expect(status.json()).toEqual({ status: 'unconfigured', reason: 'unconfigured' });
    expect(started.json()).toEqual({ status: 'unconfigured', reason: 'unconfigured' });
    expect(f.daemon.requests).toEqual([]);
    expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    f.database.exec('DROP TABLE instances');
    const failed = await app.inject({ url: '/_platform/api/instance', headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
  } finally {
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it('sanitizes authentication storage failures before body parsing and keeps Origin admission', async () => {
  await withApp(async (app, database) => {
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/_platform/api/instance/start',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noOrigin.statusCode).toBe(403);
    database.exec('DROP TABLE platform_sessions');
    const failure = await app.inject({
      url: '/_platform/api/instance',
      headers: { cookie: `platform_session=${'a'.repeat(64)}` },
    });
    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
  });
});

it.each(['GET', 'POST'] as const)(
  'rechecks the current session before the %s handler after entry admission',
  async (method) => {
    await withApp(async (app, database) => {
      app.addHook('preValidation', (request, _reply, next) => {
        if (request.url.startsWith('/_platform/api/instance'))
          database.exec('DELETE FROM platform_sessions');
        next();
      });
      const registered = await injectRegister(app, {
        email: 'revoked@example.test',
        password: 'test-password',
      });
      const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
      const response = await app.inject({
        method,
        url: method === 'GET' ? '/_platform/api/instance' : '/_platform/api/instance/start',
        headers: jsonRequestHeaders({ cookie }),
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
      });
    });
  },
);

it.each([
  ['application/json', `"${'x'.repeat(1_048_576)}"`, 413],
  ['text/plain', '{}', 415],
] as const)('retains safe parser classification for %s', async (contentType, payload, status) => {
  await withApp(async (app) => {
    const registered = await injectRegister(app, {
      email: 'bounded@example.test',
      password: 'test-password',
    });
    const cookie = `platform_session=${sessionCookieToken(cookieHeaders(registered))}`;
    const response = await app.inject({
      method: 'POST',
      url: '/_platform/api/instance/start',
      headers: jsonRequestHeaders({ cookie, 'content-type': contentType }),
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(
      status === 413
        ? { statusCode: 413, error: 'Payload Too Large', message: 'Request body too large' }
        : {
            statusCode: 415,
            error: 'Unsupported Media Type',
            message: 'JSON request body required',
          },
    );
  });
});

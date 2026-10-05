import { describe, expect, it } from 'vitest';
import { cookieAttributes, PUBLIC_ORIGIN, sessionCookieHeader, withApp } from './auth-fixture.ts';
import {
  getIdentity,
  PASSWORD,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import { EMAIL, INVALID_ORIGIN, postRaw } from './origin-fixture.ts';
import {
  BACKDATE_ACTIVITY,
  NEW_PASSWORD,
  snapshotPasswordState,
} from './password-change-fixture.ts';

const CHARSET = { 'content-type': 'application/json; charset=utf-8' };

describe('platform Origin and JSON protocol over TCP', () => {
  it('allows registration, login, password rotation, and JSON logout with charset parameters', async () => {
    await withListeningApp(async (baseUrl) => {
      const registered = await postJson(
        `${baseUrl}/_platform/api/register`,
        {
          email: EMAIL,
          password: PASSWORD,
        },
        CHARSET,
      );
      expect(registered.status).toBe(201);
      const identity: unknown = await registered.json();
      const registrationCookie = sessionCookieHeader(registered.headers.getSetCookie());
      const login = await postJson(
        `${baseUrl}/_platform/api/login`,
        {
          email: EMAIL,
          password: PASSWORD,
        },
        CHARSET,
      );
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual(identity);
      const loginCookie = sessionCookieHeader(login.headers.getSetCookie());

      const changed = await postJson(
        `${baseUrl}/_platform/api/change-password`,
        {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        },
        { ...CHARSET, cookie: loginCookie },
      );
      expect(changed.status).toBe(204);
      expect(await changed.text()).toBe('');
      const replacementCookie = sessionCookieHeader(changed.headers.getSetCookie());
      expect((await getIdentity(baseUrl, registrationCookie)).status).toBe(401);
      expect((await getIdentity(baseUrl, loginCookie)).status).toBe(401);
      const recognized = await getIdentity(baseUrl, replacementCookie);
      expect(recognized.status).toBe(200);
      expect(await recognized.json()).toEqual(identity);
      const oldPassword = await postJson(
        `${baseUrl}/_platform/api/login`,
        {
          email: EMAIL,
          password: PASSWORD,
        },
        CHARSET,
      );
      expect(oldPassword.status).toBe(401);
      const newPassword = await postJson(
        `${baseUrl}/_platform/api/login`,
        {
          email: EMAIL,
          password: NEW_PASSWORD,
        },
        CHARSET,
      );
      expect(newPassword.status).toBe(200);
      expect(await newPassword.json()).toEqual(identity);
      const otherCookie = sessionCookieHeader(newPassword.headers.getSetCookie());
      const logout = await postJson(
        `${baseUrl}/_platform/api/logout`,
        {},
        {
          ...CHARSET,
          cookie: replacementCookie,
        },
      );
      expect(logout.status).toBe(204);
      expect(await logout.text()).toBe('');
      expect(logout.headers.getSetCookie()).toEqual([expect.stringMatching(/^platform_session=;/)]);
      expect(cookieAttributes(sessionCookieHeader(logout.headers.getSetCookie()))).toEqual([
        'HttpOnly',
        'Max-Age=0',
        'Path=/',
        'SameSite=Lax',
      ]);
      expect((await getIdentity(baseUrl, replacementCookie)).status).toBe(401);
      expect((await getIdentity(baseUrl, otherCookie)).status).toBe(200);
    });
  });

  it('rejects bodyless and non-object logout without an exemption or session activity changes', async () => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);

      for (const body of [undefined, '[]', '"not-an-object"', 'null']) {
        const response = await fetch(`${baseUrl}/_platform/api/logout`, {
          method: 'POST',
          headers: {
            origin: PUBLIC_ORIGIN,
            'content-type': 'application/json',
            cookie: `platform_session=${login.token}`,
          },
          ...(body === undefined ? {} : { body }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(snapshotPasswordState(database)).toEqual(before);
      }
    });
  });

  it('does not infer Origin from Host and accepts configured Origin independently of Host', async () => {
    await withListeningApp(async (baseUrl, _app, database) => {
      const before = snapshotPasswordState(database);
      const payload = { email: EMAIL, password: PASSWORD };

      const missing = await postRaw(baseUrl, 'register', payload, ['Host', '127.0.0.1:8080']);
      expect(missing.statusCode).toBe(403);
      expect(JSON.parse(missing.body)).toEqual(INVALID_ORIGIN);
      expect(missing.headers['set-cookie']).toBeUndefined();
      expect(snapshotPasswordState(database)).toEqual(before);
      const accepted = await postRaw(baseUrl, 'register', payload, [
        'Host',
        'unrelated.example:9999',
        'Origin',
        PUBLIC_ORIGIN,
      ]);
      expect(accepted.statusCode).toBe(201);
      const identity: unknown = JSON.parse(accepted.body);
      expect(identity).toMatchObject({ email: EMAIL, role: 'employee' });
      const cookie = sessionCookieHeader(accepted.headers['set-cookie'] ?? []);
      const recognized = await getIdentity(baseUrl, cookie);
      expect(recognized.status).toBe(200);
      expect(await recognized.json()).toEqual(identity);
    });
  });

  it('protects later platform methods while preserving health, safe methods, non-platform traffic, and unknown routes', async () => {
    await withApp(async (app, database) => {
      const route = '/_platform/api/later';
      app.route({
        method: ['GET', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
        url: route,
        schema: {
          response: {
            200: {
              type: 'object',
              required: ['method'],
              properties: { method: { type: 'string' } },
            },
          },
        },
        handler: (request, reply) => reply.send({ method: request.method }),
      });
      app.post(
        '/outside',
        {
          schema: {
            response: {
              200: {
                type: 'object',
                required: ['outside'],
                properties: { outside: { type: 'boolean' } },
              },
            },
          },
        },
        (_request, reply) => reply.send({ outside: true }),
      );
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const before = snapshotPasswordState(database);

      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const missing = await fetch(`${baseUrl}${route}?query=/_platform/api/ignored`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual(INVALID_ORIGIN);
        expect(missing.headers.getSetCookie()).toEqual([]);
        expect(snapshotPasswordState(database)).toEqual(before);
        const accepted = await fetch(`${baseUrl}${route}`, {
          method,
          headers: { origin: PUBLIC_ORIGIN, ...CHARSET },
          body: '{}',
        });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ method });
      }
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const safe = await fetch(`${baseUrl}${route}`, { method });
        expect(safe.status).toBe(200);
        if (method === 'HEAD') expect(await safe.text()).toBe('');
        else expect(await safe.json()).toEqual({ method });
      }
      for (const method of ['GET', 'HEAD']) {
        const health = await fetch(`${baseUrl}/healthz`, { method });
        expect(health.status).toBe(200);
        if (method === 'HEAD') expect(await health.text()).toBe('');
        else expect(await health.json()).toEqual({ status: 'ok' });
      }
      const outside = await fetch(`${baseUrl}/outside`, { method: 'POST' });
      expect(outside.status).toBe(200);
      expect(await outside.json()).toEqual({ outside: true });
      const missing = await fetch(`${baseUrl}/_platform/api/unknown`, { method: 'POST' });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ statusCode: 404 });
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });
});

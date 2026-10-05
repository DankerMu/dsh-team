import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { jsonRequestHeaders, PUBLIC_ORIGIN, withApp } from '../../test/auth-fixture.ts';
import { snapshotPasswordState } from '../../test/password-change-fixture.ts';

const PROBE = '/_platform/api/guard-probe';
const INVALID_ORIGIN = {
  statusCode: 403,
  error: 'Forbidden',
  message: 'Invalid request origin',
};
const JSON_REQUIRED = {
  statusCode: 415,
  error: 'Unsupported Media Type',
  message: 'JSON request body required',
};

function registerProbe(app: FastifyInstance): void {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: PROBE,
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['accepted'],
          properties: { accepted: { type: 'boolean' } },
        },
      },
    },
    handler: (_request, reply) => reply.send({ accepted: true }),
  });
}

describe('platform mutation request boundary', () => {
  it.each([
    { label: 'missing', origin: undefined },
    { label: 'empty', origin: '' },
    { label: 'null', origin: 'null' },
    { label: 'foreign host', origin: 'http://other.example:8080' },
    { label: 'foreign scheme', origin: 'https://127.0.0.1:8080' },
    { label: 'foreign port', origin: 'http://127.0.0.1:8081' },
    { label: 'trailing slash', origin: `${PUBLIC_ORIGIN}/` },
    { label: 'path', origin: `${PUBLIC_ORIGIN}/page` },
    { label: 'userinfo', origin: 'http://user@127.0.0.1:8080' },
    { label: 'query', origin: `${PUBLIC_ORIGIN}?query` },
    { label: 'fragment', origin: `${PUBLIC_ORIGIN}#fragment` },
    { label: 'list', origin: `${PUBLIC_ORIGIN}, ${PUBLIC_ORIGIN}` },
  ])('rejects $label Origin with no persisted changes or cookie', async ({ origin }) => {
    await withApp(async (app, database) => {
      registerProbe(app);
      const before = snapshotPasswordState(database);

      const response = await app.inject({
        method: 'POST',
        url: `${PROBE}?origin=${encodeURIComponent(PUBLIC_ORIGIN)}`,
        headers: jsonRequestHeaders({ origin }),
        payload: '{}',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(INVALID_ORIGIN);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });

  it.each([
    { label: 'missing', contentType: undefined },
    { label: 'form', contentType: 'application/x-www-form-urlencoded' },
    { label: 'multipart', contentType: 'multipart/form-data; boundary=test' },
    { label: 'text', contentType: 'text/plain' },
    { label: 'lookalike', contentType: 'application/jsonp' },
    { label: 'suffix JSON', contentType: 'application/problem+json' },
  ])('rejects $label media after valid Origin', async ({ contentType }) => {
    await withApp(async (app, database) => {
      registerProbe(app);
      const before = snapshotPasswordState(database);

      const response = await app.inject({
        method: 'POST',
        url: PROBE,
        headers: jsonRequestHeaders({ 'content-type': contentType }),
        payload: '{}',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual(JSON_REQUIRED);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(snapshotPasswordState(database)).toEqual(before);
    });
  });

  it.each(['application/json', 'Application/JSON; charset=utf-8'])(
    'accepts exact Origin with %s media',
    async (contentType) => {
      await withApp(async (app) => {
        registerProbe(app);

        const response = await app.inject({
          method: 'POST',
          url: PROBE,
          headers: jsonRequestHeaders({ 'content-type': contentType }),
          payload: '{}',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ accepted: true });
      });
    },
  );

  it.each([
    { contentType: 'application/json', payload: '{' },
    { contentType: 'text/plain', payload: '{}' },
  ])('rejects Origin before parsing $contentType', async ({ contentType, payload }) => {
    await withApp(async (app) => {
      registerProbe(app);

      const response = await app.inject({
        method: 'POST',
        url: PROBE,
        headers: jsonRequestHeaders({ origin: undefined, 'content-type': contentType }),
        payload,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(INVALID_ORIGIN);
    });
  });

  it('leaves malformed same-Origin JSON to the native parser', async () => {
    await withApp(async (app) => {
      registerProbe(app);

      const response = await app.inject({
        method: 'POST',
        url: PROBE,
        headers: jsonRequestHeaders(),
        payload: '{',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'protects later registered platform %s routes',
    async (method) => {
      await withApp(async (app) => {
        registerProbe(app);

        const rejected = await app.inject({ method, url: PROBE, payload: '{}' });
        const accepted = await app.inject({
          method,
          url: PROBE,
          headers: jsonRequestHeaders(),
          payload: '{}',
        });

        expect(rejected.statusCode).toBe(403);
        expect(rejected.json()).toEqual(INVALID_ORIGIN);
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ accepted: true });
      });
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'] as const)(
    'allows platform %s without Origin or JSON',
    async (method) => {
      await withApp(async (app) => {
        registerProbe(app);

        const response = await app.inject({ method, url: PROBE });

        expect(response.statusCode).toBe(200);
        if (method === 'HEAD') {
          expect(response.body).toBe('');
        } else {
          expect(response.json()).toEqual({ accepted: true });
        }
      });
    },
  );

  it('keeps non-platform mutations and unknown platform routes outside the guard', async () => {
    await withApp(async (app) => {
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

      const outside = await app.inject({ method: 'POST', url: '/outside' });
      const missing = await app.inject({ method: 'POST', url: '/_platform/api/missing' });
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      const head = await app.inject({ method: 'HEAD', url: '/healthz' });

      expect(outside.statusCode).toBe(200);
      expect(outside.json()).toEqual({ outside: true });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ statusCode: 404 });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
    });
  });
});

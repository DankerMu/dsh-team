import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { healthRoutes } from './health.ts';

describe('GET /healthz', () => {
  const app = Fastify();
  app.register(healthRoutes);

  afterEach(async () => {
    await app.close();
  });

  it('answers 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';

describe('platform over a real TCP port', () => {
  let baseUrl = '';
  let close: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const database = openDatabase(':memory:');
    let app: FastifyInstance | undefined;
    try {
      applyMigrations(database);
      app = await buildApp(
        {
          host: '127.0.0.1',
          port: 0,
          logLevel: 'silent',
          dataDir: './data',
          publicUrl: 'http://127.0.0.1',
          authority: '127.0.0.1',
          cookieSecure: false,
          trustedProxies: [],
        },
        database,
      );
      await app.listen({ host: '127.0.0.1', port: 0 });
    } catch (error) {
      if (app === undefined) {
        database.close();
      } else {
        await app.close();
      }
      throw error;
    }
    const started = app;
    const address = started.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    close = () => started.close();
  });

  afterAll(async () => {
    await close();
  });

  it('answers the health probe as JSON', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers an unknown route with a JSON 404', async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404 });
  });
});

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
          managedConfigDir: './data/managed-config',
          dockerSocketPath: '/var/run/docker.sock',
          userImage: 'dsh-team-user:local',
          seccompProfilePath: '/unused/seccomp.json',
          subnetPool: '172.30.0.0/16',
          upstreamMode: 'published-loopback',
          platformContainerName: 'dsh-team-platform',
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

  it('serves the login page with its locally built script', async () => {
    const response = await fetch(`${baseUrl}/_platform/login`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    const script = /<script\b[^>]*\bsrc=["'](\/_platform\/assets\/[^"']+\.js)["'][^>]*>/.exec(html);
    expect(script).not.toBeNull();

    const asset = await fetch(`${baseUrl}${script?.[1] ?? ''}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
  });

  it('serves login and asset HEAD metadata over TCP without response bodies', async () => {
    const login = await fetch(`${baseUrl}/_platform/login`);
    const html = await login.text();
    const script = /<script\b[^>]*\bsrc=["'](\/_platform\/assets\/[^"']+\.js)["'][^>]*>/.exec(html);
    expect(script?.[1]).toBeDefined();
    for (const path of ['/_platform/login', script?.[1] ?? '']) {
      const get = await fetch(`${baseUrl}${path}`);
      const expectedBytes = (await get.arrayBuffer()).byteLength;
      const head = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });

      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(head.headers.get('content-length')).toBe(String(expectedBytes));
      expect(await head.text()).toBe('');
    }
  });

  it('rejects missing assets and encoded traversal without returning the login entry', async () => {
    for (const path of [
      '/_platform/assets/no-such-file.js',
      '/_platform/assets/%2e%2e%2findex.html',
      '/_platform/assets/%2e%2e%5cindex.html',
      '/_platform/assets/%252e%252e%252findex.html',
      '/_platform/assets/%2eenv',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ statusCode: 404 });
    }
  });

  it('answers unknown platform page and API routes with a JSON 404', async () => {
    for (const path of ['/_platform/no-such-route', '/_platform/api/no-such-route']) {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ statusCode: 404 });
    }
  });
});

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as playwright from '@playwright/test';
import { expect, it } from 'vitest';
import { withAccountUi } from './account-ui-fixture.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { observeHttp, withUpstream } from './gateway-http-fixture.ts';

async function expectReusablePort(port: number): Promise<void> {
  const server = createServer();
  try {
    server.listen(port, '127.0.0.1');
    await observeHttp(once(server, 'listening'));
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
  } finally {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await observeHttp(closed);
    }
  }
}

it('keeps public listener custody through initialization and real same-origin authentication', async () => {
  const contenders: ReturnType<typeof createServer>[] = [];
  const compete = async (baseUrl: string) => {
    const contender = createServer((socket) => socket.end());
    contenders.push(contender);
    const bound = Promise.withResolvers<string>();
    contender.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') bound.resolve(error.code);
      else bound.reject(error);
    });
    contender.listen(Number(new URL(baseUrl).port), '127.0.0.1', () => {
      bound.resolve('bound');
    });
    return bound.promise;
  };
  let contenderOutcome: string | undefined;
  let contenderHeldOnFailure = false;
  let applicationBuilt = false;
  let callbackEntered = false;
  let fixtureError: unknown = null;
  try {
    try {
      await withAccountUi(
        playwright,
        async ({ baseUrl, seed, database }) => {
          callbackEntered = true;
          expect(await compete(baseUrl)).toBe('EADDRINUSE');
          const health = await seed.get('/healthz');
          await health.body();
          expect(health.status()).toBe(200);
          const credentials = {
            email: 'owned-listener@example.com',
            password: 'owned-listener-password',
          };
          const registered = await seed.post('/_platform/api/register', { data: credentials });
          await registered.body();
          expect(registered.status()).toBe(201);
          const login = await seed.post('/_platform/api/login', { data: credentials });
          await login.body();
          expect(login.status()).toBe(200);
          const refused = await seed.post('/_platform/api/register', {
            data: { ...credentials, email: 'wrong-origin@example.com' },
            headers: { Origin: 'http://unrelated.invalid' },
          });
          await refused.body();
          expect(refused.status()).toBe(403);
          const user = database.prepare('SELECT email FROM users WHERE email=?');
          expect(user.get(credentials.email)).toEqual({ email: credentials.email });
          expect(user.get('wrong-origin@example.com')).toBeUndefined();
        },
        {
          observeInitialization: async (context) => {
            if (context.phase === 'application-built') {
              applicationBuilt = true;
              expect(await compete(context.baseUrl)).toBe('EADDRINUSE');
            } else contenderOutcome = await compete(context.baseUrl);
          },
        },
      );
    } catch (error) {
      fixtureError = error;
      contenderHeldOnFailure = contenders.some((server) => server.listening);
    }

    expect({
      contenderOutcome,
      contenderHeldOnFailure,
      applicationBuilt,
      callbackEntered,
      fixtureError,
    }).toEqual({
      contenderOutcome: 'EADDRINUSE',
      contenderHeldOnFailure: false,
      applicationBuilt: true,
      callbackEntered: true,
      fixtureError: null,
    });
  } finally {
    for (const contender of contenders) {
      if (!contender.listening) continue;
      const closed = once(contender, 'close');
      contender.close();
      await closed;
    }
  }
});

it('preserves scenario and cleanup failures while settling independent resources and retaining uncertain paths', async () => {
  const primary = new Error('Owned UI scenario failure');
  const cleanup = new Error('Owned API context cleanup failure');
  let database: DatabaseHandle | undefined;
  let app: FastifyInstance | undefined;
  let directory: string | undefined;
  const disposal = { completed: false };
  const ports: number[] = [];
  try {
    await withUpstream(
      (_request, response) => response.end('unrelated-listener'),
      async (sentinel) => {
        const failure: unknown = await withAccountUi(
          playwright,
          async ({ baseUrl, seed, database: ownedDatabase }) => {
            database = ownedDatabase;
            directory = dirname(ownedDatabase.name);
            ports.push(Number(new URL(baseUrl).port));
            const address = app?.server.address();
            if (address === null || address === undefined || typeof address === 'string')
              throw new Error('Missing owned backend listener');
            ports.push(address.port);
            const response = await seed.get('/healthz');
            await response.body();
            expect(response.status()).toBe(200);
            const dispose = seed.dispose.bind(seed);
            seed.dispose = async () => {
              await dispose();
              disposal.completed = true;
              throw cleanup;
            };
            throw primary;
          },
          {
            observeInitialization: (context) => {
              if (context.phase === 'application-built') app = context.app;
            },
          },
        ).catch((error: unknown) => error);

        if (!(failure instanceof AggregateError))
          throw new Error('Expected both UI failures to be retained', { cause: failure });
        expect(failure.errors).toEqual([primary, cleanup]);
        expect(failure.cause).toBe(primary);
        expect(database?.open).toBe(false);
        expect(app?.server.listening).toBe(false);
        if (directory === undefined) throw new Error('Missing owned UI directory');
        expect(existsSync(directory)).toBe(true);
        for (const port of ports) await expectReusablePort(port);
        const response = await fetch(`http://${sentinel.host}:${String(sentinel.port)}/`);
        expect(await response.text()).toBe('unrelated-listener');
      },
    );
  } finally {
    // The controlled dependency threw only after real disposal; independent closure permits
    // this test owner to remove its captured directory, not an unknown fixture resource.
    if (
      directory !== undefined &&
      database?.open === false &&
      app?.server.listening === false &&
      disposal.completed
    )
      await rm(directory, { recursive: true, force: true });
  }
});

it.each(['completed', 'initialization-failed', 'scenario-failed'])(
  'settles owned UI resources after %s without closing an unrelated listener',
  async (outcome) => {
    const primary = new Error('Owned UI lifecycle failure');
    let database: DatabaseHandle | undefined;
    let app: FastifyInstance | undefined;
    let seed: playwright.APIRequestContext | undefined;
    let directory: string | undefined;
    let early: ReturnType<typeof createConnection> | undefined;
    let callbackEntered = false;
    const ports: number[] = [];
    try {
      await withUpstream(
        (_request, response) => response.end('surviving-listener'),
        async (sentinel) => {
          const failure: unknown = await withAccountUi(
            playwright,
            async (context) => {
              callbackEntered = true;
              seed = context.seed;
              const address = app?.server.address();
              if (address === null || address === undefined || typeof address === 'string')
                throw new Error('Missing owned UI backend');
              ports.push(address.port);
              const response = await seed.get('/healthz');
              await response.body();
              expect(response.status()).toBe(200);
              if (outcome === 'scenario-failed') throw primary;
            },
            {
              observeInitialization: async (context) => {
                if (context.phase === 'origin-selected') {
                  const port = Number(new URL(context.baseUrl).port);
                  ports.push(port);
                  if (outcome === 'initialization-failed') {
                    early = createConnection({ host: '127.0.0.1', port });
                    await observeHttp(Promise.all([once(early, 'connect'), once(early, 'close')]));
                    expect(early.destroyed).toBe(true);
                  }
                } else {
                  app = context.app;
                  database = context.database;
                  directory = dirname(database.name);
                  if (outcome === 'initialization-failed') throw primary;
                }
              },
            },
          ).catch((error: unknown) => error);

          expect(failure).toBe(outcome === 'completed' ? undefined : primary);
          expect(callbackEntered).toBe(outcome !== 'initialization-failed');
          expect(database?.open).toBe(false);
          expect(app?.server.listening).toBe(false);
          if (directory === undefined) throw new Error('Missing initialized UI directory');
          expect(existsSync(directory)).toBe(false);
          if (seed !== undefined) await expect(seed.storageState()).rejects.toThrow();
          for (const port of ports) await expectReusablePort(port);
          const response = await fetch(`http://${sentinel.host}:${String(sentinel.port)}/`);
          expect(await response.text()).toBe('surviving-listener');
        },
      );
    } finally {
      early?.destroy();
    }
  },
);

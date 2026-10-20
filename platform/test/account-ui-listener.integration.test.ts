import { once } from 'node:events';
import { createServer } from 'node:net';
import * as playwright from '@playwright/test';
import { expect, it } from 'vitest';
import { withAccountUi } from './account-ui-fixture.ts';

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

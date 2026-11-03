import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { expect, it } from 'vitest';
import { withRequestAbort } from './request-abort.ts';

/** One owned route whose handler runs `withRequestAbort` and reports what its body observed. */
async function withRoute(
  shutdown: AbortSignal,
  run: (signal: AbortSignal, reply: FastifyReply) => Promise<unknown>,
  check: (inject: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const app = Fastify();
  app.get('/owned', (_request, reply) => {
    return withRequestAbort(reply, shutdown, (signal) => run(signal, reply)).catch(
      (error: unknown) => ({ rejected: error instanceof Error ? error.message : null }),
    );
  });
  try {
    await check(async () => (await app.inject({ method: 'GET', url: '/owned' })).json());
  } finally {
    await app.close();
  }
}

it('returns the run result with a live signal', async () => {
  const seen: boolean[] = [];
  await withRoute(
    new AbortController().signal,
    (signal) => {
      seen.push(signal.aborted);
      return Promise.resolve({ owned: true });
    },
    async (inject) => {
      expect(await inject()).toEqual({ owned: true });
      expect(seen).toEqual([false]);
    },
  );
});

it('aborts the signal when the response closes before a reply', async () => {
  const seen: boolean[] = [];
  await withRoute(
    new AbortController().signal,
    (signal, reply) => {
      seen.push(signal.aborted);
      reply.raw.emit('close');
      seen.push(signal.aborted);
      return Promise.resolve({});
    },
    async (inject) => {
      // The injected client treats the response's close as a destroyed response.
      await expect(inject()).rejects.toThrow('response destroyed before completion');
      expect(seen).toEqual([false, true]);
    },
  );
});

it('aborts the signal when the application shuts down', async () => {
  const shutdown = new AbortController();
  const seen: boolean[] = [];
  await withRoute(
    shutdown.signal,
    (signal) => {
      seen.push(signal.aborted);
      shutdown.abort();
      seen.push(signal.aborted);
      return Promise.resolve({});
    },
    async (inject) => {
      await inject();
      expect(seen).toEqual([false, true]);
    },
  );
});

it.each([
  ['resolves', () => Promise.resolve({})],
  ['rejects', () => Promise.reject(new Error('owned failure'))],
])('adds one close listener and removes it once the run %s', async (_label, outcome) => {
  const app = Fastify();
  app.get('/owned', async (_request, reply) => {
    const before = reply.raw.listenerCount('close');
    let during = -1;
    await withRequestAbort(reply, new AbortController().signal, () => {
      during = reply.raw.listenerCount('close');
      return outcome();
    }).catch(() => undefined);
    return { added: during - before, left: reply.raw.listenerCount('close') - before };
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/owned' });

    expect(response.json()).toEqual({ added: 1, left: 0 });
  } finally {
    await app.close();
  }
});

it('propagates a rejection of the run unchanged', async () => {
  await withRoute(
    new AbortController().signal,
    () => Promise.reject(new Error('owned failure')),
    async (inject) => {
      expect(await inject()).toEqual({ rejected: 'owned failure' });
    },
  );
});

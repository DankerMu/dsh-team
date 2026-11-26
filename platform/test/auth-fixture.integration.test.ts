import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { expect, it, onTestFinished } from 'vitest';
import { TEARDOWN_CLOSE_MS, withApp } from './auth-fixture.ts';

// `String()` of the reason `AbortSignal.timeout` aborts with, as `boundedStep` reports it.
const TIMEOUT = 'TimeoutError: The operation was aborted due to timeout';

/** Holds the app's close in an `onClose` hook until the case finishes, then lets it settle. */
function holdClose(app: FastifyInstance): void {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  app.addHook('onClose', () => promise);
  onTestFinished(async () => {
    resolve(undefined);
    await app.close();
  });
}

it('fails a passing body with the teardown close named when that close never finishes', async () => {
  let ended = 0;

  const failure = withApp((app) => {
    holdClose(app);
    ended = performance.now();
    return Promise.resolve();
  });

  await expect(failure).rejects.toThrow(new Error(`teardown: application close: ${TIMEOUT}`));
  expect(performance.now() - ended).toBeLessThan(TEARDOWN_CLOSE_MS + 1000);
});

it('rethrows the body failure unchanged when the teardown close is healthy', async () => {
  const primary = new Error('body failed');

  const failure = withApp(() => Promise.reject(primary));

  await expect(failure).rejects.toBe(primary);
  expect(primary.message).toBe('body failed');
});

it('keeps the body failure first and appends the teardown close that never finishes', async () => {
  const primary = new Error('body failed');

  const failure = withApp((app) => {
    holdClose(app);
    return Promise.reject(primary);
  });

  await expect(failure).rejects.toBe(primary);
  expect(primary.message).toBe(`body failed; teardown: application close: ${TIMEOUT}`);
});

it('rethrows a non-Error body failure unchanged when the teardown close never finishes', async () => {
  const primary = 'body failed';

  const failure = withApp((app) => {
    holdClose(app);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test.
    return Promise.reject(primary);
  });

  await expect(failure).rejects.toBe(primary);
});

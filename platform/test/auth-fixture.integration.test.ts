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

// A teardown deadline three default bounds away, so a close cut at the default fails early.
const PINNED_DEADLINE_MS = 3 * TEARDOWN_CLOSE_MS;

it(
  'cuts a never-finishing teardown close at the deadline the case passes, not the default',
  async () => {
    const start = performance.now();

    const failure = withApp(
      (app) => {
        holdClose(app);
        return Promise.resolve();
      },
      false,
      [],
      undefined,
      { teardownDeadline: start + PINNED_DEADLINE_MS },
    );

    await expect(failure).rejects.toThrow(new Error(`teardown: application close: ${TIMEOUT}`));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2.5 * TEARDOWN_CLOSE_MS);
    expect(elapsed).toBeLessThan(PINNED_DEADLINE_MS + 1000);
  },
  // The passed deadline, the 1000ms report allowance above, and 1000ms for the hook's release.
  PINNED_DEADLINE_MS + 2000,
);

it('rethrows the body failure unchanged when the teardown close is healthy', async () => {
  const primary = new Error('body failed');
  let closed = false;

  const failure = withApp((app) => {
    app.addHook('onClose', () => {
      closed = true;
      return Promise.resolve();
    });
    return Promise.reject(primary);
  });

  await expect(failure).rejects.toBe(primary);
  expect(primary.message).toBe('body failed');
  expect(closed).toBe(true);
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

it('appends the teardown close to a DOMException body failure, whose message is a getter', async () => {
  const primary = new DOMException('body failed', 'TimeoutError');

  const failure = withApp((app) => {
    holdClose(app);
    return Promise.reject(primary);
  });

  await expect(failure).rejects.toBe(primary);
  expect(primary.message).toBe(`body failed; teardown: application close: ${TIMEOUT}`);
});

it('rethrows a frozen body failure unchanged when the teardown close never finishes', async () => {
  const primary = Object.freeze(new Error('body failed'));

  const failure = withApp((app) => {
    holdClose(app);
    return Promise.reject(primary);
  });

  await expect(failure).rejects.toBe(primary);
  expect(primary.message).toBe('body failed');
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

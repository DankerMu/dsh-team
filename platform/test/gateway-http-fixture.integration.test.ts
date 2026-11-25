import type { RequestListener } from 'node:http';
import { expect, it } from 'vitest';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import {
  HTTP_SEND_MS,
  observeHttp,
  sendHttp,
  settleWithCleanup,
  unusedPort,
  withUpstream,
} from './gateway-http-fixture.ts';

// vitest's default testTimeout, which the integration project inherits: a stalled send must fail
// with its own error before the runner's.
const DEFAULT_CASE_BUDGET_MS = 5000;

const neverAnswers: RequestListener = () => undefined;

function origin(target: GatewayUpstream): string {
  return `http://${target.host}:${String(target.port)}`;
}

async function failureOf(operation: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  const failure = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(failure instanceof Error)) throw new Error('Expected the operation to fail with an Error');
  // Narrowed to Error above; the record view only lets assertions read Node's `code` and `cause`.
  return failure as Error & Record<string, unknown>;
}

it('names the request and the response headers phase when a peer never answers, before the default case budget', async () => {
  await withUpstream(neverAnswers, async (target) => {
    const started = performance.now();

    const failure = await failureOf(
      sendHttp(origin(target), { method: 'POST', path: '/stall' }, 'payload'),
    );

    expect(failure.message).toMatch(
      /^sendHttp POST \/stall: response headers exceeded the 2500ms send bound/,
    );
    expect(failure.cause).toMatchObject({ name: 'AbortError' });
    expect(performance.now() - started).toBeLessThan(DEFAULT_CASE_BUDGET_MS);
  });
});

it('names the response body phase when a peer sends headers and then stalls', async () => {
  const stallBody: RequestListener = (_request, response) => {
    response.writeHead(200).write('partial');
  };
  await withUpstream(stallBody, async (target) => {
    const failure = await failureOf(sendHttp(origin(target), { path: '/partial' }));

    expect(failure.message).toMatch(
      /^sendHttp GET \/partial: response body exceeded the 2500ms send bound/,
    );
    expect(failure.cause).toMatchObject({ name: 'AbortError' });
  });
});

it('carries the label of an observation that never settles', async () => {
  const failure = await failureOf(observeHttp(new Promise(() => undefined), 50, 'probe peer'));

  expect(failure.message).toBe('HTTP peer observation did not settle: probe peer');
});

it('keeps the unlabelled observation message unchanged', async () => {
  const failure = await failureOf(observeHttp(new Promise(() => undefined), 50));

  expect(failure.message).toBe('HTTP peer observation did not settle');
});

it("keeps a caller's abort reason at the cause of the Node AbortError", async () => {
  const arrived = Promise.withResolvers<undefined>();
  const held: RequestListener = () => {
    arrived.resolve(undefined);
  };
  await withUpstream(held, async (target) => {
    const controller = new AbortController();
    const reason = new Error('caller reason');
    const sending = failureOf(
      sendHttp(origin(target), { path: '/held', signal: controller.signal }),
    );
    await observeHttp(arrived.promise);

    controller.abort(reason);
    const failure = await sending;

    expect(failure.message).toMatch(/^sendHttp GET \/held: response headers aborted by the caller/);
    expect(failure.cause).toMatchObject({ name: 'AbortError' });
    // The line above proved the cause is Node's AbortError, an Error whose own cause is optional.
    expect((failure.cause as { cause?: unknown }).cause).toBe(reason);
  });
});

it('rethrows a refused connection unchanged with its code', async () => {
  const port = await unusedPort();

  const failure = await failureOf(sendHttp(`http://127.0.0.1:${String(port)}`, { path: '/x' }));

  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure.code).toBe('ECONNREFUSED');
  expect(failure.message).not.toMatch(/sendHttp/);
});

it('lets an explicit bound override the default send bound', async () => {
  await withUpstream(neverAnswers, async (target) => {
    const started = performance.now();

    const failure = await failureOf(sendHttp(origin(target), { path: '/short' }, undefined, 100));

    expect(failure.message).toMatch(
      /^sendHttp GET \/short: response headers exceeded the 100ms send bound/,
    );
    expect(performance.now() - started).toBeLessThan(HTTP_SEND_MS);
  });
});

it('names GET / for a call that gives neither method nor path', async () => {
  await withUpstream(neverAnswers, async (target) => {
    const failure = await failureOf(sendHttp(origin(target), {}, undefined, 100));

    expect(failure.message).toMatch(/^sendHttp GET \/: response headers/);
  });
});

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to throw');
}

it('merges an operation failure and a cleanup failure with the operation failure as cause', () => {
  const operation = new Error('operation');
  const cleanup = new Error('cleanup');

  const merged = thrownBy(() =>
    settleWithCleanup('Operation and cleanup failed', { error: operation }, { error: cleanup }),
  );

  expect(merged).toBeInstanceOf(AggregateError);
  expect(merged).toMatchObject({
    message: 'Operation and cleanup failed',
    errors: [operation, cleanup],
    cause: operation,
  });
});

it('rethrows an operation failure as is when cleanup succeeded', () => {
  const operation = new Error('operation');

  expect(thrownBy(() => settleWithCleanup('unused', { error: operation }, undefined))).toBe(
    operation,
  );
});

it('rethrows a cleanup failure alone when the operation succeeded', () => {
  const cleanup = new Error('cleanup');

  expect(thrownBy(() => settleWithCleanup('unused', { value: 1 }, { error: cleanup }))).toBe(
    cleanup,
  );
});

it('returns the operation value when both the operation and cleanup succeeded', () => {
  expect(settleWithCleanup('unused', { value: 'sent' }, undefined)).toBe('sent');
});

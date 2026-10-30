import { expect, it, vi } from 'vitest';
import { settleRescue, trackRescue } from './rescue-settlement.ts';

async function settlementFailure(settlement: Promise<void>): Promise<AggregateError> {
  const error: unknown = await settlement.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AggregateError)) throw new Error('Expected an AggregateError');
  return error;
}

it('retains an unconsumed first rescue failure after the scenario failure', async () => {
  const first = new Error('first rescue');
  const primary = new Error('scenario');
  const tracked = trackRescue(Promise.reject(first));
  const rescue = vi.fn(() => Promise.resolve());
  const error = await settlementFailure(settleRescue(tracked, rescue, { error: primary }));
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1]).toBe(first);
  expect(error.message).toBe('Acquisition scenario and rescue failed');
  expect(rescue).toHaveBeenCalledTimes(1);
});

it('aggregates a repeated rescue failure without a scenario failure', async () => {
  const second = new Error('second rescue');
  const tracked = trackRescue(Promise.resolve());
  const error = await settlementFailure(
    settleRescue(tracked, () => Promise.reject(second), undefined),
  );
  expect(error.errors).toEqual([second]);
  expect(error.errors[0]).toBe(second);
  expect(error.message).toBe('Acquisition rescue failed');
});

it('leaves the scenario failure to its caller when both rescues succeed', async () => {
  const tracked = trackRescue(Promise.resolve());
  const rescue = vi.fn(() => Promise.resolve());
  await expect(
    settleRescue(tracked, rescue, { error: new Error('scenario') }),
  ).resolves.toBeUndefined();
  expect(rescue).toHaveBeenCalledTimes(1);
});

it('waits for an unsettled first rescue before repeating it and retains its failure', async () => {
  const first = new Error('first rescue');
  const order: string[] = [];
  const original = Promise.withResolvers<undefined>();
  const tracked = trackRescue(
    original.promise.then(
      () => undefined,
      (error: unknown) => {
        order.push('first settled');
        throw error;
      },
    ),
  );
  const settlement = settlementFailure(
    settleRescue(
      tracked,
      () => {
        order.push('rescue');
        return Promise.resolve();
      },
      undefined,
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(order).toEqual([]);
  original.reject(first);
  const error = await settlement;
  expect(error.errors).toHaveLength(1);
  expect(error.errors[0]).toBe(first);
  expect(error.message).toBe('Acquisition rescue failed');
  expect(order).toEqual(['first settled', 'rescue']);
});

it('repeats the rescue once when the first rescue never started', async () => {
  const rescue = vi.fn(() => Promise.resolve());
  await expect(settleRescue(undefined, rescue, undefined)).resolves.toBeUndefined();
  expect(rescue).toHaveBeenCalledTimes(1);
  const primary = new Error('scenario');
  const second = new Error('second rescue');
  const error = await settlementFailure(
    settleRescue(undefined, () => Promise.reject(second), { error: primary }),
  );
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1]).toBe(second);
  expect(error.message).toBe('Acquisition scenario and rescue failed');
});

it('does not repeat a first rescue failure that is already the scenario failure', async () => {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    const first = new Error('first rescue');
    const tracked = trackRescue(Promise.reject(first));
    const rescue = vi.fn(() => Promise.resolve());
    await expect(settleRescue(tracked, rescue, { error: first })).resolves.toBeUndefined();
    expect(rescue).toHaveBeenCalledTimes(1);
    trackRescue(Promise.reject(new Error('untracked consumer')));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', handler);
  }
});

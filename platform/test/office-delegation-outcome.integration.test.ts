import { expect, it, vi } from 'vitest';
import { type OfficeOutcome, settleOfficeEvidence } from './office-delegation-outcome.ts';

const MESSAGE = 'Office delegation scenario and failure evidence persistence failed';

it('aggregates the scenario failure and the failure-evidence persistence failure in order', () => {
  const primary = new Error('Office native scenario failed');
  const secondary = new Error('Office evidence container failed');
  const outcome: OfficeOutcome<string> = { ok: false, error: primary };
  const persist = () => {
    throw secondary;
  };

  expect(() => settleOfficeEvidence(outcome, persist)).toThrow(AggregateError);
  let failure: unknown;
  try {
    settleOfficeEvidence(outcome, persist);
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof AggregateError)) throw new Error('Expected an AggregateError');
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1]).toBe(secondary);
  expect(failure.message).toBe(MESSAGE);
});

it('rethrows the scenario failure itself after persisting its evidence once', () => {
  const primary = new Error('Office native scenario failed');
  const persist = vi.fn();

  let failure: unknown;
  try {
    settleOfficeEvidence({ ok: false, error: primary }, persist);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(primary);
  expect(persist).toHaveBeenCalledTimes(1);
});

it('rethrows the persistence failure itself after a successful scenario', () => {
  const secondary = new Error('Office evidence container failed');
  let failure: unknown;
  try {
    settleOfficeEvidence({ ok: true, value: 'v' }, () => {
      throw secondary;
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(secondary);
  expect(failure).not.toBeInstanceOf(AggregateError);
});

it('returns the scenario value after persisting its evidence once', () => {
  const persist = vi.fn();

  expect(settleOfficeEvidence({ ok: true, value: 'v' }, persist)).toBe('v');
  expect(persist).toHaveBeenCalledTimes(1);
});

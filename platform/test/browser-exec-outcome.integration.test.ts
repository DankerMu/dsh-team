import { expect, it } from 'vitest';
import { expectRetiredBrowserExec, settleBrowserExec } from './browser-exec-outcome.ts';
import type { BrowserExecSettlement } from './browser-exec-outcome.ts';

const outside = 'Retired browser exec settled outside the declared outcomes';
const options = [{ gracefulEmptyExit: true }, { gracefulEmptyExit: false }];

it('rejects an output-limit failure after retirement', () => {
  const settlement: BrowserExecSettlement = {
    settled: 'rejected',
    error: new Error('Owned browser protocol client output limit'),
  };
  expect(() => {
    expectRetiredBrowserExec(settlement, { gracefulEmptyExit: false });
  }).toThrow(outside);
});

it('rejects nonempty output under either graceful policy', () => {
  const settlement: BrowserExecSettlement = { settled: 'resolved', output: 'x' };
  for (const option of options) {
    expect(() => {
      expectRetiredBrowserExec(settlement, option);
    }).toThrow(outside);
  }
});

it('accepts empty output only when a graceful empty exit is declared', () => {
  const settlement: BrowserExecSettlement = { settled: 'resolved', output: '' };
  expect(() => {
    expectRetiredBrowserExec(settlement, { gracefulEmptyExit: true });
  }).not.toThrow();
  expect(() => {
    expectRetiredBrowserExec(settlement, { gracefulEmptyExit: false });
  }).toThrow(outside);
});

it('rejects a non-Error rejection and retains the settlement as cause', () => {
  const settlement: BrowserExecSettlement = { settled: 'rejected', error: 'exit' };
  expect(() => {
    expectRetiredBrowserExec(settlement, { gracefulEmptyExit: true });
  }).toThrow(expect.objectContaining({ message: outside, cause: settlement }));
});

it('accepts exit and timeout rejections under either graceful policy', () => {
  for (const message of [
    'Owned browser protocol client failed',
    'Owned browser protocol client timeout',
  ]) {
    const settlement: BrowserExecSettlement = { settled: 'rejected', error: new Error(message) };
    for (const option of options) {
      expect(() => {
        expectRetiredBrowserExec(settlement, option);
      }).not.toThrow();
    }
  }
});

it('settles resolution and rejection without rejecting itself', async () => {
  await expect(settleBrowserExec(Promise.resolve('out'))).resolves.toEqual({
    settled: 'resolved',
    output: 'out',
  });
  const error = new Error('rejected exec');
  const settlement = await settleBrowserExec(Promise.reject(error));
  expect(settlement).toEqual({ settled: 'rejected', error });
  expect(settlement.settled === 'rejected' && settlement.error).toBe(error);
});

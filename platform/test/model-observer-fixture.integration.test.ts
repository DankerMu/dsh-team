import { expect, it } from 'vitest';
import { installModelObserver } from './model-observer-fixture.ts';

it.each(['permission-model', 'office-model'] as const)(
  'rejects a failed %s installation before offering observer operations',
  async (name) => {
    const failure = new Error('Owned profile installation failed');
    const result = Promise.reject(failure);
    // Keep the pre-cutover missing await from producing an unhandled rejection;
    // the public installer must propagate the original transport failure itself.
    void result.catch(() => undefined);

    await expect(installModelObserver(() => result, name, { nonce: null })).rejects.toBe(failure);
  },
);

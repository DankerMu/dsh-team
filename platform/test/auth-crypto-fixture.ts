import type { scrypt } from 'node:crypto';

export interface CallbackBarrier {
  derived: Promise<void>;
  hold: (deliver: () => void) => void;
  release: () => void;
  error?: Error;
}

export const cryptoBarrier: { queue: CallbackBarrier[]; calls: number } = {
  queue: [],
  calls: 0,
};

/** Runs real scrypt, controlling only callback delivery at the crypto boundary. */
export function controlledScrypt(actual: typeof scrypt) {
  return (...args: Parameters<typeof actual>): void => {
    const [password, salt, keyLength, options, callback] = args;
    const barrier = cryptoBarrier.queue.shift();
    cryptoBarrier.calls += 1;
    actual(password, salt, keyLength, options, (error, derivedKey) => {
      const deliver = (): void => {
        callback(barrier?.error ?? error, derivedKey);
      };
      if (barrier === undefined || error !== null) {
        deliver();
      } else {
        barrier.hold(deliver);
      }
    });
  };
}

export function createBarrier(error?: Error): CallbackBarrier {
  const derived = Promise.withResolvers<undefined>();
  let released = false;
  let held: (() => void) | undefined;
  return {
    derived: derived.promise,
    ...(error === undefined ? {} : { error }),
    hold: (deliver) => {
      held = deliver;
      derived.resolve(undefined);
      if (released) {
        held = undefined;
        deliver();
      }
    },
    release: () => {
      released = true;
      const deliver = held;
      held = undefined;
      deliver?.();
    },
  };
}

export function discardBarrier(barrier: CallbackBarrier): void {
  const index = cryptoBarrier.queue.indexOf(barrier);
  if (index !== -1) {
    cryptoBarrier.queue.splice(index, 1);
  }
  barrier.release();
}

export async function waitForDerivation(
  barrier: CallbackBarrier,
  pending: Promise<unknown>,
  label: string,
): Promise<void> {
  await Promise.race([
    barrier.derived,
    pending.then(() => {
      throw new Error(`${label} completed before real password derivation reached the barrier`);
    }),
  ]);
}

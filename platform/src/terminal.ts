import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';

export type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};
export type TerminalOutput = Writable & { isTTY?: boolean };

export interface TerminalSession {
  readPassword: (existing: boolean) => Promise<string | null>;
  close: () => void;
}

export class TerminalInputError extends Error {
  constructor() {
    super('Passwords do not match');
  }
}

/** A single supported readline session keeps all input hidden, including between prompts. */
export function createTerminal(
  input: TerminalInput,
  output: TerminalOutput,
  cancellation: AbortController,
): TerminalSession {
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const originalListeners = new Map(
    // Tuple identity lets cleanup remove only listeners installed during readline construction.
    input.eventNames().map((event) => [event, input.rawListeners(event)] as const),
  );
  const addedListeners = () =>
    input.eventNames().flatMap((event) =>
      input
        .rawListeners(event)
        .filter((listener) => !originalListeners.get(event)?.includes(listener))
        .map((listener) => ({ event, listener })),
    );
  const restoreInput = (): void => {
    try {
      input.setRawMode?.(wasRaw);
    } finally {
      if (wasFlowing) {
        input.resume();
      } else {
        input.pause();
      }
    }
  };
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  let closing = false;
  let closed = false;
  let readline: Interface;
  try {
    readline = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  } catch (error) {
    // Construction may set raw mode/install listeners before throwing, before a handle exists.
    for (const { event, listener } of addedListeners()) {
      // rawListeners preserves identities but Node types it as Function[]; no callable cast needed.
      Reflect.apply(input.removeListener.bind(input), input, [event, listener]);
    }
    muted.destroy();
    restoreInput();
    throw error;
  }
  const ownedInputListeners = addedListeners();
  const cancel = (): void => {
    cancellation.abort();
  };
  const onClose = (): void => {
    if (!closing) {
      cancel();
    }
  };
  let pendingLine: ((line: string) => void) | undefined;
  let bufferedLine: string | undefined;
  const receiveLine = (line: string): void => {
    if (pendingLine !== undefined) {
      const deliver = pendingLine;
      pendingLine = undefined;
      deliver(line);
    } else if (bufferedLine === undefined) {
      // Keep only one unconsumed line so pasted password/confirmation cannot lose confirmation.
      bufferedLine = line;
    } else {
      bufferedLine = undefined;
      cancel();
    }
  };
  readline.on('line', receiveLine);
  readline.on('SIGINT', cancel);
  // Readline forwards input errors before our stream listener; cancel without exposing payloads.
  readline.on('error', cancel);
  readline.on('close', onClose);
  input.on('error', cancel);
  output.on('error', cancel);

  const ask = (prompt: string): Promise<string> => {
    const signal = cancellation.signal;
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const queued = bufferedLine;
    bufferedLine = undefined;
    const onAbort = (): void => {
      pendingLine = undefined;
      reject(new Error('Administrator operation cancelled'));
    };
    const onLine = (line: string): void => {
      signal.removeEventListener('abort', onAbort);
      pendingLine = undefined;
      try {
        output.write('\n');
        resolve(line);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (queued === undefined) {
      pendingLine = onLine;
    }
    try {
      output.write(prompt);
      if (queued !== undefined && !signal.aborted) {
        onLine(queued);
      }
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      pendingLine = undefined;
      reject(error);
    }
    return promise;
  };

  return {
    async readPassword(existing) {
      if (existing) {
        const answer = (await ask('Reset password? [y/N]: ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          return null;
        }
      }
      const password = await ask('Password: ');
      const confirmation = await ask('Confirm password: ');
      if (password !== confirmation) {
        throw new TerminalInputError();
      }
      return password;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closing = true;
      cancellation.abort();
      bufferedLine = undefined;
      try {
        readline.close();
      } finally {
        readline.removeListener('SIGINT', cancel);
        readline.removeListener('error', cancel);
        readline.removeListener('close', onClose);
        readline.removeListener('line', receiveLine);
        input.removeListener('error', cancel);
        output.removeListener('error', cancel);
        muted.destroy();
        for (const { event, listener } of ownedInputListeners) {
          Reflect.apply(input.removeListener.bind(input), input, [event, listener]);
        }
        restoreInput();
      }
    },
  };
}

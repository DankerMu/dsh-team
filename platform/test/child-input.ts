import type { Writable } from 'node:stream';

/** Ends `stdin` with `input`, if any, and settles once it closed. A child that exits without
 * reading closes the pipe, with EPIPE, with ECONNRESET where its stdio is a socketpair (Linux), or,
 * once Node destroys the stdin of an exited child, with no error; none is a failure. Any other
 * stdin error is. */
export function endInput(stdin: Writable, input?: string) {
  return new Promise<void>((resolve, reject) => {
    stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve();
      else reject(error);
    });
    // After `finish`, or after the child exited first; an error before it has already settled.
    stdin.once('close', resolve);
    stdin.end(input);
  });
}

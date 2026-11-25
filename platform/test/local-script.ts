import { execFile } from 'node:child_process';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { NODE } from './office-isolation-stack-fixture.ts';

const [nodeBinary = 'node', ...nodeFlags] = NODE;

/** Ends `stdin` with `input` and settles once it closed. A child that exits without reading closes
 * the pipe, with EPIPE or, once Node destroys the stdin of an exited child, with no error; neither
 * is a failure. Any other stdin error is. */
export function endInput(stdin: Writable, input: string) {
  return new Promise<void>((resolve, reject) => {
    stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') resolve();
      else reject(error);
    });
    // After `finish`, or after the child exited first; an error before it has already settled.
    stdin.once('close', resolve);
    stdin.end(input);
  });
}

/** A container-shaped ESM script under the local `node`, `input` on stdin as `docker exec -i`
 * delivers it; stdout parsed as JSON. */
export async function localScript(
  script: string,
  argv: string[],
  env: Record<string, string>,
  input = '',
) {
  const options = { env: { ...process.env, ...env } };
  const pending = promisify(execFile)(nodeBinary, [...nodeFlags, script, ...argv], options);
  const { stdin } = pending.child;
  if (stdin === null) throw new Error('Local script has no stdin');
  const [{ stdout }] = await Promise.all([pending, endInput(stdin, input)]);
  return JSON.parse(stdout) as unknown;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { endInput } from './child-input.ts';
import { NODE } from './office-isolation-stack-fixture.ts';

const [nodeBinary = 'node', ...nodeFlags] = NODE;

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

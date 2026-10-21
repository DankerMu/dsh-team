import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const program = `
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { createDeploymentSetupEvidence } from './platform/test/deployment-setup-evidence.ts';
const admitted = once(process, 'message');
process.send({ state: 'ready' });
await admitted;
const primary = Object.assign(new AggregateError(
  [new Error('private-aggregate-canary')], 'private-primary-canary',
  { cause: new Error('private-cause-canary') },
), { output: 'private-output-canary' });
const setup = createDeploymentSetupEvidence();
let primaryPreserved = false;
try {
  await setup.run('health', () => Promise.reject(primary));
} catch (error) {
  primaryPreserved = error === primary;
}
const before = process.stdout.listeners('error');
const write = process.stdout.write;
let attempts = 0;
// Count attempts at the external stream boundary, delegating unchanged to the real OS write.
process.stdout.write = function (...args) {
  attempts++;
  return Reflect.apply(write, this, args);
};
const published = await setup.publish();
await setImmediate();
const after = process.stdout.listeners('error');
process.send({
  state: 'result', primaryPreserved, attempts, published, snapshot: setup.snapshot(),
  listenersRestored: before.length === after.length && before.every((listener, index) => listener === after[index]),
}, () => process.disconnect());
`;

it('keeps the primary setup failure available when the default stdout pipe loses its reader', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // A broken publication must settle rather than leave an unbounded IPC child.
    timeout: 8_000,
    killSignal: 'SIGKILL',
  });
  const closed = once(child, 'close');
  const ready = once(child, 'message');
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    child.kill('SIGKILL');
    await closed;
    throw new Error('Missing owned child output pipes');
  }
  stderr.resume();
  const pipeClosed = once(stdout, 'close');
  stdout.destroy();
  let report: unknown;
  let exit: unknown;

  try {
    await pipeClosed;
    expect((await ready)[0]).toEqual({ state: 'ready' });
    const result = once(child, 'message');
    child.send({ state: 'publish' });
    report = await Promise.race([
      result.then(([value]): unknown => value),
      closed.then(() => undefined),
    ]);
    exit = await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }

  expect(report).toEqual({
    state: 'result',
    primaryPreserved: true,
    attempts: 1,
    published: false,
    snapshot: {
      current: 'health',
      lastCompleted: null,
      firstFailure: { phase: 'health', code: 'operation-failed', cause: 'unknown' },
      operations: { health: 'failed' },
      cleanup: { deploymentDrain: 'not-required', resources: 'not-required' },
      evidence: 'unavailable',
    },
    listenersRestored: true,
  });
  expect(exit).toEqual([0, null]);
  expect(JSON.stringify(report)).not.toContain('private-');
}, 15_000);

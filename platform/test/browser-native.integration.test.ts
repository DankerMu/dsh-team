import type * as ChildProcess from 'node:child_process';
import type * as Os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { liveProcessBirth, processBirth } from '../../scripts/probe-browser-native.mjs';

const UNAVAILABLE = 'browser process birth identity unavailable';
const MISSING_INTERPRETER = '/nonexistent/dsh-team-native-observer';

// A real Node child stands in for the native query so its pipes, exit and kill are observable.
const native = vi.hoisted<{
  answer: (stdout: string) => string;
  binary: string;
  script: string;
  child: ChildProcess.ChildProcess | undefined;
  limit: NodeJS.Timeout | undefined;
  limitFired: boolean;
}>(() => {
  const answer = (stdout: string) => `process.stdout.write(${JSON.stringify(stdout)})`;
  return {
    answer,
    binary: process.execPath,
    script: answer('ok 2 1700000000 123456\n'),
    child: undefined,
    limit: undefined,
    limitFired: false,
  };
});
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  platform: () => 'darwin',
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn(binary: string, _args: readonly string[], options: ChildProcess.SpawnOptions) {
      if (binary !== '/usr/bin/python3') throw new Error('Unexpected native observer process');
      const child = actual.spawn(native.binary, ['-e', native.script], options);
      native.child = child;
      // The cap characterization's 1000 ms limit starts when the stand-in really exists.
      child.once('spawn', () => {
        clearTimeout(native.limit);
        native.limit = setTimeout(() => {
          native.limitFired = true;
        }, 1000);
      });
      return child;
    },
    spawnSync(binary: string) {
      if (binary !== '/usr/bin/python3') throw new Error('Unexpected native observer process');
      throw new Error('Darwin native observation must not block the event loop');
    },
  };
});
afterEach(() => {
  const child = native.child;
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  clearTimeout(native.limit);
  native.binary = process.execPath;
  native.script = native.answer('ok 2 1700000000 123456\n');
  native.child = undefined;
  native.limit = undefined;
  native.limitFired = false;
});

it('retains generation identity while a live Darwin process becomes a zombie', async () => {
  const before = await processBirth(42);
  expect(await liveProcessBirth(42)).toBe(before);

  native.script = native.answer('ok 5 1700000000 123456\n');

  expect(await processBirth(42)).toBe(before);
  expect(await liveProcessBirth(42)).toBeNull();
});

it('recognizes only the native disappearance result as absence', async () => {
  native.script = native.answer('gone\n');

  await expect(processBirth(42)).rejects.toMatchObject({ code: 'ESRCH' });
  expect(await liveProcessBirth(42)).toBeNull();
});

it.each(['missing-interpreter', 'denied-native-query', 'unknown-state', 'invalid-microseconds'])(
  'retains unknown authority for %s rather than claiming process absence',
  async (failure) => {
    if (failure === 'missing-interpreter') native.binary = MISSING_INTERPRETER;
    if (failure === 'denied-native-query') native.script = 'process.exit(1)';
    if (failure === 'unknown-state') native.script = native.answer('ok 6 1700000000 123456\n');
    if (failure === 'invalid-microseconds')
      native.script = native.answer('ok 2 1700000000 1000000\n');

    await expect(processBirth(42)).rejects.toThrow();
    await expect(liveProcessBirth(42)).rejects.toThrow();
  },
);

it.each([
  { interpreter: 'an absent path, failing asynchronously', binary: MISSING_INTERPRETER },
  { interpreter: 'an invalid path, failing synchronously', binary: '/usr/bin/python3\0' },
])('reports $interpreter as unavailable without an absence code', async ({ binary }) => {
  native.binary = binary;

  const error = await processBirth(42).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('message', UNAVAILABLE);
  expect(error).not.toHaveProperty('code');
  await expect(liveProcessBirth(42)).rejects.toThrow(UNAVAILABLE);
});

it('keeps the event loop running while a hung native query is bounded and killed', async () => {
  native.script = 'setTimeout(() => {}, 60000)';
  const order: string[] = [];
  const tick = new Promise<void>((done) =>
    setTimeout(() => {
      order.push('timer');
      done();
    }, 50),
  );
  const started = performance.now();

  const error = await processBirth(42).catch((caught: unknown) => caught);
  order.push('settled');
  const elapsed = performance.now() - started;
  await tick;

  expect(order).toEqual(['timer', 'settled']);
  expect(error).toHaveProperty('message', UNAVAILABLE);
  expect(elapsed).toBeGreaterThanOrEqual(2000);
  const pid = native.child?.pid;
  expect(native.child?.signalCode).toBe('SIGKILL');
  expect(() => process.kill(pid ?? 0, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('kills a native query whose output exceeds 4096 bytes long before its time bound', async () => {
  native.script = "process.stdout.write('x'.repeat(4097));setTimeout(() => {}, 60000)";

  const error = await processBirth(42).catch((caught: unknown) => caught);

  expect(native.limitFired).toBe(false);
  expect(error).toHaveProperty('message', UNAVAILABLE);
  expect(native.child?.signalCode).toBe('SIGKILL');
});

it('lets a native query write exactly 4096 bytes without the cap killing it', async () => {
  native.script = "process.stdout.write('x'.repeat(4096));setTimeout(() => {}, 300)";

  const error = await processBirth(42).catch((caught: unknown) => caught);

  expect(error).toHaveProperty('message', UNAVAILABLE);
  expect(native.child?.signalCode).toBeNull();
  expect(native.child?.exitCode).toBe(0);
});

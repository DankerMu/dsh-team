import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { settleMainProcess, watchMainProcess } from './main-startup-fixture.ts';
import type { StartupObservation } from './main-startup-fixture.ts';

// Each child announces readiness on stdout only after its SIGTERM handler is installed.
const KEEP_ALIVE = "const keep = setInterval(() => {}, 1000); process.stdout.write('ready');";
const FAIL_ON_STOP = `${KEEP_ALIVE} process.on('SIGTERM', () => { clearInterval(keep); process.stderr.write(process.env.STOP_STDERR ?? ''); process.exitCode = 1; });`;
const KILL_ON_STOP = `${KEEP_ALIVE} process.on('SIGTERM', () => { process.kill(process.pid, 'SIGKILL'); });`;
const STOP_CLEANLY = `${KEEP_ALIVE} process.on('SIGTERM', () => { clearInterval(keep); });`;
const EXIT_EARLY = "process.stdout.write('ready'); process.exitCode = 1;";

const observation: StartupObservation = {
  exitCode: null,
  stderr: '',
  health: { status: 200, body: { status: 'ok' } },
};

async function mainChild(script: string, environment: Readonly<Record<string, string>> = {}) {
  const child = spawn(process.execPath, ['-e', script], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 6000,
    killSignal: 'SIGKILL',
  });
  const { closed, stderr } = watchMainProcess(child);
  await once(child.stdout, 'data');
  return { child, closed, stderr };
}

async function rejection(settled: Promise<unknown>): Promise<Error> {
  const error = await settled.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error('Expected an Error rejection');
  return error;
}

it('reports exit code, signal, stderr and the fulfilled observation when graceful stop exits 1', async () => {
  const main = await mainChild(FAIL_ON_STOP, { STOP_STDERR: 'shutdown rejected: held work' });
  const afterStop = vi.fn(() => Promise.resolve());
  const error = await rejection(
    settleMainProcess(
      main.child,
      main.closed,
      main.stderr,
      () => Promise.resolve(observation),
      afterStop,
    ),
  );
  expect(error.message).toContain('Main did not settle through graceful shutdown');
  expect(error.message).toContain('code=1');
  expect(error.message).toContain('signal=null');
  expect(error.message).toContain('health=200');
  expect(error.message).toContain('exitCode=null');
  expect(error.message).toContain('shutdown rejected: held work');
  expect(error.message).not.toContain('[stderr truncated');
  expect(error.cause).toBeUndefined();
  expect(afterStop).not.toHaveBeenCalled();
});

it('bounds stderr to its last 8192 characters with an explicit truncation marker', async () => {
  const output = Array.from({ length: 10_000 }, (_, index) =>
    String.fromCharCode(97 + (index % 26)),
  ).join('');
  const main = await mainChild(FAIL_ON_STOP, { STOP_STDERR: output });
  const error = await rejection(
    settleMainProcess(main.child, main.closed, main.stderr, () => Promise.resolve(observation)),
  );
  expect(error.message).toContain('code=1');
  expect(error.message).toContain(
    `[stderr truncated: 1808 earlier characters omitted]${output.slice(1808)}`,
  );
  expect(error.message).not.toContain(output.slice(1807));
});

it('names the terminating signal and keeps a rejected observation as the identical cause', async () => {
  const main = await mainChild(KILL_ON_STOP);
  const original = new Error('Startup neither exited nor served health before its deadline');
  const error = await rejection(
    settleMainProcess(main.child, main.closed, main.stderr, () => Promise.reject(original)),
  );
  expect(error).not.toBe(original);
  expect(error.message).toContain('Main did not settle through graceful shutdown');
  expect(error.message).toContain('code=null');
  expect(error.message).toContain('signal=SIGKILL');
  expect(error.cause).toBe(original);
});

it('returns the observation after a clean graceful stop and only then runs afterStop', async () => {
  const main = await mainChild(STOP_CLEANLY);
  const afterStop = vi.fn(() => {
    expect(main.child.exitCode).toBe(0);
    return Promise.resolve();
  });
  await expect(
    settleMainProcess(
      main.child,
      main.closed,
      main.stderr,
      () => Promise.resolve(observation),
      afterStop,
    ),
  ).resolves.toBe(observation);
  expect(afterStop).toHaveBeenCalledOnce();
});

it('neither signals nor fails a child that had already exited before the stop', async () => {
  const main = await mainChild(EXIT_EARLY);
  await main.closed;
  const kill = vi.spyOn(main.child, 'kill');
  await expect(
    settleMainProcess(main.child, main.closed, main.stderr, () => Promise.resolve(observation)),
  ).resolves.toBe(observation);
  expect(kill).not.toHaveBeenCalled();
});

it('rethrows the original observation error after a successful stop', async () => {
  const main = await mainChild(STOP_CLEANLY);
  const original = new Error('Main exited before reconciliation');
  const afterStop = vi.fn(() => Promise.resolve());
  const error = await rejection(
    settleMainProcess(
      main.child,
      main.closed,
      main.stderr,
      () => Promise.reject(original),
      afterStop,
    ),
  );
  expect(error).toBe(original);
  expect(afterStop).toHaveBeenCalledOnce();
});

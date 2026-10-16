import type * as ChildProcessModule from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import type * as DeploymentModule from './deployment-fixture.ts';
import { verifyDeployedCredentialPrivacy } from './deployment-privacy-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const control = vi.hoisted(
  (): {
    mode: 'slow' | 'timeout';
    lifecycle: UserImageLifecycle | undefined;
    platformId: string;
    elapsed: number;
    stopStatus: number | null | undefined;
    exitCode: unknown;
    restarted: boolean;
    childClosed: boolean;
    childSignal: string | null;
  } => ({
    mode: 'slow',
    lifecycle: undefined,
    platformId: '',
    elapsed: 0,
    stopStatus: undefined,
    exitCode: undefined,
    restarted: false,
    childClosed: false,
    childSignal: null,
  }),
);

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    // Only the captured audit stop gets an unresponsive external executable.
    // The actual command timer, kill, streams and close settlement remain intact.
    spawn(binary: string, args: readonly string[], options: SpawnOptions) {
      if (
        control.mode === 'timeout' &&
        binary === 'docker' &&
        args[0] === 'stop' &&
        args[1] === '--time' &&
        args[2] === '30' &&
        args[3] === control.platformId
      ) {
        const child = original.spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          options,
        );
        child.once('close', (_code, signal) => {
          control.childClosed = true;
          control.childSignal = signal;
        });
        return child;
      }
      return original.spawn(binary, args, options);
    },
  };
});

vi.mock('./deployment-fixture.ts', async (importOriginal) => {
  const original = await importOriginal<typeof DeploymentModule>();
  return {
    ...original,
    withDeployment(
      run: Parameters<typeof original.withDeployment>[0],
      prepare: Parameters<typeof original.withDeployment>[1],
    ) {
      return original.withDeployment(async (lifecycle, start) => {
        control.lifecycle = lifecycle;
        await run(
          {
            ...lifecycle,
            commandAsync: async (args, timeout) => {
              if (args[0] === 'start' && args[1] === control.platformId) control.restarted = true;
              if (args[0] !== 'stop' || args[1] !== '--time' || args[2] !== '30')
                return lifecycle.commandAsync(args, timeout);
              const identity = args[3];
              if (identity === undefined) throw new Error('Missing audit stop identity');
              const platform = await inspectAsync(lifecycle, identity);
              expect(platform.Id).toBe(identity);
              expect(platform.Name).toBe('/dsh-team-platform');
              expect(record(record(platform.Config).Labels)[OWNER_LABEL]).toBe(lifecycle.runId);
              control.platformId = identity;
              if (control.mode === 'slow') {
                const pause = ['kill', '--signal', 'STOP', identity];
                output(await lifecycle.commandAsync(pause, 15_000), pause);
              }
              const started = performance.now();
              const resume = async () => {
                if (control.mode !== 'slow') return;
                // The Engine owns the real 30s grace; fake driver time cannot
                // exercise a genuine 15–30s stop. This delay is the fault input.
                await delay(20_000);
                const args = ['kill', '--signal', 'CONT', identity];
                output(await lifecycle.commandAsync(args, 15_000), args);
              };
              // Settle continuation even when the old 15s caller already failed.
              const results = await Promise.allSettled([
                lifecycle.commandAsync(args, timeout).then((result) => {
                  control.elapsed = performance.now() - started;
                  control.stopStatus = result.status;
                  return result;
                }),
                resume(),
              ]);
              const failures = results.filter((result) => result.status === 'rejected');
              if (failures.length > 0)
                throw new AggregateError(
                  failures.map((failure): unknown => failure.reason),
                  'Controlled stop or continuation failed',
                );
              const stopped = results[0];
              if (stopped.status !== 'fulfilled') throw new Error('Missing stop settlement');
              if (stopped.value.status === 0)
                control.exitCode = record((await inspectAsync(lifecycle, identity)).State).ExitCode;
              return stopped.value;
            },
          },
          start,
        );
      }, prepare);
    },
  };
});

beforeEach(() => {
  control.mode = 'slow';
  control.lifecycle = undefined;
  control.platformId = '';
  control.elapsed = 0;
  control.stopStatus = undefined;
  control.exitCode = undefined;
  control.restarted = false;
  control.childClosed = false;
  control.childSignal = null;
});

afterEach(async () => {
  process.stdout.write(
    JSON.stringify({
      auditStopEnvelope: {
        mode: control.mode,
        elapsedMs: Math.round(control.elapsed),
        stopStatus: control.stopStatus,
        exitCode: control.exitCode,
        restarted: control.restarted,
        childClosed: control.childClosed,
        childSignal: control.childSignal,
      },
    }) + '\n',
  );
  if (control.lifecycle !== undefined && control.platformId !== '') {
    const result = await control.lifecycle.commandAsync(
      ['container', 'inspect', control.platformId],
      15_000,
    );
    expect(isAbsentResource(result, 'container', control.platformId)).toBe(true);
  }
});

it('completes the real audit after an owned graceful platform stop takes twenty seconds', async () => {
  await verifyDeployedCredentialPrivacy();

  expect(control.elapsed).toBeGreaterThan(15_000);
  expect(control.elapsed).toBeLessThan(30_000);
  expect(control.stopStatus).toBe(0);
  expect(control.exitCode).toBe(0);
  expect(control.restarted).toBe(true);
});

it('fails an overdue audit stop after real child closure and still retires its deployment', async () => {
  control.mode = 'timeout';

  await expect(verifyDeployedCredentialPrivacy()).rejects.toThrow('audit-error-retirement');

  expect(control.elapsed).toBeGreaterThan(30_000);
  expect(control.elapsed).toBeLessThan(60_000);
  expect(control.stopStatus).not.toBe(0);
  expect(control.childClosed).toBe(true);
  expect(control.childSignal).toBe('SIGKILL');
  expect(control.restarted).toBe(false);
});

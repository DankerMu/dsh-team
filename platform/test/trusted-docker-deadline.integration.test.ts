import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { caseBudget, ownerPresent } from './case-budget-fixture.ts';
import {
  awaitTerminal,
  CASE_MS,
  custodyCase,
  issuedInvocation,
  LEAF_READINESS_MS,
  TERMINAL_WAIT_MS,
} from './trusted-docker-custody-fixture.ts';
import { withTrustedDockerFixture } from './trusted-docker-fixture.ts';
import { ownerOf, waitFor } from './trusted-docker-uncaptured-fixture.ts';
import { groupSettlesAfterClose } from '../../scripts/trusted-docker-record.mjs';

// The custody case bound (see CASE_MS); cases that state no bound of their own get it.
vi.setConfig({ testTimeout: CASE_MS });

it('fails a readiness wait at once with its cause when the leaf exits before readiness', async () => {
  await custodyCase('early-exit', async (fixture) => {
    const started = await fixture.start();
    const since = Date.now();
    const issued = issuedInvocation(fixture, started);
    const { invocation, leafReady } = issued;

    const waited = leafReady();

    await expect(waited).rejects.toThrow(/^(terminal-published|owner-absent) /);
    expect(Date.now() - since).toBeLessThan(LEAF_READINESS_MS);
    await awaitTerminal(issued, {
      invocation,
      state: 'failed',
      command: { exitCode: 23, signal: null, settled: true },
      interruption: 'none',
      cleanup: { state: 'confirmed' },
    });
  });
});

it.each([
  ['initial check', 'release-early'],
  ['50ms recheck', 'release-blind'],
] as const)(
  'completes a held command whose release only the leaf watch %s sees',
  async (_, mode) => {
    await custodyCase(mode, async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      await issued.leafReady();
      if (mode === 'release-blind') writeFileSync(join(issued.temporary, 'release'), 'release');

      await awaitTerminal(issued, {
        state: 'failed',
        command: { exitCode: 17, settled: true },
        interruption: 'none',
      });
    });
  },
  CASE_MS,
);

it('fails a terminal wait at once with its evidence when the published terminal differs', async () => {
  await custodyCase('early-exit', async (fixture) => {
    const issued = issuedInvocation(fixture, await fixture.start());
    const since = Date.now();

    const waited = awaitTerminal(issued, { command: { exitCode: 17 } });

    await expect(waited).rejects.toThrow(/^terminal-mismatch .*"exitCode":23/);
    expect(Date.now() - since).toBeLessThan(TERMINAL_WAIT_MS);
  });
});

it('fails a terminal wait at once when the owner exits without publishing a terminal', async () => {
  await custodyCase('hold', async (fixture) => {
    const issued = issuedInvocation(fixture, await fixture.start());
    await issued.leafReady();
    await fixture.killOwner(issued.invocation);
    const since = Date.now();

    const waited = awaitTerminal(issued, { state: 'failed' });

    await expect(waited).rejects.toThrow(
      /owner exited without publishing result\.json[\s\S]*phase=terminal; leaf=alive/,
    );
    expect(Date.now() - since).toBeLessThan(TERMINAL_WAIT_MS);
  });
});

it('kills a fixture spawn cut to the case deadline and refuses one after it, naming the phase', () => {
  const budget = caseBudget(Date.now() + 200);
  const sleep = () =>
    budget.run('fixture sleep', process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
      encoding: 'utf8',
      timeout: 5000,
    });

  expect(sleep).toThrow(/^fixture sleep: killed at the case deadline after \d+ms$/);
  expect(sleep).toThrow(/^fixture sleep: case deadline passed before it started$/);
}, 5000);

// The case deadline, taken before the fixture is prepared, is below TERMINAL_WAIT_MS, so the held
// terminal wait always starts with less than its own 10s cap left and the deadline ends it.
// Measured (#687, 5 loaded runs, load 14-77): setup to leaf readiness at most 1835ms, about 750ms
// unloaded, leaving 6.2s of margin. #687 recorded this case failing at readiness under load it
// did not record, so the budget is not lowered to the measured maximum.
const SPENT_CASE_MS = 8000;

it('ends a held terminal wait at the case deadline with its attribution and still cleans up', async () => {
  await withTrustedDockerFixture(
    'hold',
    async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      await issued.leafReady();
      const since = Date.now();
      const left = fixture.deadline - since;

      await expect(awaitTerminal(issued, { state: 'failed' })).rejects.toThrow(
        /^Trusted Docker owner still running without result\.json after \d+ms: pid=\d+; phase=terminal; leaf=alive$/,
      );
      expect(Date.now() - since).toBeLessThan(left + 1000);
      expect(() => fixture.command(['status', issued.invocation])).toThrow(
        /^command status: case deadline passed before it started$/,
      );
      expect(fixture.inspect(['status', issued.invocation]).status).toBe(0);
    },
    undefined,
    Date.now() + SPENT_CASE_MS,
  );
}, 20_000);

// The launch and command waits below share one window from the 5s fixture deadline (after the
// killed start) that ends near 15s, below the 20_000 case bound. It cannot derive from
// fixture.deadline: that has passed.
const COMMAND_LAUNCH_MS = 10_000;

// The slow owner sleeps 4s before its manifest; its start gets 2.5s of the 5s case deadline, so
// the start is killed with the owner up, and the owner then launches the held command. The kill
// reaches only the start's pnpm: its orphaned start CLI may create the invocation and write
// launch.json after it, so both are awaited, never read at once.
it('settles the owner and held command of a start killed at the case deadline', async () => {
  const pids = { directory: '', owner: 0, command: 0 };
  try {
    const failed = await withTrustedDockerFixture(
      'slow-owner',
      async (fixture) => {
        pids.directory = fixture.directory;
        await delay(Math.max(0, fixture.deadline - Date.now() - 2500));
        expect(() => fixture.start()).toThrow(/^command start: killed at the case deadline after/);
        const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
        const invocation = () => (existsSync(base) ? readdirSync(base)[0] : undefined) ?? 'missing';
        const launch = () => join(base, invocation(), 'launch.json');
        const until = Date.now() + COMMAND_LAUNCH_MS;
        const left = () => until - Date.now();
        await waitFor(() => existsSync(launch()), left(), 'Slow start published no launch');
        pids.owner = ownerOf(launch());
        const child = join(base, invocation(), 'child.json');
        await waitFor(() => existsSync(child), left(), 'Slow owner launched no command');
        pids.command = ownerOf(child);
      },
      undefined,
      Date.now() + 5000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).errors.map(String)).toEqual([
      `Error: Uncaptured custody fixture authority retained: command ${String(pids.command)}`,
    ]);
    expect(ownerPresent(pids.owner)).toBe(false);
    expect(await groupSettlesAfterClose(pids.command)).toBe(true);
  } finally {
    for (const pid of [pids.owner, -pids.command].filter(Boolean))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already settled by the fixture: the green outcome.
      }
    rmSync(pids.directory, { recursive: true, force: true });
  }
}, 20_000);

import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  caseBudget,
  caseSpawn,
  fixtureProcessCustody,
  ownerPresent,
} from './trusted-docker-fixture.ts';

// A 3s case keeps 1.5s in reserve, so its child is cut at 1.5s; the kill and the throw take far
// less than the 1s slack, so a cut that ignored the reserve (3s) or waited for a trapped SIGTERM
// (the child's own 4s exit) misses the bound.
const CUT_CASE_MS = 3000;
const CUT_RESERVE_MS = 1500;
const CUT_SLACK_MS = 1000;
// The trapping child exits by itself past the case, so a SIGTERM cut ends the call instead of hanging it.
const TRAPPED_EXIT_MS = 4000;
// A 1s case cut at 0.5s, for the message shapes alone.
const SHORT_CASE_MS = 1000;
const SHORT_RESERVE_MS = 500;
// The longest call above ends with its trapped child's own exit, well inside this bound.
const CASE_MS = 10_000;

function cutFailure(caseMs: number, reserveMs: number, descendants?: () => string) {
  const { spawn } = caseSpawn(caseMs, reserveMs, descendants);
  const child = `process.on('SIGTERM',()=>{});setTimeout(()=>{},${String(TRAPPED_EXIT_MS)});`;
  try {
    spawn('trapped child', process.execPath, ['-e', child], { encoding: 'utf8' });
  } catch (error) {
    if (!(error instanceof Error && error.cause instanceof Error)) throw error;
    return { message: error.message, cut: error.cause.message };
  }
  throw new Error('The trapped child was not cut');
}

it(
  'kills a SIGTERM-trapping child at the reserved cut and keeps the budget message as its cause',
  () => {
    const since = Date.now();

    const { message, cut } = cutFailure(CUT_CASE_MS, CUT_RESERVE_MS, () => 'pid=1 alive, killed');
    const elapsed = Date.now() - since;

    expect(elapsed).toBeLessThan(CUT_CASE_MS - CUT_RESERVE_MS + CUT_SLACK_MS);
    expect(message).toMatch(
      /^trapped child: killed at the case deadline after \d+ms; descendants: pid=1 alive, killed$/,
    );
    expect(cut).toMatch(/^trapped child: killed at the case deadline after \d+ms$/);
    expect(message).toBe(`${cut}; descendants: pid=1 alive, killed`);
  },
  CASE_MS,
);

it.each([
  { site: 'records no descendants', descendants: undefined, reported: 'not observed' },
  {
    site: 'cannot observe its descendants',
    descendants: () => {
      throw new TypeError('/private/descendant output');
    },
    reported: 'unobservable (TypeError)',
  },
])(
  'keeps the cut phase and milliseconds when the site $site',
  ({ descendants, reported }) => {
    const { message, cut } = cutFailure(SHORT_CASE_MS, SHORT_RESERVE_MS, descendants);

    expect(cut).toMatch(/^trapped child: killed at the case deadline after \d+ms$/);
    expect(message).toBe(`${cut}; descendants: ${reported}`);
  },
  CASE_MS,
);

// The fixture's literal process retirement window; without a case deadline it is settle's only exit.
const RETIREMENT_MS = 5000;
// The whole window, its per-poll observers and cleanup's own settle; a mutant that tolerates an
// injected code waits the window out, so its red is the assertion, not this timeout.
const WINDOW_CASE_MS = 15_000;
// The transient probe answers EPERM this often, then the real absence.
const TRANSIENT_EPERMS = 3;

const kill = process.kill.bind(process);
const killError = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

/**
 * Settle one real detached node group while each `process.kill(sign * pid, signal)` call reaches
 * `fault`; every other call, and `fault`'s own `real`, is the real kill (#690). The spy is restored
 * before the custody's real cleanup retires the group.
 */
async function settleWithFault(
  group: boolean,
  sign: 1 | -1,
  signal: NodeJS.Signals | 0,
  fault: (real: () => true, call: number) => true,
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-group-eperm-')));
  const custody = fixtureProcessCustody({ PATH: process.env.PATH }, directory, caseBudget());
  try {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const identity = await custody.track(child);
    let calls = 0;
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, sent) => {
      if (pid !== sign * identity.pid || sent !== signal) return kill(pid, sent);
      calls += 1;
      return fault(() => kill(pid, sent), calls);
    });
    const since = Date.now();
    try {
      const failure = await custody.settle(identity, group).then(
        () => undefined,
        (error: unknown) => error,
      );
      return { failure, elapsed: Date.now() - since, calls, pid: identity.pid };
    } finally {
      spy.mockRestore();
    }
  } finally {
    await custody.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}

it(
  'settles a group whose group kill retires it and answers EPERM',
  async () => {
    const denied = killError('EPERM');

    const { failure, calls, pid } = await settleWithFault(true, -1, 'SIGKILL', (real) => {
      real();
      throw denied;
    });

    expect(failure).toBeUndefined();
    expect(calls).toBe(1);
    expect(ownerPresent(-pid)).toBe(false);
  },
  WINDOW_CASE_MS,
);

it(
  'settles a group whose probe answers EPERM a few times before its real absence',
  async () => {
    const denied = killError('EPERM');

    const { failure, calls, pid } = await settleWithFault(true, -1, 0, (real, call) => {
      if (call <= TRANSIENT_EPERMS) throw denied;
      return real();
    });

    expect(failure).toBeUndefined();
    // The injected EPERMs, then the one real probe that found the group absent.
    expect(calls).toBe(TRANSIENT_EPERMS + 1);
    expect(ownerPresent(-pid)).toBe(false);
  },
  WINDOW_CASE_MS,
);

it(
  'fails a group whose probe answers EPERM for the whole window with the stalled error and that EPERM as cause',
  async () => {
    const denied = killError('EPERM');

    const { failure, elapsed, pid } = await settleWithFault(true, -1, 0, () => {
      throw denied;
    });

    expect(failure).toBeInstanceOf(Error);
    // toBeInstanceOf has just asserted the Error the compiler cannot see through `unknown`.
    const { message, cause } = failure as Error;
    expect(message).toMatch(
      new RegExp(
        `^Owned custody fixture process did not retire after \\d+ms: pid=${String(pid)} present=false group present=true$`,
      ),
    );
    expect(cause).toBe(denied);
    expect(elapsed).toBeGreaterThanOrEqual(RETIREMENT_MS);
  },
  WINDOW_CASE_MS,
);

it(
  'fails a group whose group kill answers EPERM without retiring it with the stalled error and that EPERM as cause',
  async () => {
    const denied = killError('EPERM');

    const { failure, elapsed, pid } = await settleWithFault(true, -1, 'SIGKILL', () => {
      throw denied;
    });

    expect(failure).toBeInstanceOf(Error);
    // toBeInstanceOf has just asserted the Error the compiler cannot see through `unknown`.
    const { message, cause } = failure as Error;
    // The live leader short-circuits every probe, so only the kill's EPERM can be the cause.
    expect(message).toMatch(
      new RegExp(
        `^Owned custody fixture process did not retire after \\d+ms: pid=${String(pid)} present=true group present=true$`,
      ),
    );
    expect(cause).toBe(denied);
    expect(elapsed).toBeGreaterThanOrEqual(RETIREMENT_MS);
  },
  WINDOW_CASE_MS,
);

it.each([
  { site: 'a single-process kill', group: false, sign: 1, signal: 'SIGKILL', code: 'EPERM' },
  { site: 'the group probe', group: true, sign: -1, signal: 0, code: 'EINVAL' },
  { site: 'the group kill', group: true, sign: -1, signal: 'SIGKILL', code: 'EINVAL' },
] as const)(
  'rejects at once with the $code of $site',
  async ({ group, sign, signal, code }) => {
    const error = killError(code);

    const { failure } = await settleWithFault(group, sign, signal, () => {
      throw error;
    });

    expect(failure).toBe(error);
  },
  WINDOW_CASE_MS,
);

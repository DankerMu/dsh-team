import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export function ownerPresent(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH is absence; any other observation error leaves the wait running.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
  }
  return true;
}

/** Inner fixture waits end by the case deadline; cleanup and terminal evidence keep full bounds. */
export function caseBudget(deadline?: number) {
  let reserved = false;
  const limit = (phase: string, milliseconds: number) => {
    if (reserved || deadline === undefined) return milliseconds;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${phase}: case deadline passed before it started`);
    return Math.min(milliseconds, remaining);
  };
  // A spawnSync whose own timeout is cut to the case deadline; a cut kill names its phase and wait.
  const run = (
    phase: string,
    file: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding & { timeout: number },
  ) => {
    const timeout = limit(phase, options.timeout);
    const since = Date.now();
    const result = spawnSync(file, args, { ...options, timeout });
    // Only the cut timeout is the deadline's kill; ENOENT, ENOBUFS and the like pass through.
    if (
      timeout < options.timeout &&
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    )
      throw new Error(
        `${phase}: killed at the case deadline after ${String(Date.now() - since)}ms`,
      );
    return result;
  };
  // A group wait also reports its group, which members can keep present after the leader is gone;
  // a `cause` (the last observation error the wait tolerated) is kept on the error.
  const stalled = (phase: string, since: number, pid: unknown, group = false, cause?: unknown) =>
    new Error(
      `${phase} after ${String(Date.now() - since)}ms: pid=${String(pid)} present=${String(ownerPresent(Number(pid)))}${group ? ` group present=${String(ownerPresent(-Number(pid)))}` : ''}`,
      cause === undefined ? undefined : { cause },
    );
  // Terminal evidence is synchronous, so its full bounds end with it.
  const unbounded = <T>(operation: () => T) => {
    const outer = reserved;
    reserved = true;
    try {
      return operation();
    } finally {
      reserved = outer;
    }
  };
  // Cleanup awaits, so a restoring flag would lapse at its first await: this one stays set.
  const reserve = () => {
    reserved = true;
  };
  return {
    deadline: deadline ?? Number.POSITIVE_INFINITY,
    limit,
    run,
    stalled,
    unbounded,
    reserve,
  };
}
export type CaseBudget = ReturnType<typeof caseBudget>;

/**
 * Synchronous children of a case that started now with `caseMs` (#656). Each is capped at the
 * whole budget, above what remains before `reserveMs`, so the case deadline always cuts it, with
 * an uncatchable kill; a failure keeps the budget's message and adds its site's descendants.
 */
export function caseSpawn(
  caseMs: number,
  reserveMs: number,
  descendants?: (budget: CaseBudget) => string,
) {
  const budget = caseBudget(Date.now() + caseMs - reserveMs);
  const spawn = (
    phase: string,
    file: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => {
    try {
      return budget.run(phase, file, args, { ...options, timeout: caseMs, killSignal: 'SIGKILL' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let observed: string;
      try {
        observed = descendants?.(budget) ?? 'not observed';
      } catch (failure) {
        // A failed observation must not replace the cut; only its kind is named, never its text.
        observed = `unobservable (${failure instanceof Error ? failure.name : typeof failure})`;
      }
      throw new Error(`${message}; descendants: ${observed}`, { cause: error });
    }
  };
  return { budget, spawn };
}
export type CaseSpawn = ReturnType<typeof caseSpawn>['spawn'];

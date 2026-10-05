const FAILURE_LIMIT = 10;
const WINDOW_MS = 900_000;
const SWEEP_INTERVAL_MS = 60_000;

interface FailureWindow {
  firstFailureAt: number;
  count: number;
}

export interface LoginFailureLimiter {
  isBlocked(email: string, sourceAddress: string, now: number): boolean;
  recordFailure(email: string, sourceAddress: string, now: number): void;
}

/** Creates one in-memory login-failure limiter owned by a single login plugin. */
export function createLoginFailureLimiter(): LoginFailureLimiter {
  const windows = new Map<string, Map<string, FailureWindow>>();
  let lastSweepAt: number | undefined;

  function sweepExpired(now: number): void {
    if (lastSweepAt !== undefined && now - lastSweepAt < SWEEP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = now;
    for (const [email, bySource] of windows) {
      for (const [sourceAddress, entry] of bySource) {
        if (now >= entry.firstFailureAt + WINDOW_MS) {
          bySource.delete(sourceAddress);
        }
      }
      if (bySource.size === 0) {
        windows.delete(email);
      }
    }
  }

  function liveWindow(
    email: string,
    sourceAddress: string,
    now: number,
  ): FailureWindow | undefined {
    sweepExpired(now);
    const bySource = windows.get(email);
    if (bySource === undefined) {
      return undefined;
    }
    const entry = bySource.get(sourceAddress);
    if (entry === undefined) {
      return undefined;
    }
    if (now >= entry.firstFailureAt + WINDOW_MS) {
      bySource.delete(sourceAddress);
      if (bySource.size === 0) {
        windows.delete(email);
      }
      return undefined;
    }
    return entry;
  }

  return {
    isBlocked(email, sourceAddress, now) {
      const entry = liveWindow(email, sourceAddress, now);
      return entry !== undefined && entry.count >= FAILURE_LIMIT;
    },
    recordFailure(email, sourceAddress, now) {
      const existing = liveWindow(email, sourceAddress, now);
      if (existing === undefined) {
        const bySource = windows.get(email);
        const entry = { firstFailureAt: now, count: 1 };
        if (bySource === undefined) {
          windows.set(email, new Map([[sourceAddress, entry]]));
        } else {
          bySource.set(sourceAddress, entry);
        }
        return;
      }
      if (existing.count < FAILURE_LIMIT) {
        existing.count += 1;
      }
    },
  };
}

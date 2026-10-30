export interface TrackedRescue {
  readonly promise: Promise<void>;
  readonly settled: () => boolean;
  readonly failure: () => unknown;
}

export function trackRescue(rescue: Promise<void>): TrackedRescue {
  let settled = false;
  let failure: unknown;
  rescue.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  return { promise: rescue, settled: () => settled, failure: () => failure };
}

// Retains an unconsumed first rescue failure; a failure already propagated as the primary is not repeated.
export async function settleRescue(
  tracked: TrackedRescue | undefined,
  rescue: () => Promise<void>,
  primary: { error: unknown } | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  if (tracked !== undefined) {
    if (!tracked.settled()) await tracked.promise.catch(() => undefined);
    const failure = tracked.failure();
    if (failure !== undefined && !Object.is(failure, primary?.error)) failures.push(failure);
  }
  await rescue().catch((error: unknown) => {
    failures.push(error);
  });
  if (failures.length === 0) return;
  if (primary === undefined) throw new AggregateError(failures, 'Acquisition rescue failed');
  throw new AggregateError([primary.error, ...failures], 'Acquisition scenario and rescue failed');
}

export type OfficeOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settleOfficeEvidence<T>(outcome: OfficeOutcome<T>, persist: () => void): T {
  try {
    persist();
  } catch (error) {
    if (outcome.ok) throw error;
    throw new AggregateError(
      [outcome.error, error],
      'Office delegation scenario and failure evidence persistence failed',
      { cause: error },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

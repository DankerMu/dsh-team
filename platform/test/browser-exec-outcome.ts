export type BrowserExecSettlement =
  { settled: 'resolved'; output: string } | { settled: 'rejected'; error: unknown };

const retiredRejections = new Set([
  'Owned browser protocol client failed',
  'Owned browser protocol client timeout',
]);

export const settleBrowserExec = (client: Promise<string>): Promise<BrowserExecSettlement> =>
  client.then(
    (output): BrowserExecSettlement => ({ settled: 'resolved', output }),
    (error: unknown): BrowserExecSettlement => ({ settled: 'rejected', error }),
  );

export const expectRetiredBrowserExec = (
  settlement: BrowserExecSettlement,
  options: { gracefulEmptyExit: boolean },
): void => {
  if (
    settlement.settled === 'rejected' &&
    settlement.error instanceof Error &&
    retiredRejections.has(settlement.error.message)
  )
    return;
  if (options.gracefulEmptyExit && settlement.settled === 'resolved' && settlement.output === '')
    return;
  throw new Error('Retired browser exec settled outside the declared outcomes', {
    cause: settlement,
  });
};

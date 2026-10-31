/** Released DSH 0.2.1 Web launch-line matcher for one bound address. Token text stays in the caller. */
function launchLine(address: string): RegExp {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n)dsh web: http://${escaped}:3080/\\?token=([A-Za-z0-9_-]{43})\\r?(?:\\n|$)`,
  );
}

export function launchTokenPresent(logs: string, address: string): boolean {
  return launchLine(address).exec(logs) !== null;
}

export function extractLaunchToken(logs: string, address: string): string | undefined {
  return launchLine(address).exec(logs)?.[1];
}

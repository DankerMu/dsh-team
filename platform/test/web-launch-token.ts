/** Released DSH Web launch-line matcher. Token text stays in the caller. */
const LAUNCH_LINE =
  /(?:^|\r?\n)dsh web: http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)(?: \(LAN: http:\/\/[^\s/?]+:3080\/\?token=[A-Za-z0-9_-]+\))?(?:\r?\n|$)/;

export function launchTokenPresent(logs: string): boolean {
  return LAUNCH_LINE.exec(logs) !== null;
}

export function extractLaunchToken(logs: string): string | undefined {
  return LAUNCH_LINE.exec(logs)?.[1];
}

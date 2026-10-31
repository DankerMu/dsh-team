/** Released DSH 0.2.1 Web launch-line matcher for one bound address. Token text stays in the caller. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function extractLaunchToken(logs: string, address: string): string | undefined {
  const prefix = `dsh web: http://${address}:3080/?token=`;
  for (const raw of logs.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith(prefix)) continue;
    const token = line.slice(prefix.length);
    if (TOKEN.test(token)) return token;
  }
  return undefined;
}

export function launchTokenPresent(logs: string, address: string): boolean {
  return extractLaunchToken(logs, address) !== undefined;
}

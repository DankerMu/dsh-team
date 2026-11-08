import { PROFILE_INCOMPATIBLE } from '../audit/index.ts';

/**
 * dsh-app-boot 0.2.1 stderr prefixes for a profile's own unloadable bundle (`reportSkippedBundles`)
 * and its preflight-rejected plugin row (`prepareProfileEntries`); resetting `profiles/` clears both.
 */
export const PROFILE_REJECTION_MARKERS = [
  'dsh: skipping profile bundle',
  'dsh: disabling profile plugin',
] as const;

/** Judged on already-sanitized lines; only a line prefix counts, the rest is never read. */
export function profileIncompatible(lines: readonly string[]): boolean {
  return lines.some((line) => PROFILE_REJECTION_MARKERS.some((marker) => line.startsWith(marker)));
}

/** The code is the first line of the last error; no other writer's first line equals it. */
export function lastErrorCode(lastError: string | null): typeof PROFILE_INCOMPATIBLE | null {
  return lastError?.split('\n', 1)[0] === PROFILE_INCOMPATIBLE ? PROFILE_INCOMPATIBLE : null;
}

export function withFailureCode(lastError: string, incompatible: boolean): string {
  return incompatible ? `${PROFILE_INCOMPATIBLE}\n${lastError}` : lastError;
}

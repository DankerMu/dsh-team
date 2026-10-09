export interface DockerCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/** External Docker process boundary; timeout is milliseconds, no shell interpolation. */
export type DockerCommand = (args: readonly string[], timeout: number) => DockerCommandResult;

/** Only exact-target daemon absence is safe to preserve through Web diagnostic redaction. */
export function isAbsentResource(
  result: DockerCommandResult,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
): boolean {
  if (result.error !== undefined || result.status !== 1) return false;
  const stdout = result.stdout.replace(/\r?\n$/, '');
  if (stdout !== '' && stdout !== '[]') return false;
  const diagnostic = result.stderr.replace(/\r?\n$/, '');
  const absent = [kind, 'object'].some((missingKind) =>
    ['Error response from daemon:', 'Error:'].some(
      (prefix) => diagnostic === `${prefix} No such ${missingKind}: ${name}`,
    ),
  );
  return (
    absent ||
    (kind === 'volume' &&
      diagnostic === `Error response from daemon: get ${name}: no such volume`) ||
    (kind === 'network' && diagnostic === `Error response from daemon: network ${name} not found`)
  );
}

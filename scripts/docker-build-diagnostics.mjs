const BUILD_PHASES = {
  '[internal] load build definition': 'definition',
  '[internal] load metadata': 'metadata',
  '[internal] load build context': 'context',
  '[internal] load .dockerignore': 'context',
  '[auth]': 'authentication',
  'exporting to image': 'export',
};
const BUILD_SIGNALS = [
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGABRT',
  'SIGSEGV',
  'SIGPIPE',
  'SIGQUIT',
];

function lastBuildHeader(stderr) {
  const header =
    /^#([1-9]\d{0,5}) (?:\[(build|runtime) ([1-9]\d{0,3})\/([1-9]\d{0,3})\] (FROM|RUN|COPY|WORKDIR|USER|EXPOSE|CMD|ENV|ARG|LABEL|ENTRYPOINT|ADD) |(\[internal\] load build definition|\[internal\] load metadata|\[internal\] load build context|\[internal\] load \.dockerignore|\[auth\]|exporting to image)(?= |\r?\n))[^\r\n]*\r?\n/gm;
  let last = null;
  for (let match = header.exec(stderr); match !== null; match = header.exec(stderr)) {
    const step = match[3] === undefined ? null : Number(match[3]);
    const total = match[4] === undefined ? null : Number(match[4]);
    if (step !== null && total !== null && step > total) continue;
    last = {
      vertex: Number(match[1]),
      phase: match[2] ?? BUILD_PHASES[match[6] ?? ''] ?? 'unknown',
      step,
      total,
      instruction: match[5] ?? null,
    };
  }
  return last;
}

function errorCode(error) {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    const value = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    // Optional metadata is unknown when a caller-owned proxy cannot be inspected safely.
    return undefined;
  }
}

function buildTermination(result, signal) {
  const code = errorCode(result.error);
  if (code === 'ETIMEDOUT') return 'deadline';
  if (code === 'ENOBUFS') return 'output-limit';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC') return 'spawn-failure';
  if (result.error !== undefined) return 'unknown';
  if (signal !== null) return 'signal';
  return result.status !== null && result.status !== 0 ? 'exit' : 'unknown';
}

/**
 * Project only fixed fields from the original bounded build result, never raw output or errors.
 * @param {{status: number | null, stderr: string, error?: unknown, signal?: string | null}} result
 * @param {number} timeoutMs
 * @param {number} started
 */
export function buildFailureDiagnostic(result, timeoutMs, started) {
  const signal =
    result.signal !== undefined && result.signal !== null && BUILD_SIGNALS.includes(result.signal)
      ? result.signal
      : null;
  return {
    termination: buildTermination(result, signal),
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    timeoutMs,
    exitStatus: result.status,
    signal,
    lastObservedBuildHeader: lastBuildHeader(result.stderr),
  };
}

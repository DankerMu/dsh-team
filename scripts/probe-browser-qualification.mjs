/** Closed, bounded metadata for verification qualification failures; never traffic/errors as text. */
const phases = new Set([
  'browser-launch',
  'page-attach',
  'online-evaluate',
  'online-invariant',
  'resource-identity',
  'bridge-witness',
  'host-ipv4-control',
  'host-ipv6-control',
  'private-probe-execution',
  'private-state',
  'private-ipv4-probe',
  'private-ipv6-probe',
  'private-proof-invariants',
  'final-resource-identity',
  'control-cleanup',
  'page-cleanup',
  'chrome-cleanup',
  'evidence-write',
]);
const codes = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'EINVAL',
  'ENODEV',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ABORT_ERR',
  'BROWSER_OFFLINE',
  'HOST_REACHABLE',
  'PROBE_TIMEOUT',
  'IPV6_DAD_FAILED',
  'IPV6_ADDRESS_DISAPPEARED',
  'BRIDGE_IDENTITY_CHANGED',
  'PRIVATE_PROCESS_FAILED',
  'PRIVATE_PROCESS_TIMEOUT',
  'PRIVATE_PROCESS_SIGNAL',
  'PRIVATE_JSON_INVALID',
  'PRIVATE_PROOF_INVALID',
  'UNKNOWN',
]);
const invariantNames = new Set([
  'namespaceDistinct',
  'noIPv4DefaultRoute',
  'privateIPv4Present',
  'onlyLoopbackIPv6',
  'eth0IPv6Disabled',
  'hostIPv4Blocked',
  'linkScopeIPv6Blocked',
]);
const cleanupPhases = new Set(['control-cleanup', 'page-cleanup', 'chrome-cleanup']);
const processOutcomes = new Set(['process-error', 'nonzero-exit', 'successful-exit']);
export function qualificationError(code, phase, invariants = []) {
  const error = new Error('browser qualification failed');
  error.code = codes.has(code) ? code : 'UNKNOWN';
  if (phases.has(phase)) error.qualificationPhase = phase;
  error.qualificationInvariants = invariants
    .filter((value) => invariantNames.has(value))
    .slice(0, 7);
  return error;
}
function errorKind(error) {
  if (error instanceof AggregateError) return 'AggregateError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof RangeError) return 'RangeError';
  return error instanceof Error ? 'Error' : 'unknown-thrown-value';
}
function selectedError(error, phase, id) {
  const row = {
    id,
    kind: errorKind(error),
    code: codes.has(error?.code) ? error.code : 'UNKNOWN',
    phase: phases.has(error?.qualificationPhase) ? error.qualificationPhase : phase,
  };
  if (Array.isArray(error?.qualificationInvariants))
    row.invariants = error.qualificationInvariants
      .filter((value) => invariantNames.has(value))
      .slice(0, 7);
  if (processOutcomes.has(error?.qualificationOutcome))
    row.processOutcome = error.qualificationOutcome;
  return row;
}
function projectQualificationError(error, phase, observedPhases) {
  const seen = new Map();
  let nodes = 0;
  let dropped = 0;
  const visit = (value, depth) => {
    if (depth > 3 || nodes >= 32) {
      dropped++;
      return { truncated: true };
    }
    if (seen.has(value)) return { reference: seen.get(value) };
    const id = nodes++;
    seen.set(value, id);
    const row = selectedError(value, observedPhases.get(value) ?? phase, id);
    if (value instanceof AggregateError) {
      row.children = value.errors.slice(0, 8).map((child) => visit(child, depth + 1));
      dropped += Math.max(0, value.errors.length - 8);
    }
    if (value && Object.hasOwn(value, 'cause')) row.cause = visit(value.cause, depth + 1);
    return row;
  };
  return { root: visit(error, 0), nodes, dropped };
}
export function qualificationDiagnostic(nonce) {
  let current = 'page-attach';
  const observedPhases = new Map();
  const report = {
    version: 1,
    nonce,
    state: 'running',
    phases: [],
    droppedPhases: 0,
    primary: null,
    failureDomain: null,
    cleanup: [],
    droppedCleanup: 0,
  };
  return {
    enter(phase) {
      if (!phases.has(phase)) throw new Error('qualification diagnostic phase invalid');
      current = phase;
      if (report.phases.length < 32) report.phases.push(phase);
      else report.droppedPhases++;
    },
    fail(error) {
      if (!observedPhases.has(error)) observedPhases.set(error, current);
      if (report.primary === null) {
        report.primary = projectQualificationError(error, current, observedPhases);
        report.failureDomain = cleanupPhases.has(report.primary.root.phase)
          ? 'cleanup'
          : 'qualification';
      }
    },
    cleanup(error, phase) {
      if (!cleanupPhases.has(phase))
        throw new Error('qualification diagnostic cleanup phase invalid');
      observedPhases.set(error, phase);
      if (report.cleanup.length < 8)
        report.cleanup.push(projectQualificationError(error, phase, observedPhases));
      else report.droppedCleanup++;
    },
    snapshot(error) {
      return {
        ...report,
        state: 'failed',
        error: projectQualificationError(error, current, observedPhases),
      };
    },
  };
}

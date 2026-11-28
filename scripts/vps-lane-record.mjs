// Shared record of the parent-side VPS lane: argument grammar, the run directory's summary.json,
// the pass criteria both `lane:vps` and `lane:vps:post` evaluate, and the Runtime evidence text.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fenceFailures } from './vps-lane-remote.mjs';

export const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const HOST = 'giap-vps';
const DIGEST = /^[a-f0-9]{64}$/;

/** A refusal or stop the lane reports as one line; it never carries secret values. */
export class LaneRefusal extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Runs a local command; a non-zero exit becomes a refusal, `what` or `<file> <verb> failed`. */
export function capture(file, args, { what, ...options } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '')
      .trim()
      .slice(-400);
    throw new LaneRefusal(`${what ?? `${file} ${args[0]} failed`}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

export function repositoryRoot() {
  return capture('git', ['rev-parse', '--show-toplevel'], {
    what: 'git repository root unavailable',
  }).trim();
}

export const runDirectory = (root, label) => join(root, '.run', 'vps-lane', label);

export function readSummary(directory) {
  return JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
}

export function writeSummary(directory, summary) {
  const file = join(directory, 'summary.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Describes what an existing run directory holds; any existing directory refuses the label. */
export function labelState(directory) {
  if (!existsSync(join(directory, 'summary.json'))) return 'unrecorded';
  try {
    const { state, pid } = readSummary(directory);
    if (state !== 'running') return String(state);
    process.kill(pid, 0);
    return 'live';
  } catch {
    return 'stale or unreadable';
  }
}

/**
 * Names of the failed pass criteria, recomputed from raw facts. A missing fact fails its
 * criterion, so a partial, stale or hand-edited summary can never read as a pass.
 */
export function laneFailures(summary) {
  const fence = summary?.fence ?? {};
  return [
    ...(summary?.state === 'completed' ? [] : ['lane-state']),
    ...custodyFailures(summary),
    ...(summary?.deploy?.exit === 0 ? [] : ['deploy-exit']),
    ...fenceFailures(fence.before, fence.after).map((field) => `fence-${field}`),
  ];
}

function custodyFailures(summary) {
  const custody = summary?.custody ?? {};
  const failures = [];
  if (custody.state !== 'passed') failures.push('custody-state');
  if (!SHA.test(summary?.head ?? '') || custody.head !== summary.head)
    failures.push('custody-head');
  if (custody.cleanup !== 'confirmed') failures.push('custody-cleanup');
  if (
    !DIGEST.test(custody.stdoutSha256 ?? '') ||
    custody.stdoutSha256 !== custody.statusStdoutSha256
  )
    failures.push('custody-stdout');
  return failures;
}

/** The final vitest counts in a log, ANSI colours removed; null when absent. */
export function vitestCounts(text) {
  // eslint-disable-next-line no-control-regex -- the ESC byte of ANSI colour sequences
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  const last = (pattern) => [...plain.matchAll(pattern)].at(-1)?.[1];
  const files = last(/Test Files\s+(\d+) passed/g);
  const tests = last(/^\s*Tests\s+(\d+) passed/gm);
  const duration = last(/Duration\s+([0-9.]+)s/g);
  if (!files || !tests || !duration) return null;
  return { files: Number(files), tests: Number(tests), duration };
}

const counts = (tests) =>
  tests
    ? `${tests.files} files and ${tests.tests} tests passed in ${tests.duration} s`
    : 'test counts unavailable';

/** Deterministic `## Runtime evidence` section of a passed summary: no clock, no host paths. */
export function runtimeEvidence(summary, note, eol) {
  const { custody, deploy, fence } = summary;
  const foreign = Object.keys(fence.before.foreignContainers).length;
  return [
    '## Runtime evidence',
    '',
    `- **Exact head:** \`${summary.head}\`.${note ? ` ${note}` : ''}`,
    `- **Trusted VPS** (${HOST}, linux/amd64, \`pnpm lane:vps\` label \`${summary.label}\`):`,
    `  - \`pnpm test:docker\`: custody invocation \`${custody.invocation}\`, state \`passed\`, cleanup \`confirmed\`. ${counts(custody.tests)}. Stdout sha256 \`${custody.stdoutSha256}\`.`,
    `  - \`pnpm test:deploy\`: exit 0. ${counts(deploy.tests)}.`,
    `  - **Host fence:** all ${fence.after.registeredTargets} registered targets absent, no owned leftovers, daemon PID and \`docker0\` unchanged, ${foreign} foreign containers unchanged.`,
    '',
    '',
  ].join(eol);
}

/** Human-readable companion of summary.json. */
export function summaryText(summary) {
  const { custody, deploy, fence } = summary;
  const failed = summary.failed ?? laneFailures(summary);
  return [
    `label ${summary.label} head ${summary.head} branch ${summary.branch}`,
    `state ${summary.state}${summary.failure ? ` (failed at ${summary.failure.step}: ${summary.failure.reason})` : ''}`,
    `steps ${(summary.steps ?? []).map((row) => `${row.step}=${String(row.exit)}`).join(' ') || 'none'}`,
    custody
      ? `custody ${custody.invocation} state ${custody.state} head ${String(custody.head)} cleanup ${String(custody.cleanup)} stdout sha256 ${String(custody.stdoutSha256)} (status ${String(custody.statusStdoutSha256)}); ${counts(custody.tests)}`
      : 'custody not started',
    deploy
      ? `test:deploy exit ${String(deploy.exit)}; ${counts(deploy.tests)}`
      : 'test:deploy not run',
    fence
      ? `fence registered targets ${String(fence.after?.registeredTargets)}, failed fields: ${fenceFailures(fence.before, fence.after).join(', ') || 'none'}`
      : 'fence not observed',
    `criteria failed: ${failed.join(', ') || 'none'}`,
    `verdict ${failed.length === 0 ? 'PASS' : 'NOT A PASS'}`,
    '',
  ].join('\n');
}

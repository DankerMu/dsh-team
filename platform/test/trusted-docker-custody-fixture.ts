import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { ownerPresent } from './case-budget-fixture.ts';
import { record } from './container-start-docker-fixture.ts';
import {
  awaitResult,
  GROUP_MEMBER_RECORD,
  withTrustedDockerFixture,
} from './trusted-docker-fixture.ts';

type CustodyFixture = Parameters<Parameters<typeof withTrustedDockerFixture>[1]>[0];

// Each held case's vitest bound (the file default set below; it.each cases pass it) and the start
// of its fixture deadline. Cases outside custodyCase state their own bound.
// Inner waits end RESERVE_MS before it: the reserve keeps the terminal evidence (one `status`) and
// cleanup (member, child group, owner and observer settles, each about two cold observations and
// a `ps`) outside the budget, so they never leave orphans. A settle's theoretical ceiling is about
// 22s; all of them at once is unrealistic and not budgeted. Measured (#687) with both budgets at
// 60s, 5 loaded full integration runs, 1-minute load 14-77 (runs 4 and 5 started at 64 and 74):
// case start to the callback's end at most 6312ms against the 15s fixture deadline, a 2.4x
// margin; cleanup at most 1433ms, mean 599ms, p95 1067ms (100 cases) against RESERVE_MS. #687
// recorded held cases cut at these values under load it did not record, so neither is lowered.
export const CASE_MS = 20_000;
const RESERVE_MS = 5000;

export function custodyCase(
  mode: Parameters<typeof withTrustedDockerFixture>[0],
  run: Parameters<typeof withTrustedDockerFixture>[1],
) {
  return withTrustedDockerFixture(mode, run, undefined, Date.now() + CASE_MS - RESERVE_MS);
}

// Assertion messages carry only sanitized terminal facts, never output, paths or credentials.
export function terminalEvidence(
  fixture: CustodyFixture,
  invocation: string,
  stderr: string,
): string {
  const queried = fixture.inspect(['status', invocation]);
  if (queried.status !== 0) return `${stderr}status exit ${String(queried.status)}`;
  const value = record(JSON.parse(queried.stdout) as unknown);
  const command = value.command === undefined ? undefined : record(value.command);
  const cleanup = value.cleanup === undefined ? undefined : record(value.cleanup);
  return `${stderr}${JSON.stringify({
    state: value.state,
    command: command && {
      exitCode: command.exitCode,
      signal: command.signal,
      settled: command.settled,
    },
    interruption: value.interruption,
    failure: value.failure,
    cleanup: cleanup?.state,
  })}`;
}

// Loaded #324 maxima: leaf readiness 1799ms after start() returns and sentinel readiness 183ms;
// fixture-begin follows the leaf within 82ms and shares its deadline. Both fit CASE_MS. #687's
// loaded runs (load 14-77) measured leaf readiness at most 1032ms: LEAF_READINESS_MS never binds.
export const LEAF_READINESS_MS = 5000;
export const SENTINEL_READINESS_MS = 2000;

type ReadinessCause = 'terminal-published' | 'owner-absent' | 'sentinel-exited';

// Readiness is checked before each fail-fast condition; failures start with a fixed cause token.
export async function awaitReadiness<T>(
  deadline: number,
  ready: () => T | undefined,
  ended: () => ReadinessCause | undefined,
  evidence: (cause: string) => string = (cause) => cause,
): Promise<T> {
  for (;;) {
    const value = ready();
    if (value !== undefined) return value;
    const cause = ended() ?? (Date.now() >= deadline ? 'readiness-deadline' : undefined);
    if (cause !== undefined) throw new Error(evidence(cause));
    await delay(50);
  }
}

// The leaf publishes atomically; only a complete birth identity counts as ready.
function leafRecord(temporary: string) {
  const path = join(temporary, 'child-ready.json');
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { pid, birth } = value as Record<string, unknown>;
  return typeof pid === 'number' && typeof birth === 'string' ? { pid, birth } : undefined;
}

// Call immediately after the start returns: its leaf deadline is measured from there.
export function issuedInvocation(
  fixture: CustodyFixture,
  started: { status: number | null; stdout: string; stderr: string },
) {
  const deadline = Math.min(Date.now() + LEAF_READINESS_MS, fixture.deadline);
  expect(started.status, started.stderr).toBe(0);
  const invocation = record(JSON.parse(started.stdout) as unknown).invocation;
  if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
  const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
  const manifestPath = join(directory, 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  const manifest = record(JSON.parse(original) as unknown);
  const temporary = manifest.temporary;
  const { pid, birth } = record(manifest.owner);
  if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
  if (typeof pid !== 'number' || typeof birth !== 'string')
    throw new Error('Missing owner identity');
  const ended = (): ReadinessCause | undefined => {
    if (existsSync(join(directory, 'result.json'))) return 'terminal-published';
    return ownerPresent(pid) ? undefined : 'owner-absent';
  };
  const awaitIssued = <T>(ready: () => T | undefined) =>
    awaitReadiness(deadline, ready, ended, (cause) =>
      terminalEvidence(fixture, invocation, `${cause} `),
    );
  const stdout = join(directory, 'stdout.log');
  return {
    fixture,
    invocation,
    owner: { pid, birth },
    directory,
    manifestPath,
    original,
    manifest,
    temporary,
    leafReady: () => awaitIssued(() => leafRecord(temporary)),
    outputBegun: () =>
      awaitIssued(() =>
        existsSync(stdout) && readFileSync(stdout, 'utf8').includes('fixture-begin\n')
          ? true
          : undefined,
      ),
  };
}

type Issued = ReturnType<typeof issuedInvocation>;

function leafState(temporary: string) {
  const leaf = leafRecord(temporary);
  if (leaf === undefined) return 'unpublished';
  return ownerPresent(leaf.pid) ? 'alive' : 'absent';
}

// The post-close member's own exit timing, against the product's 2000ms settlement window.
export function memberExit(temporary: string) {
  try {
    const path = join(temporary, 'member-exit.json');
    const { vanished, exited } = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return typeof vanished === 'number' && typeof exited === 'number'
      ? exited - vanished
      : undefined;
  } catch {
    return undefined;
  }
}

// Never masks the failure it annotates: an unreadable record only adds a note.
export function memberTiming(temporary: string) {
  if (!existsSync(join(temporary, 'member-exit.json'))) return '';
  const elapsed = memberExit(temporary);
  return elapsed === undefined
    ? '; member timing unavailable'
    : `; member exited ${String(elapsed)}ms after the command vanished; settlement window 2000ms`;
}

export function liveMember(fixture: CustodyFixture, temporary: string) {
  const path = join(temporary, GROUP_MEMBER_RECORD);
  const member = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (typeof member.pid !== 'number') throw new Error('Missing owned group member identity');
  expect(fixture.observeProcess(member.pid)).toBe(member.birth);
  return member.pid;
}

// The former 10s status poll bound; a published terminal never changes, so a mismatch fails at once.
export const TERMINAL_WAIT_MS = 10_000;

export async function awaitTerminal(issued: Issued, expected: Record<string, unknown>) {
  const { fixture, invocation, directory, owner, temporary } = issued;
  const scene = () => `; phase=terminal; leaf=${leafState(temporary)}`;
  const deadline = Math.min(Date.now() + TERMINAL_WAIT_MS, fixture.deadline);
  await awaitResult(directory, owner, deadline, fixture.observeProcess, scene, 50);
  const result = fixture.command(['status', invocation]);
  try {
    expect(result.status, result.stderr).toBe(0);
    const terminal = JSON.parse(result.stdout) as unknown;
    expect(terminal).toMatchObject(expected);
    return terminal;
  } catch (error) {
    const evidence = terminalEvidence(fixture, invocation, 'terminal-mismatch ');
    throw new Error(evidence + memberTiming(temporary), { cause: error });
  }
}

// Both held member modes register their member before readiness; it must be alive at cancel.
export async function cancelHeldCommand(
  fixture: CustodyFixture,
  expected: Record<string, unknown>,
) {
  const issued = issuedInvocation(fixture, await fixture.start());
  const { invocation, temporary } = issued;
  await issued.leafReady();
  liveMember(fixture, temporary);
  const cancelled = fixture.command(['cancel', invocation], true);
  expect(cancelled.status, cancelled.stderr).toBe(0);
  expect(JSON.parse(cancelled.stdout) as unknown).toMatchObject({
    invocation,
    state: 'cancellation-requested',
  });
  const terminal = await awaitTerminal(issued, {
    invocation,
    interruption: 'cancelled',
    failure: null,
    output: { complete: true },
    ...expected,
  });
  expect(readFileSync(join(temporary, 'child-interrupted'), 'utf8')).toBe('SIGINT');
  return { invocation, temporary, terminal };
}

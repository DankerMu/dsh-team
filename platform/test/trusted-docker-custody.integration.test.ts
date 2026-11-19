import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import {
  awaitResult,
  caseBudget,
  CLOSE_MEMBER_DELAY_MS,
  CUSTODY_PROXY,
  GROUP_MEMBER_RECORD,
  ownerPresent,
  withTrustedDockerFixture,
} from './trusted-docker-fixture.ts';
import {
  groupIsAbsent,
  hasPassingOutcome,
  validateTerminal,
} from '../../scripts/trusted-docker-record.mjs';
import { browserExecRetirementSummary } from '../../scripts/verification-submission-assessment.mjs';

type CustodyFixture = Parameters<Parameters<typeof withTrustedDockerFixture>[1]>[0];

// Each held case's literal 20_000 vitest bound. Inner waits end RESERVE_MS before it: the reserve keeps the
// terminal evidence (one `status`) and cleanup (member, child group, owner and observer settles,
// each about two cold observations and a `ps`) outside the budget, so they never leave orphans.
// Measured green cleanup: at most 672ms, mean 286ms (23 cases, load 7). A settle's theoretical
// ceiling is about 22s; all of them at once is unrealistic and not budgeted.
const CASE_MS = 20_000;
const RESERVE_MS = 5000;

function custodyCase(
  mode: Parameters<typeof withTrustedDockerFixture>[0],
  run: Parameters<typeof withTrustedDockerFixture>[1],
) {
  return withTrustedDockerFixture(mode, run, undefined, Date.now() + CASE_MS - RESERVE_MS);
}

// Assertion messages carry only sanitized terminal facts, never output, paths or credentials.
function terminalEvidence(fixture: CustodyFixture, invocation: string, stderr: string): string {
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
// fixture-begin follows the leaf within 82ms and shares its deadline. Both fit the 20s test bound.
const LEAF_READINESS_MS = 5000;
const SENTINEL_READINESS_MS = 2000;

type ReadinessCause = 'terminal-published' | 'owner-absent' | 'sentinel-exited';

// Readiness is checked before each fail-fast condition; failures start with a fixed cause token.
async function awaitReadiness<T>(
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
function issuedInvocation(
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
function memberExit(temporary: string) {
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
function memberTiming(temporary: string) {
  if (!existsSync(join(temporary, 'member-exit.json'))) return '';
  const elapsed = memberExit(temporary);
  return elapsed === undefined
    ? '; member timing unavailable'
    : `; member exited ${String(elapsed)}ms after the command vanished; settlement window 2000ms`;
}

function liveMember(fixture: CustodyFixture, temporary: string) {
  const path = join(temporary, GROUP_MEMBER_RECORD);
  const member = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (typeof member.pid !== 'number') throw new Error('Missing owned group member identity');
  expect(fixture.observeProcess(member.pid)).toBe(member.birth);
  return member.pid;
}

// The former 10s status poll bound; a published terminal never changes, so a mismatch fails at once.
const TERMINAL_WAIT_MS = 10_000;

async function awaitTerminal(issued: Issued, expected: Record<string, unknown>) {
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
async function cancelHeldCommand(fixture: CustodyFixture, expected: Record<string, unknown>) {
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

it('publishes reviewed launch authority before work and preserves a real nonzero command result', async () => {
  await custodyCase('fail', async (fixture) => {
    const started = await fixture.start({ DOCKER_HOST: '', DOCKER_CONTEXT: '' });

    expect(started.status, started.stderr).toBe(0);
    const issued = issuedInvocation(fixture, started);
    const { invocation, directory } = issued;
    expect(invocation).toEqual(expect.any(String));
    const manifestPath = join(directory, 'manifest.json');
    const manifestValue: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifestValue).toMatchObject({
      invocation,
      head: fixture.head,
      root: fixture.repository,
      command: ['pnpm', 'test:docker'],
    });
    const owner = record(record(manifestValue).owner);
    expect(owner.pid).toEqual(expect.any(Number));
    expect(owner.birth).toEqual(expect.any(String));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    await awaitTerminal(issued, {
      invocation,
      head: fixture.head,
      state: 'failed',
      command: { exitCode: 17, signal: null, settled: true },
      output: { complete: true },
      cleanup: { state: 'confirmed', browserExec: null },
    });
    const stdout = fixture.command(['logs', invocation, 'stdout']);
    const stderr = fixture.command(['logs', invocation, 'stderr']);
    expect(stdout.status).toBe(0);
    expect(stderr.status).toBe(0);
    expect(stdout.stdout).toContain('fixture-begin\nfixture-end\n');
    expect(stderr.stdout).toContain('fixture-error\n');
    expect(stdout.stdout).toContain(`fixture-end\n${'[REDACTED]\n'.repeat(6)}`);
    expect(stderr.stdout).toContain('fixture-error\n[REDACTED]\n');
    for (const output of [
      stdout.stdout,
      stderr.stdout,
      readFileSync(join(directory, 'result.json'), 'utf8'),
    ]) {
      expect(output).not.toContain('fixture-gh-custody-canary');
      expect(output).not.toContain('fixture-model-custody-canary');
      expect(output).not.toContain('fixture-ssh-custody-canary');
      expect(output).not.toContain(CUSTODY_PROXY);
      expect(output).not.toContain('fixture-proxy-');
      expect(output).not.toContain('fixture%2Dproxy');
    }
    const resultPath = join(directory, 'result.json');
    const original = readFileSync(resultPath, 'utf8');
    const terminal = record(JSON.parse(original));
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const summary = {
      operationOutcome: 'unknown',
      executionCapability: 'retired',
      submissions: 2,
      sha256: createHash('sha256')
        .update(JSON.stringify([firstId, secondId]))
        .digest('hex'),
    };
    expect(browserExecRetirementSummary([secondId, firstId, secondId])).toEqual(summary);
    const qualified = { ...terminal, cleanup: { state: 'confirmed', browserExec: summary } };
    expect(validateTerminal(qualified, invocation, terminal.manifestDigest)).toBe(qualified);
    try {
      writeFileSync(resultPath, JSON.stringify(qualified), { mode: 0o600 });
      const queried = fixture.command(['status', invocation]);
      expect(queried.status, queried.stderr).toBe(0);
      expect(JSON.parse(queried.stdout)).toMatchObject({
        state: 'failed',
        command: { exitCode: 17, signal: null, settled: true },
        cleanup: { state: 'confirmed', browserExec: summary },
      });
    } finally {
      writeFileSync(resultPath, original, { mode: 0o600 });
    }
    for (const cleanup of [
      { state: 'confirmed' },
      { state: 'unconfirmed', browserExec: summary },
      { state: 'not-started', browserExec: summary },
      { state: 'confirmed', browserExec: { ...summary, submissions: 0 } },
      { state: 'confirmed', browserExec: { ...summary, submissions: Number.MAX_SAFE_INTEGER + 1 } },
      { state: 'confirmed', browserExec: { ...summary, sha256: 'malformed' } },
      { state: 'confirmed', browserExec: { ...summary, operationOutcome: 'settled' } },
      { state: 'confirmed', browserExec: { ...summary, executionCapability: 'active' } },
      { state: 'confirmed', browserExec: { ...summary, submissionIds: [firstId, secondId] } },
    ]) {
      expect(() => {
        validateTerminal({ ...terminal, cleanup }, invocation, terminal.manifestDigest);
      }).toThrow();
    }
    // (a) Terminals without the projection parse exactly as before.
    for (const state of ['confirmed', 'unconfirmed']) {
      const legacy = { ...terminal, cleanup: { state, browserExec: null } };
      expect(validateTerminal(legacy, invocation, terminal.manifestDigest)).toBe(legacy);
    }
    // (b) An unconfirmed terminal carries the bounded unsettled-submission projection verbatim.
    const unsettled = {
      labels: [
        {
          transport: 'cli',
          operation: 'network create',
          caller: 'deployment.docker.test.ts',
          count: 2,
        },
        {
          transport: 'http',
          operation: 'POST /containers/{id}/start',
          caller: 'unknown',
          count: 1,
        },
      ],
      unlabelled: 1,
      truncated: false,
    };
    const projected = {
      ...terminal,
      cleanup: { state: 'unconfirmed', browserExec: null, unsettled },
    };
    expect(validateTerminal(projected, invocation, terminal.manifestDigest)).toBe(projected);
    const distinct = Array.from({ length: 33 }, (_, index) => ({
      transport: 'cli',
      operation: 'rm',
      caller: `case-${String(index)}.test.ts`,
      count: 1,
    }));
    const bounded = {
      ...terminal,
      cleanup: {
        state: 'unconfirmed',
        browserExec: null,
        unsettled: { labels: distinct.slice(0, 32), unlabelled: 0, truncated: true },
      },
    };
    expect(validateTerminal(bounded, invocation, terminal.manifestDigest)).toBe(bounded);
    const [cliLabel, httpLabel] = unsettled.labels;
    // (c) Only an unconfirmed assessment may carry the projection; (d) every malformed shape fails.
    for (const cleanup of [
      { state: 'confirmed', browserExec: null, unsettled },
      { state: 'not-started', browserExec: null, unsettled },
      ...[
        { ...unsettled, extra: 0 },
        { labels: unsettled.labels, unlabelled: 1 },
        { ...unsettled, labels: {} },
        { ...unsettled, labels: null },
        null,
        { ...unsettled, labels: distinct },
        { ...unsettled, labels: [cliLabel, { ...cliLabel, count: 5 }] },
        { ...unsettled, labels: [{ ...cliLabel, id: 'fixture' }] },
        { ...unsettled, labels: [{ ...cliLabel, count: 0 }] },
        { ...unsettled, labels: [{ ...cliLabel, count: -1 }] },
        { ...unsettled, labels: [{ ...cliLabel, count: 1.5 }] },
        { ...unsettled, unlabelled: -1 },
        { ...unsettled, truncated: 'false' },
        { ...unsettled, truncated: true },
        { ...unsettled, labels: [{ ...httpLabel, operation: 'POST /containers/{id}/exec/start' }] },
        {
          ...unsettled,
          labels: [{ ...cliLabel, caller: 'platform/test/deployment.docker.test.ts' }],
        },
        { ...unsettled, labels: [{ ...cliLabel, transport: 'grpc' }] },
        { labels: [], unlabelled: 0, truncated: false },
      ].map((shape) => ({ state: 'unconfirmed', browserExec: null, unsettled: shape })),
    ]) {
      expect(() => {
        validateTerminal({ ...terminal, cleanup }, invocation, terminal.manifestDigest);
      }).toThrow(new Error('Invalid trusted Docker unsettled projection'));
      const { state, browserExec } = cleanup;
      const stripped = { ...terminal, cleanup: { state, browserExec } };
      expect(validateTerminal(stripped, invocation, terminal.manifestDigest)).toBe(stripped);
    }
    // (e) The projection never makes an unconfirmed terminal passing.
    const unconfirmedPass = {
      ...projected,
      command: { exitCode: 0, signal: null, settled: true },
      interruption: 'none',
      failure: null,
    };
    expect(hasPassingOutcome(unconfirmedPass)).toBe(false);
    expect(hasPassingOutcome({ ...unconfirmedPass, cleanup: { state: 'confirmed' } })).toBe(true);
    expect(() => {
      validateTerminal(
        { ...unconfirmedPass, state: 'passed' },
        invocation,
        terminal.manifestDigest,
      );
    }).toThrow(new Error('Inconsistent trusted Docker terminal outcome'));
  });
}, 20_000);

it('rejects a different reviewed revision before creating custody or starting work', async () => {
  await withTrustedDockerFixture('fail', (fixture) => {
    const result = fixture.command(['start', '0'.repeat(40)], true);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(existsSync(join(fixture.home, '.local/share/dsh-team/docker-verification'))).toBe(false);
  });
});

it.each(['DOCKER_HOST', 'DOCKER_CONTEXT'])(
  'rejects nonempty %s before creating custody or launching verification',
  async (name) => {
    await withTrustedDockerFixture('fail', async (fixture) => {
      const rejected = await fixture.start({ [name]: 'fixture-forbidden-daemon-selection' });

      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).not.toContain('fixture-forbidden-daemon-selection');
      expect(existsSync(join(fixture.home, '.local/share/dsh-team/docker-verification'))).toBe(
        false,
      );
    });
  },
);

it.each(['owner-birth', 'obsolete-birth', 'record-permissions', 'malformed-record'] as const)(
  'refuses changed %s without interrupting owned live work',
  async (fault) => {
    await custodyCase('hold', async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      const { invocation, directory, manifestPath, original, manifest, temporary } = issued;
      const ready = await issued.leafReady();
      try {
        if (fault === 'record-permissions') chmodSync(manifestPath, 0o644);
        else if (fault === 'malformed-record') writeFileSync(manifestPath, '{not-valid-json');
        else {
          const owner = record(manifest.owner);
          const birth =
            fault === 'obsolete-birth'
              ? `darwin:${String(owner.pid)}:${'0'.repeat(64)}`
              : String(owner.birth).startsWith('linux:')
                ? `linux:${String(owner.pid)}:0`
                : `darwin:${String(owner.pid)}:1:0`;
          writeFileSync(manifestPath, JSON.stringify({ ...manifest, owner: { ...owner, birth } }));
        }

        const rejected = fixture.command(['cancel', invocation]);

        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toBe('');
        expect(existsSync(join(directory, 'cancel.json'))).toBe(false);
        expect(existsSync(join(temporary, 'child-interrupted'))).toBe(false);
        expect(fixture.observeProcess(ready.pid)).toBe(ready.birth);
      } finally {
        writeFileSync(manifestPath, original, { mode: 0o600 });
        chmodSync(manifestPath, 0o600);
      }
      writeFileSync(join(temporary, 'release'), 'release');
      await awaitTerminal(issued, {
        state: 'failed',
        command: { exitCode: 17, settled: true },
        interruption: 'none',
      });
    });
  },
  20_000,
);

it('survives loss of the launching observer group and reconnects to the same real failed invocation', async () => {
  await custodyCase('hold', async (fixture) => {
    const sentinel = await fixture.startSentinel();
    await awaitReadiness(
      Math.min(Date.now() + SENTINEL_READINESS_MS, fixture.deadline),
      () => (existsSync(sentinel.ready) ? true : undefined),
      () =>
        fixture.observeProcess(sentinel.identity.pid) === sentinel.identity.birth
          ? undefined
          : 'sentinel-exited',
    );
    const observation = await fixture.startObserved();
    const issued = issuedInvocation(fixture, observation.started);
    const { invocation, temporary } = issued;
    const owner = record(record(JSON.parse(observation.started.stdout) as unknown).owner);
    if (typeof owner.pid !== 'number') throw new Error('Missing owner identity');
    const ready = await issued.leafReady();
    await issued.outputBegun();

    await observation.disconnect();

    expect(fixture.observeProcess(observation.identity.pid)).toBeNull();
    expect(fixture.observeProcess(owner.pid)).toBe(owner.birth);
    expect(fixture.observeProcess(ready.pid)).toBe(ready.birth);
    expect(fixture.observeProcess(sentinel.identity.pid)).toBe(sentinel.identity.birth);
    expect(existsSync(sentinel.interrupted)).toBe(false);
    const reconnected = fixture.command(['status', invocation], true);
    expect(reconnected.status, reconnected.stderr).toBe(0);
    const current: unknown = JSON.parse(reconnected.stdout);
    expect(current).toMatchObject({ invocation, head: fixture.head, state: 'running' });
    writeFileSync(join(temporary, 'release'), 'release');
    await awaitTerminal(issued, {
      invocation,
      state: 'failed',
      command: { exitCode: 17, settled: true },
      interruption: 'none',
      output: { complete: true },
      cleanup: { state: 'confirmed', browserExec: null },
    });
    const log = fixture.command(['logs', invocation, 'stdout'], true);
    expect(log.status, log.stderr).toBe(0);
    expect(log.stdout).toContain('fixture-begin\nfixture-end\n');
    expect(fixture.observeProcess(sentinel.identity.pid)).toBe(sentinel.identity.birth);
  });
}, 20_000);

it('reports lost owner authority as unknown while its child is live and refuses cancellation or takeover', async () => {
  await custodyCase('hold', async (fixture) => {
    const issued = issuedInvocation(fixture, await fixture.start());
    const { invocation, directory } = issued;
    const ready = await issued.leafReady();
    await issued.outputBegun();

    await fixture.killOwner(invocation);

    const result = fixture.command(['status', invocation], true);
    expect(result.status, result.stderr).toBe(0);
    const status: unknown = JSON.parse(result.stdout);
    expect(status).toMatchObject({ invocation, state: 'unknown' });
    expect(fixture.command(['cancel', invocation]).status).toBe(1);
    expect(fixture.command(['own', invocation]).status).toBe(1);
    expect(existsSync(join(directory, 'result.json'))).toBe(false);
    expect(existsSync(join(directory, 'cancel.json'))).toBe(false);
    expect(fixture.observeProcess(ready.pid)).toBe(ready.birth);
  });
}, 20_000);

it('fails a readiness wait at once with its cause when the leaf exits before readiness', async () => {
  await custodyCase('early-exit', async (fixture) => {
    const started = await fixture.start();
    const since = Date.now();
    const issued = issuedInvocation(fixture, started);
    const { invocation, leafReady } = issued;

    const waited = leafReady();

    await expect(waited).rejects.toThrow(/^(terminal-published|owner-absent) /);
    expect(Date.now() - since).toBeLessThan(LEAF_READINESS_MS);
    await awaitTerminal(issued, {
      invocation,
      state: 'failed',
      command: { exitCode: 23, signal: null, settled: true },
      interruption: 'none',
      cleanup: { state: 'confirmed' },
    });
  });
}, 20_000);

it.each([
  ['initial check', 'release-early'],
  ['50ms recheck', 'release-blind'],
] as const)(
  'completes a held command whose release only the leaf watch %s sees',
  async (_, mode) => {
    await custodyCase(mode, async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      await issued.leafReady();
      if (mode === 'release-blind') writeFileSync(join(issued.temporary, 'release'), 'release');

      await awaitTerminal(issued, {
        state: 'failed',
        command: { exitCode: 17, settled: true },
        interruption: 'none',
      });
    });
  },
  20_000,
);

it('fails a terminal wait at once with its evidence when the published terminal differs', async () => {
  await custodyCase('early-exit', async (fixture) => {
    const issued = issuedInvocation(fixture, await fixture.start());
    const since = Date.now();

    const waited = awaitTerminal(issued, { command: { exitCode: 17 } });

    await expect(waited).rejects.toThrow(/^terminal-mismatch .*"exitCode":23/);
    expect(Date.now() - since).toBeLessThan(TERMINAL_WAIT_MS);
  });
}, 20_000);

it('fails a terminal wait at once when the owner exits without publishing a terminal', async () => {
  await custodyCase('hold', async (fixture) => {
    const issued = issuedInvocation(fixture, await fixture.start());
    await issued.leafReady();
    await fixture.killOwner(issued.invocation);
    const since = Date.now();

    const waited = awaitTerminal(issued, { state: 'failed' });

    await expect(waited).rejects.toThrow(
      /owner exited without publishing result\.json[\s\S]*phase=terminal; leaf=alive/,
    );
    expect(Date.now() - since).toBeLessThan(TERMINAL_WAIT_MS);
  });
}, 20_000);

it('kills a fixture spawn cut to the case deadline and refuses one after it, naming the phase', () => {
  const budget = caseBudget(Date.now() + 200);
  const sleep = () =>
    budget.run('fixture sleep', process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
      encoding: 'utf8',
      timeout: 5000,
    });

  expect(sleep).toThrow(/^fixture sleep: killed at the case deadline after \d+ms$/);
  expect(sleep).toThrow(/^fixture sleep: case deadline passed before it started$/);
});

// Setup fits well inside 8s, so the held terminal wait starts with less than its own 10s cap left.
const SPENT_CASE_MS = 8000;

it('ends a held terminal wait at the case deadline with its attribution and still cleans up', async () => {
  await withTrustedDockerFixture(
    'hold',
    async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      await issued.leafReady();
      const since = Date.now();
      const left = fixture.deadline - since;

      await expect(awaitTerminal(issued, { state: 'failed' })).rejects.toThrow(
        /^Trusted Docker owner still running without result\.json after \d+ms: pid=\d+; phase=terminal; leaf=alive$/,
      );
      expect(Date.now() - since).toBeLessThan(left + 1000);
      expect(() => fixture.command(['status', issued.invocation])).toThrow(
        /^command status: case deadline passed before it started$/,
      );
      expect(fixture.inspect(['status', issued.invocation]).status).toBe(0);
    },
    undefined,
    Date.now() + SPENT_CASE_MS,
  );
}, 20_000);

const ownerOf = (path: string) =>
  Number(record(record(JSON.parse(readFileSync(path, 'utf8')) as unknown).owner).pid);

// The command wait below starts about 2.5s into its case and ends near 12.5s, below the 20_000
// case bound. It cannot derive from fixture.deadline: that deadline has passed before it starts.
const COMMAND_LAUNCH_MS = 10_000;

// The slow owner sleeps 4s before its manifest; its start gets 2.5s of the 5s case deadline, so
// the start is killed with the owner up, and the owner then launches the held command.
it('settles the owner and held command of a start killed at the case deadline', async () => {
  const pids = { directory: '', owner: 0, command: 0 };
  try {
    const failed = await withTrustedDockerFixture(
      'slow-owner',
      async (fixture) => {
        pids.directory = fixture.directory;
        await delay(Math.max(0, fixture.deadline - Date.now() - 2500));
        expect(() => fixture.start()).toThrow(/^command start: killed at the case deadline after/);
        const base = join(fixture.home, '.local/share/dsh-team/docker-verification');
        const root = join(base, readdirSync(base)[0] ?? 'missing');
        pids.owner = ownerOf(join(root, 'launch.json'));
        for (const until = Date.now() + COMMAND_LAUNCH_MS; !existsSync(join(root, 'child.json'));) {
          if (Date.now() >= until) throw new Error('Slow owner launched no command');
          await delay(50);
        }
        pids.command = ownerOf(join(root, 'child.json'));
      },
      undefined,
      Date.now() + 5000,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).errors.map(String)).toEqual([
      'Error: Uncaptured custody fixture authority retained',
    ]);
    expect(ownerPresent(pids.owner)).toBe(false);
    expect(groupIsAbsent(pids.command)).toBe(true);
  } finally {
    for (const pid of [pids.owner, -pids.command].filter(Boolean))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already settled by the fixture: the green outcome.
      }
    rmSync(pids.directory, { recursive: true, force: true });
  }
}, 20_000);

it('cancels the actual pnpm child tree and preserves the terminal result on late cancellation', async () => {
  await custodyCase('hold', async (fixture) => {
    const sentinel = await fixture.startSentinel();
    const issued = issuedInvocation(fixture, await fixture.start());
    const { invocation, temporary } = issued;
    const leaf = await issued.leafReady();
    expect(fixture.observeProcess(leaf.pid)).toBe(leaf.birth);

    const cancelled = fixture.command(['cancel', invocation], true);
    expect(cancelled.status, cancelled.stderr).toBe(0);
    expect(JSON.parse(cancelled.stdout) as unknown).toMatchObject({
      invocation,
      state: 'cancellation-requested',
    });
    const duplicate = fixture.command(['cancel', invocation]);
    expect(duplicate.status, terminalEvidence(fixture, invocation, duplicate.stderr)).toBe(0);
    const terminal = await awaitTerminal(issued, {
      invocation,
      state: 'failed',
      command: { settled: true },
      interruption: 'cancelled',
      output: { complete: true },
      cleanup: { state: 'confirmed', browserExec: null },
    });

    expect(readFileSync(join(temporary, 'child-interrupted'), 'utf8')).toBe('SIGINT');
    expect(fixture.observeProcess(leaf.pid)).toBeNull();
    const outcome = record(record(terminal).command);
    expect(outcome.exitCode === 0 && outcome.signal === null).toBe(false);
    const late = fixture.command(['cancel', invocation], true);
    expect(late.status, terminalEvidence(fixture, invocation, late.stderr)).toBe(0);
    expect(JSON.parse(late.stdout) as unknown).toEqual(terminal);
    expect(fixture.observeProcess(sentinel.identity.pid)).toBe(sentinel.identity.birth);
    expect(existsSync(sentinel.interrupted)).toBe(false);
  });
}, 20_000);

it('settles a cancelled command whose same-group member exits shortly after close', async () => {
  await custodyCase('post-close-member', async (fixture) => {
    const { invocation, temporary, terminal } = await cancelHeldCommand(fixture, {
      state: 'failed',
      command: { settled: true },
      cleanup: { state: 'confirmed', browserExec: null },
    });
    expect(memberTiming(temporary)).toMatch(
      /^; member exited \d+ms after the command vanished; settlement window 2000ms$/,
    );
    expect(memberExit(temporary)).toBeGreaterThanOrEqual(CLOSE_MEMBER_DELAY_MS);

    const duplicate = fixture.command(['cancel', invocation], true);
    expect(duplicate.status, terminalEvidence(fixture, invocation, duplicate.stderr)).toBe(0);
    expect(JSON.parse(duplicate.stdout) as unknown).toEqual(terminal);
  });
}, 20_000);

// Killing the leaf skips its SIGINT handler, so the member is never told to exit and outlives the
// command; only its registration lets cleanup retire it.
it('retires a pre-started post-close member that was never told to exit', async () => {
  let member = 0;
  try {
    await custodyCase('post-close-member', async (fixture) => {
      const issued = issuedInvocation(fixture, await fixture.start());
      const leaf = await issued.leafReady();
      member = liveMember(fixture, issued.temporary);
      process.kill(leaf.pid, 'SIGKILL');

      await awaitTerminal(issued, { state: 'unknown', command: { settled: false } });
    });

    expect(ownerPresent(member)).toBe(false);
  } finally {
    if (member && ownerPresent(member)) process.kill(member, 'SIGKILL');
  }
}, 20_000);

it('keeps a cancelled command unsettled while a same-group member outlives the observation window', async () => {
  await custodyCase('past-expiry-member', async (fixture) => {
    const { invocation, temporary, terminal } = await cancelHeldCommand(fixture, {
      state: 'unknown',
      command: { settled: false },
      cleanup: { state: 'unconfirmed', browserExec: null },
    });
    // The cancelled pnpm genuinely either relays the leaf handler's exit27 (Darwin) or
    // re-raises its own group SIGINT and dies by that signal (Linux); nothing else is accepted.
    const outcome = record(record(terminal).command);
    expect([
      { exitCode: 27, signal: null },
      { exitCode: null, signal: 'SIGINT' },
    ]).toContainEqual({ exitCode: outcome.exitCode, signal: outcome.signal });

    const member = record(
      JSON.parse(readFileSync(join(temporary, GROUP_MEMBER_RECORD), 'utf8')) as unknown,
    );
    if (typeof member.pid !== 'number') throw new Error('Missing owned group member identity');
    expect(fixture.observeProcess(member.pid)).toBe(member.birth);
    const late = fixture.command(['cancel', invocation]);
    expect(late.status, terminalEvidence(fixture, invocation, late.stderr)).toBe(1);
    expect(late.stdout).toBe('');
  });
}, 20_000);

it('retains a nonpassing result and refuses partial logs after actual output storage failure', async () => {
  await custodyCase('output-failed', async (fixture) => {
    const started = await fixture.start();
    expect(started.status, started.stderr).toBe(0);
    const issued = issuedInvocation(fixture, started);
    const { invocation, directory } = issued;

    await awaitTerminal(issued, {
      state: 'failed',
      command: { settled: true },
      interruption: 'capture-failed',
      output: { complete: false, stdout: null },
      cleanup: { state: 'confirmed', browserExec: null },
    });

    expect(statSync(join(directory, 'stdout.log')).size).toBeLessThanOrEqual(4096);
    const logs = fixture.command(['logs', invocation, 'stdout']);
    expect(logs.status).toBe(1);
    expect(logs.stdout).toBe('');
  });
}, 20_000);

// An unsettled group observation preserves the original exit with an identity failure.
const groupIdentityFailure = {
  expected: {
    state: 'unknown',
    command: { exitCode: 17, signal: null, settled: false },
    failure: 'identity',
    cleanup: { state: 'unconfirmed', browserExec: null },
  },
  cancelStatus: 1,
} as const;

it.each([
  {
    title: 'persists the original command outcome when process-group observation is denied',
    mode: 'group-observation-failed',
    ...groupIdentityFailure,
  },
  {
    title: 'records an identity failure at once for a non-EPERM group observation error',
    mode: 'group-observation-invalid',
    ...groupIdentityFailure,
  },
  {
    title: 'settles the original command outcome after transiently denied group observations',
    mode: 'group-observation-transient',
    expected: {
      state: 'failed',
      command: { exitCode: 17, signal: null, settled: true },
      failure: null,
      cleanup: { state: 'confirmed', browserExec: null },
    },
    cancelStatus: 0,
  },
] as const)(
  '$title',
  async ({ mode, expected, cancelStatus }) => {
    await custodyCase(mode, async (fixture) => {
      const started = await fixture.start();
      expect(started.status, started.stderr).toBe(0);
      const issued = issuedInvocation(fixture, started);
      const { invocation } = issued;

      await awaitTerminal(issued, { ...expected, output: { complete: true } });
      const cancelled = fixture.command(['cancel', invocation]);
      expect(cancelled.status, terminalEvidence(fixture, invocation, cancelled.stderr)).toBe(
        cancelStatus,
      );
    });
  },
  20_000,
);

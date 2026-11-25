import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ownerPresent } from './case-budget-fixture.ts';
import { record } from './container-start-docker-fixture.ts';
import {
  awaitReadiness,
  awaitTerminal,
  CASE_MS,
  cancelHeldCommand,
  custodyCase,
  issuedInvocation,
  liveMember,
  memberExit,
  memberTiming,
  SENTINEL_READINESS_MS,
  terminalEvidence,
} from './trusted-docker-custody-fixture.ts';
import {
  CLOSE_MEMBER_DELAY_MS,
  CUSTODY_PROXY,
  GROUP_MEMBER_RECORD,
  withTrustedDockerFixture,
} from './trusted-docker-fixture.ts';
import { expectMemberOutlivedClose } from './trusted-docker-close-fixture.ts';
import { hasPassingOutcome, validateTerminal } from '../../scripts/trusted-docker-record.mjs';
import { browserExecRetirementSummary } from '../../scripts/verification-submission-assessment.mjs';

// The custody case bound (see CASE_MS); cases that state no bound of their own get it.
vi.setConfig({ testTimeout: CASE_MS });

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
});

it('rejects a different reviewed revision before creating custody or starting work', async () => {
  await withTrustedDockerFixture('fail', (fixture) => {
    const result = fixture.command(['start', '0'.repeat(40)], true);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(existsSync(join(fixture.home, '.local/share/dsh-team/docker-verification'))).toBe(false);
  });
}, 5000);

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
  5000,
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
  CASE_MS,
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
});

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
});

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
});

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
    expectMemberOutlivedClose(fixture.repository, temporary);

    const duplicate = fixture.command(['cancel', invocation], true);
    expect(duplicate.status, terminalEvidence(fixture, invocation, duplicate.stderr)).toBe(0);
    expect(JSON.parse(duplicate.stdout) as unknown).toEqual(terminal);
  });
});

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
});

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
});

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
});

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
  CASE_MS,
);

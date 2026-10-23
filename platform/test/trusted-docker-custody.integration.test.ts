import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import {
  CUSTODY_PROXY,
  GROUP_MEMBER_RECORD,
  withTrustedDockerFixture,
} from './trusted-docker-fixture.ts';
import { validateTerminal } from '../../scripts/trusted-docker-record.mjs';
import { browserExecRetirementSummary } from '../../scripts/verification-submission-assessment.mjs';

type CustodyFixture = Parameters<Parameters<typeof withTrustedDockerFixture>[1]>[0];

// Assertion messages carry only sanitized terminal facts, never output, paths or credentials.
function terminalEvidence(fixture: CustodyFixture, invocation: string, stderr: string): string {
  const queried = fixture.command(['status', invocation]);
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

async function cancelHeldCommand(fixture: CustodyFixture, expected: Record<string, unknown>) {
  const started = await fixture.start();
  expect(started.status, started.stderr).toBe(0);
  const invocation = record(JSON.parse(started.stdout) as unknown).invocation;
  if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
  const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
  const manifest = record(
    JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown,
  );
  if (typeof manifest.temporary !== 'string') throw new Error('Missing owned temporary root');
  const temporary = manifest.temporary;
  await vi.waitFor(() => {
    expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
  });
  const cancelled = fixture.command(['cancel', invocation], true);
  expect(cancelled.status, cancelled.stderr).toBe(0);
  expect(JSON.parse(cancelled.stdout) as unknown).toMatchObject({
    invocation,
    state: 'cancellation-requested',
  });
  let terminal: unknown;
  await vi.waitFor(
    () => {
      const result = fixture.command(['status', invocation]);
      expect(result.status, result.stderr).toBe(0);
      terminal = JSON.parse(result.stdout) as unknown;
      expect(terminal).toMatchObject({
        invocation,
        interruption: 'cancelled',
        failure: null,
        output: { complete: true },
        ...expected,
      });
    },
    { timeout: 10_000, interval: 50 },
  );
  expect(readFileSync(join(temporary, 'child-interrupted'), 'utf8')).toBe('SIGINT');
  return { invocation, temporary, terminal };
}

it('publishes reviewed launch authority before work and preserves a real nonzero command result', async () => {
  await withTrustedDockerFixture('fail', async (fixture) => {
    const started = await fixture.start({ DOCKER_HOST: '', DOCKER_CONTEXT: '' });

    expect(started.status, started.stderr).toBe(0);
    const startValue: unknown = JSON.parse(started.stdout);
    const invocation = record(startValue).invocation;
    expect(invocation).toEqual(expect.any(String));
    if (typeof invocation !== 'string') throw new Error('Missing invocation identity');
    const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
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
    await vi.waitFor(
      () => {
        const queried = fixture.command(['status', invocation]);
        expect(queried.status, queried.stderr).toBe(0);
        const value: unknown = JSON.parse(queried.stdout);
        expect(value).toMatchObject({
          invocation,
          head: fixture.head,
          state: 'failed',
          command: { exitCode: 17, signal: null, settled: true },
          output: { complete: true },
          cleanup: { state: 'confirmed', browserExec: null },
        });
      },
      { timeout: 10_000, interval: 50 },
    );
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
    await withTrustedDockerFixture('hold', async (fixture) => {
      const started = await fixture.start();
      expect(started.status, started.stderr).toBe(0);
      const startValue: unknown = JSON.parse(started.stdout);
      const invocation = record(startValue).invocation;
      if (typeof invocation !== 'string') throw new Error('Missing invocation identity');
      const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
      const manifestPath = join(directory, 'manifest.json');
      const original = readFileSync(manifestPath, 'utf8');
      const manifestValue: unknown = JSON.parse(original);
      const manifest = record(manifestValue);
      const temporary = manifest.temporary;
      if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
      await vi.waitFor(() => {
        expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
      });
      const readyValue: unknown = JSON.parse(
        readFileSync(join(temporary, 'child-ready.json'), 'utf8'),
      );
      const ready = record(readyValue);
      if (typeof ready.pid !== 'number' || typeof ready.birth !== 'string')
        throw new Error('Missing child birth identity');
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
      await vi.waitFor(
        () => {
          const result = fixture.command(['status', invocation]);
          expect(result.status, result.stderr).toBe(0);
          const value: unknown = JSON.parse(result.stdout);
          expect(value).toMatchObject({
            state: 'failed',
            command: { exitCode: 17, settled: true },
            interruption: 'none',
          });
        },
        { timeout: 10_000, interval: 50 },
      );
    });
  },
  20_000,
);

it('survives loss of the launching observer group and reconnects to the same real failed invocation', async () => {
  await withTrustedDockerFixture('hold', async (fixture) => {
    const sentinel = await fixture.startSentinel();
    await vi.waitFor(() => {
      expect(existsSync(sentinel.ready)).toBe(true);
    });
    const observation = await fixture.startObserved();
    expect(observation.started.status, observation.started.stderr).toBe(0);
    const startedValue: unknown = JSON.parse(observation.started.stdout);
    const started = record(startedValue);
    const invocation = started.invocation;
    const owner = record(started.owner);
    if (typeof invocation !== 'string' || typeof owner.pid !== 'number')
      throw new Error('Missing owner identity');
    const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
    const manifestValue: unknown = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );
    const temporary = record(manifestValue).temporary;
    if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
    await vi.waitFor(() => {
      expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
    });
    const readyValue: unknown = JSON.parse(
      readFileSync(join(temporary, 'child-ready.json'), 'utf8'),
    );
    const ready = record(readyValue);
    if (typeof ready.pid !== 'number') throw new Error('Missing live child identity');
    await vi.waitFor(() => {
      expect(readFileSync(join(directory, 'stdout.log'), 'utf8')).toContain('fixture-begin\n');
    });

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
    await vi.waitFor(
      () => {
        const result = fixture.command(['status', invocation]);
        expect(result.status, result.stderr).toBe(0);
        const value: unknown = JSON.parse(result.stdout);
        expect(value).toMatchObject({
          invocation,
          state: 'failed',
          command: { exitCode: 17, settled: true },
          interruption: 'none',
          output: { complete: true },
          cleanup: { state: 'confirmed', browserExec: null },
        });
      },
      { timeout: 10_000, interval: 50 },
    );
    const log = fixture.command(['logs', invocation, 'stdout'], true);
    expect(log.status, log.stderr).toBe(0);
    expect(log.stdout).toContain('fixture-begin\nfixture-end\n');
    expect(fixture.observeProcess(sentinel.identity.pid)).toBe(sentinel.identity.birth);
  });
}, 20_000);

it('reports lost owner authority as unknown while its child is live and refuses cancellation or takeover', async () => {
  await withTrustedDockerFixture('hold', async (fixture) => {
    const started = await fixture.start();
    expect(started.status, started.stderr).toBe(0);
    const value: unknown = JSON.parse(started.stdout);
    const invocation = record(value).invocation;
    if (typeof invocation !== 'string') throw new Error('Missing invocation identity');
    const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
    const manifestValue: unknown = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8'),
    );
    const temporary = record(manifestValue).temporary;
    if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
    await vi.waitFor(() => {
      expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
    });
    const readyValue: unknown = JSON.parse(
      readFileSync(join(temporary, 'child-ready.json'), 'utf8'),
    );
    const ready = record(readyValue);
    if (typeof ready.pid !== 'number') throw new Error('Missing child identity');
    await vi.waitFor(() => {
      expect(readFileSync(join(directory, 'stdout.log'), 'utf8')).toContain('fixture-begin\n');
    });

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

it('cancels the actual pnpm child tree and preserves the terminal result on late cancellation', async () => {
  await withTrustedDockerFixture('hold', async (fixture) => {
    const sentinel = await fixture.startSentinel();
    const started = await fixture.start();
    expect(started.status, started.stderr).toBe(0);
    const invocation = record(JSON.parse(started.stdout) as unknown).invocation;
    if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
    const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
    const manifest = record(
      JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown,
    );
    if (typeof manifest.temporary !== 'string') throw new Error('Missing owned temporary root');
    const temporary = manifest.temporary;
    await vi.waitFor(() => {
      expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
    });
    const leaf = record(
      JSON.parse(readFileSync(join(temporary, 'child-ready.json'), 'utf8')) as unknown,
    );
    if (typeof leaf.pid !== 'number') throw new Error('Missing owned leaf identity');
    expect(fixture.observeProcess(leaf.pid)).toBe(leaf.birth);

    const cancelled = fixture.command(['cancel', invocation], true);
    expect(cancelled.status, cancelled.stderr).toBe(0);
    expect(JSON.parse(cancelled.stdout) as unknown).toMatchObject({
      invocation,
      state: 'cancellation-requested',
    });
    const duplicate = fixture.command(['cancel', invocation]);
    expect(duplicate.status, terminalEvidence(fixture, invocation, duplicate.stderr)).toBe(0);
    let terminal: unknown;
    await vi.waitFor(
      () => {
        const result = fixture.command(['status', invocation]);
        expect(result.status, result.stderr).toBe(0);
        terminal = JSON.parse(result.stdout) as unknown;
        expect(terminal).toMatchObject({
          invocation,
          state: 'failed',
          command: { settled: true },
          interruption: 'cancelled',
          output: { complete: true },
          cleanup: { state: 'confirmed', browserExec: null },
        });
      },
      { timeout: 10_000, interval: 50 },
    );

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
  await withTrustedDockerFixture('post-close-member', async (fixture) => {
    const { invocation, terminal } = await cancelHeldCommand(fixture, {
      state: 'failed',
      command: { settled: true },
      cleanup: { state: 'confirmed', browserExec: null },
    });

    const duplicate = fixture.command(['cancel', invocation], true);
    expect(duplicate.status, terminalEvidence(fixture, invocation, duplicate.stderr)).toBe(0);
    expect(JSON.parse(duplicate.stdout) as unknown).toEqual(terminal);
  });
}, 20_000);

it('keeps a cancelled command unsettled while a same-group member outlives the observation window', async () => {
  await withTrustedDockerFixture('past-expiry-member', async (fixture) => {
    const { invocation, temporary } = await cancelHeldCommand(fixture, {
      state: 'unknown',
      command: { exitCode: 27, signal: null, settled: false },
      cleanup: { state: 'unconfirmed', browserExec: null },
    });

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
  await withTrustedDockerFixture('output-failed', async (fixture) => {
    const started = await fixture.start();
    expect(started.status, started.stderr).toBe(0);
    const value: unknown = JSON.parse(started.stdout);
    const invocation = record(value).invocation;
    if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
    const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);

    await vi.waitFor(
      () => {
        const status = fixture.command(['status', invocation]);
        expect(status.status, status.stderr).toBe(0);
        const result: unknown = JSON.parse(status.stdout);
        expect(result).toMatchObject({
          state: 'failed',
          command: { settled: true },
          interruption: 'capture-failed',
          output: { complete: false, stdout: null },
          cleanup: { state: 'confirmed', browserExec: null },
        });
      },
      { timeout: 10_000, interval: 50 },
    );

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
    await withTrustedDockerFixture(mode, async (fixture) => {
      const started = await fixture.start();
      expect(started.status, started.stderr).toBe(0);
      const value: unknown = JSON.parse(started.stdout);
      const invocation = record(value).invocation;
      if (typeof invocation !== 'string') throw new Error('Missing owned invocation');

      await vi.waitFor(
        () => {
          const status = fixture.command(['status', invocation]);
          expect(status.status, status.stderr).toBe(0);
          const result: unknown = JSON.parse(status.stdout);
          expect(result).toMatchObject({ ...expected, output: { complete: true } });
        },
        { timeout: 10_000, interval: 50 },
      );
      const cancelled = fixture.command(['cancel', invocation]);
      expect(cancelled.status, terminalEvidence(fixture, invocation, cancelled.stderr)).toBe(
        cancelStatus,
      );
    });
  },
  20_000,
);

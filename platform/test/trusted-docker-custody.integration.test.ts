import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { withTrustedDockerFixture } from './trusted-docker-fixture.ts';

it('publishes reviewed launch authority before work and preserves a real nonzero command result', async () => {
  await withTrustedDockerFixture('fail', async (fixture) => {
    const started = await fixture.start();

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
          cleanup: { state: 'confirmed' },
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
    for (const output of [
      stdout.stdout,
      stderr.stdout,
      readFileSync(join(directory, 'result.json'), 'utf8'),
    ]) {
      expect(output).not.toContain('fixture-gh-custody-canary');
      expect(output).not.toContain('fixture-model-custody-canary');
      expect(output).not.toContain('fixture-ssh-custody-canary');
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
          cleanup: { state: 'confirmed' },
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
    expect(duplicate.status, duplicate.stderr).toBe(0);
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
          cleanup: { state: 'confirmed' },
        });
      },
      { timeout: 10_000, interval: 50 },
    );

    expect(readFileSync(join(temporary, 'child-interrupted'), 'utf8')).toBe('SIGINT');
    expect(fixture.observeProcess(leaf.pid)).toBeNull();
    const outcome = record(record(terminal).command);
    expect(outcome.exitCode === 0 && outcome.signal === null).toBe(false);
    const late = fixture.command(['cancel', invocation], true);
    expect(late.status, late.stderr).toBe(0);
    expect(JSON.parse(late.stdout) as unknown).toEqual(terminal);
    expect(fixture.observeProcess(sentinel.identity.pid)).toBe(sentinel.identity.birth);
    expect(existsSync(sentinel.interrupted)).toBe(false);
  });
}, 20_000);

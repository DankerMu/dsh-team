import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { createTrustedDockerFixture } from './trusted-docker-fixture.ts';

it('publishes reviewed launch authority before work and preserves a real nonzero command result', async () => {
  const fixture = createTrustedDockerFixture();
  try {
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
  } finally {
    await fixture.cleanup();
  }
}, 20_000);

it('rejects a different reviewed revision before creating custody or starting work', async () => {
  const fixture = createTrustedDockerFixture();
  try {
    const result = fixture.command(['start', '0'.repeat(40)], true);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(existsSync(join(fixture.home, '.local/share/dsh-team/docker-verification'))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

it.each(['owner-birth', 'record-permissions', 'malformed-record'] as const)(
  'refuses changed %s without interrupting owned live work',
  async (fault) => {
    const fixture = createTrustedDockerFixture('hold');
    try {
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
          const birth = String(owner.birth).startsWith('linux:')
            ? `linux:${String(owner.pid)}:0`
            : `darwin:${String(owner.pid)}:${'0'.repeat(64)}`;
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
    } finally {
      await fixture.cleanup();
    }
  },
  20_000,
);

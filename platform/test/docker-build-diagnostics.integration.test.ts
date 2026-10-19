import type * as ChildProcessModule from 'node:child_process';
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDockerCommands } from './docker-command.ts';
import { output } from './docker-cleanup.ts';
import type { DockerCommandResult } from './docker-command.ts';

const children = vi.hoisted((): ChildProcess[] => []);
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  const target = (args: readonly string[]) =>
    args[1] === 'missing-executable' ? '/dsh-team-missing-build-executable' : process.execPath;
  const script = (args: readonly string[]) =>
    args[1] === 'missing-executable' ? [] : ['-e', args[1] ?? ''];
  return {
    ...original,
    spawn(_binary: string, args: readonly string[], options: SpawnOptions) {
      const child = original.spawn(target(args), script(args), options);
      children.push(child);
      return child;
    },
    spawnSync(
      _binary: string,
      args: readonly string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) {
      return original.spawnSync(target(args), script(args), options);
    },
  };
});

function diagnostic(result: DockerCommandResult): Record<string, unknown> {
  const value: unknown = JSON.parse(result.stderr.split('\n')[1] ?? 'null');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Missing bounded build diagnostic');
  return value as Record<string, unknown>; // JSON shape narrowed above; fields asserted by consumers.
}

it('retains an observed build deadline through redaction without exposing command output or error text', async () => {
  const commands = createDockerCommands('unused', 'unused', true, () => ({
    status: null,
    stdout: 'private-stdout',
    stderr: 'private-stderr',
    error: Object.assign(new Error('private-error'), { code: 'ETIMEDOUT' }),
  }));

  const result = await commands.commandAsync(['build'], 600_000);

  expect(result.stdout).toBe('');
  expect(result.error).toBeUndefined();
  expect(result.stderr).toContain('"termination":"deadline"');
  expect(result.stderr).toContain('"timeoutMs":600000');
  expect(result.stderr).not.toContain('private-');
  expect(() => output(result, ['build'])).toThrow('"termination":"deadline"');
});

it.each(['command', 'commandAsync'] as const)(
  '%s distinguishes actual build termination without retaining private output',
  async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-team-build-diagnostic-'));
    const commands = createDockerCommands(process.cwd(), directory, true);
    const cases = [
      {
        script: "process.stderr.write('private-deadline'); setInterval(() => {}, 1000)",
        timeout: 200,
        termination: 'deadline',
      },
      {
        script: "process.stdout.write('x'.repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)",
        timeout: 5000,
        termination: 'output-limit',
      },
      { script: 'missing-executable', timeout: 5000, termination: 'spawn-failure' },
      {
        script: "process.stderr.write('private-signal'); process.kill(process.pid, 'SIGTERM')",
        timeout: 5000,
        termination: 'signal',
      },
      {
        script: "process.stderr.write('private-exit'); process.exitCode = 7",
        timeout: 5000,
        termination: 'exit',
      },
    ];
    try {
      for (const scenario of cases) {
        let closed = false;
        const pending = commands[method](['build', scenario.script], scenario.timeout);
        if (method === 'commandAsync')
          children.at(-1)?.once('close', () => {
            closed = true;
          });

        const result = await pending;

        if (method === 'commandAsync') expect(closed).toBe(true);
        expect(diagnostic(result)).toMatchObject({
          termination: scenario.termination,
          timeoutMs: scenario.timeout,
        });
        expect(diagnostic(result).elapsedMs).toBeGreaterThanOrEqual(0);
        expect(result.stdout).toBe('');
        expect(result.error).toBeUndefined();
        expect(result.stderr).not.toContain('private-');
        expect(result.stderr.length).toBeLessThan(1024);
        expect(() => output(result, ['build'])).toThrow(`"termination":"${scenario.termination}"`);
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  },
);

it('retains only the last recognized build header across interleaved secret-bearing progress', async () => {
  const commands = createDockerCommands('unused', 'unused', true, () => ({
    status: 7,
    stdout: '#99 [runtime 1/1] RUN private-stdout\n',
    stderr: [
      '#1 [internal] load metadata for private-registry/private-image',
      '#8 [runtime 2/5] COPY private-path private-target',
      '#7 [build 2/9] RUN private-key private-command',
      '#8 DONE 1.0s',
      '#7 0.1 private-content',
      '#9 [private-stage 1/1] RUN private-stage-command',
      '#10 [runtime 1/2] RUN private-incomplete',
    ].join('\n'),
  }));

  const result = await commands.commandAsync(['build'], 600_000);

  expect(diagnostic(result)).toMatchObject({
    termination: 'exit',
    lastObservedBuildHeader: { vertex: 7, phase: 'build', step: 2, total: 9, instruction: 'RUN' },
  });
  expect(result.stderr).not.toContain('private-');
  expect(result.stderr).not.toContain('DONE');
});

it.each([
  '#1 [internal] load metadataPRIVATE\n',
  '#0 [build 1/1] RUN private-zero\n',
  '#1000000 [build 1/1] RUN private-oversized\n',
  '#1 [build 2/1] RUN private-order\n',
  '#1 [build 1/1] UNKNOWN private-command\n',
  '#1 [private-stage 1/1] RUN private-stage\n',
  '#1 [build 1/1] RUN private-incomplete',
])('keeps unrecognized or incomplete progress unknown: %s', async (stderr) => {
  const commands = createDockerCommands('unused', 'unused', true, () => ({
    status: null,
    stdout: 'private-output',
    stderr,
    error: Object.assign(new Error('private-error'), { code: 'private-code' }),
  }));

  const result = await commands.commandAsync(['build'], 1);

  expect(diagnostic(result)).toMatchObject({
    termination: 'unknown',
    signal: null,
    lastObservedBuildHeader: null,
  });
  expect(result.stderr).not.toContain('private-');
});

it.each(['command', 'commandAsync'] as const)(
  '%s reports thrown build failures as bounded unknown evidence',
  async (method) => {
    const commands = createDockerCommands('unused', 'unused', true, () => {
      throw new Error('private-thrown-message');
    });

    await expect(async () => commands[method](['build'], 600_000)).rejects.toThrow(
      '"termination":"unknown"',
    );
  },
);

it.each(['command', 'commandAsync'] as const)(
  '%s preserves successful build output and stdin EOF',
  async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-team-build-success-'));
    try {
      const commands = createDockerCommands(process.cwd(), directory, true);

      const result = await commands[method](
        [
          'build',
          "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('build-complete\\n'))",
        ],
        5000,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('build-complete\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true });
    }
  },
);

it.each(['command', 'commandAsync'] as const)(
  '%s projects a fragmented real-child metadata header without retaining its registry',
  async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-team-build-header-'));
    try {
      const commands = createDockerCommands(process.cwd(), directory, true);
      const script =
        "process.stderr.write('#2 [internal] load meta'); setImmediate(() => { process.stderr.write('data for private-registry/private-image\\nprivate-content\\n'); process.exitCode = 7; });";

      const result = await commands[method](['build', script], 5000);

      expect(diagnostic(result)).toMatchObject({
        termination: 'exit',
        exitStatus: 7,
        signal: null,
        lastObservedBuildHeader: {
          vertex: 2,
          phase: 'metadata',
          step: null,
          total: null,
          instruction: null,
        },
      });
      expect(result.stderr).not.toContain('private-');
    } finally {
      rmSync(directory, { recursive: true });
    }
  },
);

it('does not infer a deadline or disclose an unlisted signal from a null status', async () => {
  const commands = createDockerCommands('unused', 'unused', true, () => ({
    status: null,
    stdout: '',
    stderr: '',
    signal: 'SIGUSR1',
  }));

  const result = await commands.commandAsync(['build'], 1);

  expect(diagnostic(result)).toMatchObject({
    termination: 'unknown',
    signal: null,
    exitStatus: null,
    lastObservedBuildHeader: null,
  });
  expect(result.stderr).not.toContain('SIGUSR1');
});

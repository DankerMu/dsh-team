import { spawn, spawnSync } from 'node:child_process';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
import { buildFailureDiagnostic } from '../../scripts/docker-build-diagnostics.mjs';
import {
  runDockerCommand,
  runDockerCommandAsync,
  selectDockerExecution,
} from '../../scripts/docker-command.mjs';
import type { DockerExecution } from '../../scripts/docker-command.mjs';

export interface DockerCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
}

/**
 * External Docker process boundary; timeout is milliseconds, no shell interpolation.
 * `acceptedStatus` declares one nonzero CLI exit the caller independently proves.
 */
export type DockerCommand = (
  args: readonly string[],
  timeout: number,
  acceptedStatus?: number,
) => DockerCommandResult;

/** Live Docker process boundary; settlement includes child closure after cancellation. */
export type AsyncDockerCommand = (
  args: readonly string[],
  timeout: number,
) => Promise<DockerCommandResult>;

export interface DockerCommands {
  readonly command: DockerCommand;
  readonly commandAsync: AsyncDockerCommand;
}

function processOptions(
  repositoryRoot: string,
  config: string,
  bounded: boolean,
  args: readonly string[],
  timeout: number,
) {
  return {
    cwd: repositoryRoot,
    // No GitHub/SSH/model credentials or user Docker configuration reach either execution mode.
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      DOCKER_CONFIG: config,
      ...dockerProxyEnvironment(),
    },
    encoding: 'utf8' as const,
    timeout,
    killSignal: 'SIGKILL' as const,
    maxBuffer: bounded && args[0] !== 'build' ? 64 * 1024 : 16 * 1024 * 1024,
  };
}

function commandFailure(error: unknown, timeout: number, started: number | undefined): Error {
  if (started === undefined) return new Error('Web Docker operation failed');
  const result = {
    status: null,
    stdout: '',
    stderr: '',
    error,
  };
  return new Error(
    `Web Docker operation failed\n${JSON.stringify(buildFailureDiagnostic(result, timeout, started))}`,
  );
}

function redactResult(
  args: readonly string[],
  result: DockerCommandResult,
  timeout: number,
  buildStarted: number | undefined,
): DockerCommandResult {
  const kind = args[0];
  if (
    args[1] === 'inspect' &&
    (kind === 'image' || kind === 'container' || kind === 'volume' || kind === 'network') &&
    isAbsentResource(result, kind, args.at(-1) ?? '')
  ) {
    return result;
  }
  if (result.error !== undefined || result.status !== 0) {
    return {
      status: result.status === 0 ? 1 : result.status,
      stdout: '',
      stderr:
        buildStarted === undefined
          ? 'Web Docker operation failed'
          : `Web Docker operation failed\n${JSON.stringify(buildFailureDiagnostic(result, timeout, buildStarted))}`,
    };
  }
  return result;
}

/** One invocation's isolated policy, with distinct setup/cleanup and live execution modes. */
export function createDockerCommands(
  repositoryRoot: string,
  config: string,
  bounded: boolean,
  injectedCommand?: DockerCommand,
): DockerCommands {
  const externalCommand: DockerCommand = (args, timeout, acceptedStatus) =>
    runDockerCommand(
      selectDockerExecution(args),
      (execution) =>
        injectedCommand === undefined
          ? spawnSync(
              execution.file,
              execution.args,
              processOptions(repositoryRoot, config, bounded, args, timeout),
            )
          : injectedCommand(args, timeout),
      acceptedStatus,
    );
  const rawAsync = (
    args: readonly string[],
    timeout: number,
    execution: DockerExecution,
  ): Promise<DockerCommandResult> => {
    if (injectedCommand !== undefined)
      return Promise.resolve().then(() => injectedCommand(args, timeout));
    const options = processOptions(repositoryRoot, config, bounded, args, timeout);
    const { promise, resolve } = Promise.withResolvers<DockerCommandResult>();
    // Native spawn timeout cannot itself tell us whether closure has settled.
    const child = spawn(execution.file, execution.args, { cwd: options.cwd, env: options.env });
    // Match synchronous no-input execution rather than leaving a writable stdin pipe open.
    child.stdin.end();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let error: Error | undefined;
    function terminate(code: 'ETIMEDOUT' | 'ENOBUFS'): void {
      if (error !== undefined) return;
      error = Object.assign(new Error(`Docker process failed: ${code}`), { code });
      child.kill(options.killSignal);
    }
    function collect(chunks: Buffer[], chunk: Buffer): void {
      if (error !== undefined) return;
      const available = options.maxBuffer - bytes;
      if (chunk.length <= available) {
        chunks.push(chunk);
        bytes += chunk.length;
      } else {
        if (available > 0) chunks.push(chunk.subarray(0, available));
        bytes = options.maxBuffer;
        terminate('ENOBUFS');
      }
    }
    const timer =
      timeout > 0
        ? setTimeout(() => {
            terminate('ETIMEDOUT');
          }, timeout)
        : undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk);
    });
    child.once('error', (failure: Error) => {
      error ??= failure;
    });
    child.once('close', (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({
        // Spawn failure may report a negative errno rather than an actual exit status.
        status: error === undefined ? status : null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(error === undefined ? {} : { error }),
        ...(signal === null ? {} : { signal }),
      });
    });
    return promise;
  };
  const externalAsync: AsyncDockerCommand = (args, timeout) =>
    runDockerCommandAsync(selectDockerExecution(args), (execution) =>
      rawAsync(args, timeout, execution),
    );
  if (!bounded) return { command: externalCommand, commandAsync: externalAsync };
  return {
    command: (args, timeout, acceptedStatus) => {
      const started = args[0] === 'build' ? performance.now() : undefined;
      try {
        return redactResult(args, externalCommand(args, timeout, acceptedStatus), timeout, started);
      } catch (error) {
        throw commandFailure(error, timeout, started);
      }
    },
    commandAsync: async (args, timeout) => {
      const started = args[0] === 'build' ? performance.now() : undefined;
      try {
        return redactResult(args, await externalAsync(args, timeout), timeout, started);
      } catch (error) {
        throw commandFailure(error, timeout, started);
      }
    },
  };
}

/** Only exact-target daemon absence is safe to preserve through Web diagnostic redaction. */
export function isAbsentResource(
  result: DockerCommandResult,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
): boolean {
  if (result.error !== undefined || result.status !== 1) return false;
  const stdout = result.stdout.replace(/\r?\n$/, '');
  if (stdout !== '' && stdout !== '[]') return false;
  const diagnostic = result.stderr.replace(/\r?\n$/, '');
  const absent = [kind, 'object'].some((missingKind) =>
    ['Error response from daemon:', 'Error:'].some(
      (prefix) => diagnostic === `${prefix} No such ${missingKind}: ${name}`,
    ),
  );
  return (
    absent ||
    (kind === 'volume' &&
      diagnostic === `Error response from daemon: get ${name}: no such volume`) ||
    (kind === 'network' && diagnostic === `Error response from daemon: network ${name} not found`)
  );
}

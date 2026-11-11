import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
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

/** The fixed PATH every owned Docker CLI process runs with; Docker Desktop installs into /usr/local/bin. */
export const DOCKER_CLI_PATH = '/usr/local/bin:/usr/bin:/bin';

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
      PATH: DOCKER_CLI_PATH,
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

/** Compose's single-line `${NAME:?…}` interpolation failure; only the name is ever projected. */
const REQUIRED_VARIABLE =
  /^error while interpolating [A-Za-z0-9_.-]+: required variable ([A-Z][A-Z0-9_]*) is missing a value(?:: [\x20-\x7e]*)?\n?$/;

/** The declared, normally exited compose rejection a caller independently proves, else nothing. */
function requiredVariable(
  args: readonly string[],
  result: DockerCommandResult,
  acceptedStatus: number | undefined,
): string | undefined {
  if (args[0] !== 'compose' || acceptedStatus === undefined) return undefined;
  if (result.error !== undefined || result.signal || result.status !== acceptedStatus)
    return undefined;
  return REQUIRED_VARIABLE.exec(result.stderr)?.[1];
}

/** Closed compose failure categories in their fixed precedence; each pattern searches one line. */
const COMPOSE_FAILURES: readonly (readonly [string, RegExp])[] = [
  ['required-variable', REQUIRED_VARIABLE],
  ['port-allocated', /port is already allocated|address already in use/],
  ['image-missing', /No such image|pull access denied/],
  [
    'network-pool-exhausted',
    /could not find an available, non-overlapping IPv4 address pool|all predefined address pools have been fully subnetted/,
  ],
  [
    'network-conflict',
    /Pool overlaps with other one on this address space|network with name .* already exists/,
  ],
  ['container-name-conflict', /Conflict\. The container name .* is already in use/],
];

/** The first matching closed category; only the code, never any original text, is projected. */
function composeFailureCode(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  return (
    COMPOSE_FAILURES.find(([, pattern]) => lines.some((line) => pattern.test(line)))?.[0] ??
    'unknown'
  );
}

/** A normally exited, nonzero compose result's category, else nothing. */
function composeFailure(args: readonly string[], result: DockerCommandResult): string | undefined {
  if (args[0] !== 'compose' || result.error !== undefined || result.signal) return undefined;
  if (typeof result.status !== 'number' || result.status === 0) return undefined;
  return composeFailureCode(result.stderr);
}

function redactResult(
  args: readonly string[],
  result: DockerCommandResult,
  timeout: number,
  buildStarted: number | undefined,
  acceptedStatus?: number,
): DockerCommandResult {
  const kind = args[0];
  if (
    args[1] === 'inspect' &&
    (kind === 'image' || kind === 'container' || kind === 'volume' || kind === 'network') &&
    isAbsentResource(result, kind, args.at(-1) ?? '')
  ) {
    return result;
  }
  const variable = requiredVariable(args, result, acceptedStatus);
  if (variable !== undefined)
    return {
      status: result.status,
      stdout: '',
      stderr: `required variable ${variable} is missing a value`,
    };
  if (result.error !== undefined || result.status !== 0) {
    const code = composeFailure(args, result);
    return {
      status: result.status === 0 ? 1 : result.status,
      stdout: '',
      stderr:
        buildStarted === undefined
          ? `Web Docker operation failed${code === undefined ? '' : `\ncompose-failure: ${code}`}`
          : `Web Docker operation failed\n${JSON.stringify(buildFailureDiagnostic(result, timeout, buildStarted))}`,
    };
  }
  return result;
}

/**
 * Docker Desktop installs compose/buildx only under the user's ~/.docker/cli-plugins; a private
 * empty DOCKER_CONFIG must name the application's own plugin directory. Best effort: a failure
 * writes nothing and throws nothing, so the later compose/buildx prerequisite names the cause.
 */
function linkDesktopCliPlugins(config: string): void {
  if (platform() !== 'darwin') return;
  try {
    const plugins = join(dirname(realpathSync('/usr/local/bin/docker')), '..', 'cli-plugins');
    const file = join(config, 'config.json');
    const content = JSON.stringify({ cliPluginsExtraDirs: [plugins] });
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    if (current === content) return;
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Absent Docker Desktop or an unwritable directory: leave the configuration unchanged.
  }
}

/** One invocation's isolated policy, with distinct setup/cleanup and live execution modes. */
export function createDockerCommands(
  repositoryRoot: string,
  config: string,
  bounded: boolean,
  injectedCommand?: DockerCommand,
): DockerCommands {
  // Only a real Docker CLI reads the configuration; an injected boundary never does.
  if (injectedCommand === undefined) linkDesktopCliPlugins(config);
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
        return redactResult(
          args,
          externalCommand(args, timeout, acceptedStatus),
          timeout,
          started,
          acceptedStatus,
        );
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

/** Docker resolves an untagged image name to `<name>:latest` and names its absence that way. */
export function canonicalImageReference(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
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

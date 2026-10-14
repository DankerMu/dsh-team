import { spawn, spawnSync } from 'node:child_process';

export interface DockerCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/** External Docker process boundary; timeout is milliseconds, no shell interpolation. */
export type DockerCommand = (args: readonly string[], timeout: number) => DockerCommandResult;

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
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_CONFIG: config },
    encoding: 'utf8' as const,
    timeout,
    killSignal: 'SIGKILL' as const,
    maxBuffer: bounded && args[0] !== 'build' ? 64 * 1024 : 16 * 1024 * 1024,
  };
}

function redactResult(args: readonly string[], result: DockerCommandResult): DockerCommandResult {
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
      stderr: 'Web Docker operation failed',
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
  const externalCommand: DockerCommand =
    injectedCommand ??
    ((args, timeout) =>
      spawnSync('docker', args, processOptions(repositoryRoot, config, bounded, args, timeout)));
  const externalAsync: AsyncDockerCommand =
    injectedCommand === undefined
      ? (args, timeout) => {
          const options = processOptions(repositoryRoot, config, bounded, args, timeout);
          return new Promise<DockerCommandResult>((resolve) => {
            // Native spawn timeout cannot itself tell us whether closure has settled.
            const child = spawn('docker', args, { cwd: options.cwd, env: options.env });
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
            child.once('close', (status: number | null) => {
              clearTimeout(timer);
              resolve({
                // Spawn failure may report a negative errno rather than an actual exit status.
                status: error === undefined ? status : null,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                ...(error === undefined ? {} : { error }),
              });
            });
          });
        }
      : // An injected synchronous daemon is the sole process boundary for both modes.
        (args, timeout) => Promise.resolve().then(() => injectedCommand(args, timeout));
  if (!bounded) return { command: externalCommand, commandAsync: externalAsync };
  return {
    command: (args, timeout) => {
      try {
        return redactResult(args, externalCommand(args, timeout));
      } catch {
        throw new Error('Web Docker operation failed');
      }
    },
    commandAsync: async (args, timeout) => {
      try {
        return redactResult(args, await externalAsync(args, timeout));
      } catch {
        throw new Error('Web Docker operation failed');
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

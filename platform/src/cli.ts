import { join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  administerAccount,
  AdministratorConflictError,
  normalizeEmail,
  PasswordPolicyError,
} from './auth/index.ts';
import { loadConfig } from './config.ts';
import { applyMigrations, openDatabase } from './db/index.ts';
import type { DatabaseHandle } from './db/index.ts';
import { createTerminal, TerminalInputError } from './terminal.ts';
import type { TerminalInput, TerminalOutput, TerminalSession } from './terminal.ts';

const SUCCESS_MESSAGES = {
  created: 'Administrator created',
  promoted: 'Account promoted to administrator',
  reset: 'Administrator password reset',
  'promoted-and-reset': 'Account promoted to administrator and password reset',
  unchanged: 'Account is already an administrator; no changes made',
} as const;

export interface SignalSource {
  on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  removeListener: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

class CommandInputError extends Error {}

function commandEmail(
  args: readonly string[],
  input: TerminalInput,
  output: TerminalOutput,
): string {
  if (args.length !== 3 || args[0] !== 'admin' || args[1] !== 'create') {
    throw new CommandInputError('Usage: admin create <email>');
  }
  const email = normalizeEmail(args[2] ?? '');
  if (email === null) {
    throw new CommandInputError('Invalid email');
  }
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new CommandInputError(
      'Administrator creation requires an interactive terminal for input and output',
    );
  }
  return email;
}

function failureMessage(error: unknown, cancelled: boolean): string {
  if (cancelled) {
    return 'Administrator operation cancelled';
  }
  if (
    error instanceof CommandInputError ||
    error instanceof AdministratorConflictError ||
    error instanceof PasswordPolicyError ||
    error instanceof TerminalInputError
  ) {
    return error.message;
  }
  return 'Administrator command failed';
}

/** Runs the deployment command without starting HTTP or issuing a session cookie. */
export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
  errorOutput: Writable = process.stderr,
  signals: SignalSource = process,
  open: (filename: string) => DatabaseHandle = openDatabase,
): Promise<number> {
  let database: DatabaseHandle | undefined;
  let terminal: TerminalSession | undefined;
  const cancellation = new AbortController();
  const cancel = (): void => {
    cancellation.abort();
  };
  let message = '';
  let status = 1;
  try {
    const email = commandEmail(args, input, output);
    const config = loadConfig(env);
    signals.on('SIGINT', cancel);
    signals.on('SIGTERM', cancel);
    terminal = createTerminal(input, output, cancellation);
    cancellation.signal.throwIfAborted();
    database = open(join(config.dataDir, 'platform.db'));
    applyMigrations(database);
    const result = await administerAccount(
      database,
      email,
      terminal.readPassword,
      cancellation.signal,
    );
    output.write(`${SUCCESS_MESSAGES[result]}\n`);
    status = 0;
    return status;
  } catch (error) {
    message = failureMessage(error, cancellation.signal.aborted);
    return status;
  } finally {
    try {
      terminal?.close();
    } finally {
      signals.removeListener('SIGINT', cancel);
      signals.removeListener('SIGTERM', cancel);
      database?.close();
      if (message !== '') {
        errorOutput.write(`${message}\n`);
      }
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2), process.env);
  } catch {
    // Cleanup/output failures must not expose stacks containing terminal input or arguments.
    process.exitCode = 1;
    process.stderr.write('Administrator command failed\n');
  }
}

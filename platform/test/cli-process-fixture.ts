import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createSession, hashPassword } from '../src/auth/index.ts';
import { snapshotAuthState } from './auth-fixture.ts';

export const CLI_EMAIL = 'user@example.com';
export const CLI_ID = 'abcdefghijkl';
export const CLI_PASSWORD = ' 原密码 😀😀 ';
export const CLI_REPLACEMENT = ' 新密码 😀😀 ';
export const CLI_ORIGIN = 'http://platform.example.test';
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harnessPath = fileURLToPath(new URL('./cli-pty.py', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function pinnedPnpmCommand(): string[] {
  const entrypoint = process.env.npm_execpath;
  if (entrypoint === undefined || !isAbsolute(entrypoint)) {
    throw new Error('Run CLI integration verification through the pinned root pnpm command');
  }
  const pnpmPath = realpathSync(entrypoint);
  const manifest: unknown = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('packageManager' in manifest) ||
    typeof manifest.packageManager !== 'string' ||
    !manifest.packageManager.startsWith('pnpm@')
  ) {
    throw new Error('CLI integration verification requires the repository pnpm pin');
  }
  const version = spawnSync(process.execPath, [pnpmPath, '--version'], {
    cwd: repositoryRoot,
    env: { PATH: dirname(process.execPath) },
    encoding: 'utf8',
    // Version qualification must not hang before the bounded PTY scenario starts.
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  if (
    version.error !== undefined ||
    version.status !== 0 ||
    version.stdout.trim() !== manifest.packageManager.slice('pnpm@'.length)
  ) {
    throw new Error('CLI integration verification must use the repository-pinned pnpm version');
  }
  return [process.execPath, pnpmPath, '--silent', '--dir', repositoryRoot, 'cli'];
}

export interface PromptAction {
  prompt: string;
  text?: string;
  control?: 'Ctrl-C' | 'EOF';
  signal?: 'SIGTERM';
}

export interface PtyResult {
  exitCode: number;
  echoBefore: boolean;
  echoAfter: boolean;
  canonicalBefore: boolean;
  canonicalAfter: boolean;
  modeRestored: boolean;
  echoDuring: boolean[];
  leakedInput: boolean;
  output: string;
  harnessError: string | null;
}

export interface CliWorkspace {
  directory: string;
  dataDir: string;
  databasePath: string;
}

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'employee' | 'admin';
  status: 'active' | 'disabled';
  created_at: number;
}

export function createCliWorkspace(): CliWorkspace {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-cli-'));
  const dataDir = join(directory, 'data');
  return { directory, dataDir, databasePath: join(dataDir, 'platform.db') };
}

export function removeCliWorkspace(workspace: CliWorkspace): void {
  rmSync(workspace.directory, { recursive: true, force: true });
}

function validateTerminalEvidence(result: object): void {
  for (const field of [
    'echoBefore',
    'echoAfter',
    'canonicalBefore',
    'canonicalAfter',
    'modeRestored',
    'leakedInput',
  ]) {
    if (!(field in result) || typeof Reflect.get(result, field) !== 'boolean') {
      throw new Error('Python 3 POSIX PTY harness returned invalid terminal evidence');
    }
  }
  if (
    !('echoDuring' in result) ||
    !Array.isArray(result.echoDuring) ||
    result.echoDuring.some((value: unknown) => typeof value !== 'boolean')
  ) {
    throw new Error('Python 3 POSIX PTY harness returned invalid prompt evidence');
  }
}

function parsePtyResult(output: string): PtyResult {
  const result: unknown = JSON.parse(output);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('exitCode' in result) ||
    typeof result.exitCode !== 'number' ||
    !('output' in result) ||
    typeof result.output !== 'string' ||
    !('harnessError' in result) ||
    result.harnessError !== null
  ) {
    throw new Error('Python 3 POSIX PTY harness did not complete the requested process scenario');
  }
  validateTerminalEvidence(result);
  // Every result field was validated above; TypeScript cannot retain dynamic field-loop narrowing.
  return result as PtyResult;
}

export function runPty(
  workspace: CliWorkspace,
  options: {
    sourceWrapper?: boolean;
    args?: readonly string[];
    actions?: readonly PromptAction[];
    secrets?: readonly string[];
    env?: Readonly<Record<string, string>>;
    stdinMode?: 'pipe';
    stdoutMode?: 'pipe';
    pipedInput?: string;
  } = {},
): PtyResult {
  const command = options.sourceWrapper === true ? pinnedPnpmCommand() : undefined;
  const args = options.args ?? ['admin', 'create', CLI_EMAIL];
  const request = {
    node: process.execPath,
    entrypoint: cliPath,
    command: command === undefined ? undefined : [...command, ...args],
    args,
    cwd: workspace.directory,
    env: {
      ...(command === undefined ? {} : { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }),
      PLATFORM_DATA_DIR: workspace.dataDir,
      PLATFORM_PUBLIC_URL: CLI_ORIGIN,
      ...options.env,
    },
    actions: options.actions ?? [],
    secrets: [CLI_EMAIL, ...(options.secrets ?? [])],
    stdinMode: options.stdinMode,
    stdoutMode: options.stdoutMode,
    pipedInput: options.pipedInput,
  };
  const processResult = spawnSync('python3', [harnessPath], {
    cwd: workspace.directory,
    env: {
      PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    encoding: 'utf8',
    input: JSON.stringify(request),
    // The harness has a six-second prompt/exit deadline and owned-process cleanup before this cap.
    timeout: 8000,
    killSignal: 'SIGKILL',
  });
  if (processResult.error !== undefined || processResult.status !== 0) {
    throw new Error('Python 3 POSIX PTY prerequisite or harness execution failed');
  }
  return parsePtyResult(processResult.stdout);
}

export function expectRestoredTerminal(result: PtyResult): void {
  expect(result.echoBefore).toBe(true);
  expect(result.echoAfter).toBe(true);
  expect(result.canonicalBefore).toBe(true);
  expect(result.canonicalAfter).toBe(true);
  expect(result.modeRestored).toBe(true);
  expect(result.leakedInput).toBe(false);
}

export function matchingPasswords(password: string): PromptAction[] {
  return [
    { prompt: 'Password: ', text: password },
    { prompt: 'Confirm password: ', text: password },
  ];
}

export function readAccount(database: DatabaseHandle, email = CLI_EMAIL): AccountRow | undefined {
  return database.prepare<[string], AccountRow>('SELECT * FROM users WHERE email = ?').get(email);
}

export function readCliState(database: DatabaseHandle) {
  return {
    users: database.prepare('SELECT * FROM users ORDER BY id').all(),
    ...snapshotAuthState(database),
  };
}

export async function seedCliAccounts(
  workspace: CliWorkspace,
  role: 'employee' | 'admin' = 'employee',
  status: 'active' | 'disabled' = 'active',
) {
  const database = openDatabase(workspace.databasePath);
  try {
    applyMigrations(database);
    const hash = await hashPassword(CLI_PASSWORD);
    const insert = database.prepare(
      'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(CLI_ID, CLI_EMAIL, hash, role, status, 1234);
    insert.run('mnopqrstuvwx', 'other@example.com', hash, 'employee', 'active', 5678);
    const now = Date.now();
    const oldTokens = [createSession(database, CLI_ID, now), createSession(database, CLI_ID, now)];
    const otherToken = createSession(database, 'mnopqrstuvwx', now);
    const account = readAccount(database);
    const otherAccount = readAccount(database, 'other@example.com');
    if (account === undefined || otherAccount === undefined) {
      throw new Error('expected seeded CLI accounts');
    }
    return { before: readCliState(database), account, otherAccount, oldTokens, otherToken };
  } finally {
    database.close();
  }
}

function cliConfig(workspace: CliWorkspace) {
  return loadConfig({
    PLATFORM_DATA_DIR: workspace.dataDir,
    PLATFORM_PUBLIC_URL: CLI_ORIGIN,
    PLATFORM_LOG_LEVEL: 'silent',
  });
}

export async function withCliHttp(
  workspace: CliWorkspace,
  run: (baseUrl: string, database: DatabaseHandle) => Promise<void>,
): Promise<void> {
  const database = openDatabase(workspace.databasePath);
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp(cliConfig(workspace), database);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await run(baseUrl, database);
  } finally {
    if (app === undefined) {
      database.close();
    } else {
      await app.close();
    }
  }
}

export function postCliLogin(baseUrl: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/_platform/api/login`, {
    method: 'POST',
    headers: { origin: CLI_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: CLI_EMAIL, password }),
  });
}

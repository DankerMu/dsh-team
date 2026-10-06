import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { queryAuditEvents } from '../src/audit/index.ts';
import { getSessionUser, verifyPassword } from '../src/auth/index.ts';
import { openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import {
  CLI_EMAIL,
  CLI_ID,
  CLI_ORIGIN,
  CLI_PASSWORD,
  CLI_REPLACEMENT,
  createCliWorkspace,
  expectRestoredTerminal,
  matchingPasswords,
  postCliLogin,
  readAccount,
  readCliState,
  removeCliWorkspace,
  runPty,
  seedCliAccounts,
  withCliHttp,
} from './cli-process-fixture.ts';
import type { PromptAction } from './cli-process-fixture.ts';
import { sessionCookieToken } from './auth-fixture.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('administrator deployment command', () => {
  it('rejects piped administrator creation without exposing arguments or creating data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-team-cli-'));
    const email = 'user@example.com';
    const terminalInput = 'piped-password-sentinel';

    try {
      const result = spawnSync(process.execPath, [cliPath, 'admin', 'create', email], {
        cwd: directory,
        env: {
          PLATFORM_DATA_DIR: join(directory, 'data'),
          PLATFORM_PUBLIC_URL: 'http://platform.example.test',
        },
        encoding: 'utf8',
        input: `${terminalInput}\n${terminalInput}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Kill a CLI that waits for interaction instead of rejecting pipes before Vitest times out.
        timeout: 3000,
        killSignal: 'SIGKILL',
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBeNull();
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      const leakedInput = output.includes(email) || output.includes(terminalInput);
      const sanitizedOutput = output
        .replaceAll(email, '[redacted]')
        .replaceAll(terminalInput, '[redacted]');
      expect(leakedInput).toBe(false);
      expect(sanitizedOutput).toMatch(/interactive terminal/i);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function expectDeploymentAudits(
  database: DatabaseHandle,
  types: readonly string[],
  target: string,
) {
  const audits = queryAuditEvents(database, { page: 1, pageSize: 20 });
  expect(
    audits.map(({ type, actorEmail, targetEmail, target: userId, sourceAddress, details }) => ({
      type,
      actorEmail,
      targetEmail,
      target: userId,
      sourceAddress,
      details,
    })),
  ).toEqual(
    types.map((type) => ({
      type,
      actorEmail: null,
      targetEmail: CLI_EMAIL,
      target,
      sourceAddress: null,
      details: {},
    })),
  );
  if (types.length === 2) {
    expect(audits[0]?.createdAt).toBe(audits[1]?.createdAt);
  }
  return audits;
}

// The harness has a bounded prompt/exit deadline; allow cleanup and real password/HTTP verification.
const PTY_TEST_TIMEOUT = 15000;

describe('administrator deployment command over actual PTYs', () => {
  it(
    'creates a canonical active administrator with hidden Unicode input and authenticates that identity over HTTP',
    async () => {
      const workspace = createCliWorkspace();
      const environmentPassword = 'environment-password-sentinel';
      const emailArgument = ' User@Example.com ';
      try {
        const startedAt = Date.now();
        const result = runPty(workspace, {
          args: ['admin', 'create', emailArgument],
          actions: matchingPasswords(CLI_REPLACEMENT),
          secrets: [CLI_REPLACEMENT, environmentPassword, emailArgument],
          env: {
            PLATFORM_ADMIN_PASSWORD: environmentPassword,
            ADMIN_PASSWORD: environmentPassword,
          },
        });

        expect(result.exitCode).toBe(0);
        expectRestoredTerminal(result);
        expect(result.echoDuring).toEqual([false, false]);
        await withCliHttp(workspace, async (baseUrl, database) => {
          const account = readAccount(database);
          if (account === undefined) {
            throw new Error('expected created administrator');
          }
          expect(account.id).toMatch(/^[a-z0-9]{12}$/);
          expect(account.password_hash).toMatch(/^scrypt-utf16le\$/);
          expect(Number.isSafeInteger(account.created_at)).toBe(true);
          expect(account.created_at).toBeGreaterThanOrEqual(startedAt);
          expect(account.created_at).toBeLessThanOrEqual(Date.now());
          expect(account).toEqual({
            id: account.id,
            email: CLI_EMAIL,
            password_hash: account.password_hash,
            role: 'admin',
            status: 'active',
            created_at: account.created_at,
          });
          const state = readCliState(database);
          expect(state.sessions).toEqual([]);
          expect(state.users).toEqual([account]);
          const audits = expectDeploymentAudits(database, ['admin.created'], account.id);
          expect(audits[0]?.createdAt).toBe(account.created_at);
          expect(await verifyPassword(CLI_REPLACEMENT, account.password_hash)).toBe(true);
          expect(await verifyPassword(environmentPassword, account.password_hash)).toBe(false);

          const login = await postCliLogin(baseUrl, CLI_REPLACEMENT);
          expect(login.status).toBe(200);
          expect(await login.json()).toEqual({ id: account.id, email: CLI_EMAIL, role: 'admin' });
          const token = sessionCookieToken(login.headers.getSetCookie());
          expect(getSessionUser(database, token, Date.now(), false)).toEqual({
            id: account.id,
            email: CLI_EMAIL,
            role: 'admin',
          });
          const environmentLogin = await postCliLogin(baseUrl, environmentPassword);
          expect(environmentLogin.status).toBe(401);
        });
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it.each(['active', 'disabled'] as const)(
    'promotes a %s employee with default-no reset while preserving every other field and session',
    async (status) => {
      const workspace = createCliWorkspace();
      try {
        const seeded = await seedCliAccounts(workspace, 'employee', status);
        const result = runPty(workspace, {
          actions: [{ prompt: 'Reset password? [y/N]: ', text: '' }],
        });

        expect(result.exitCode).toBe(0);
        expectRestoredTerminal(result);
        expect(result.echoDuring).toEqual([false]);
        await withCliHttp(workspace, async (baseUrl, database) => {
          expect(readAccount(database)).toEqual({ ...seeded.account, role: 'admin' });
          expect(readAccount(database, 'other@example.com')).toEqual(seeded.otherAccount);
          expect(readCliState(database).sessions).toEqual(seeded.before.sessions);
          expectDeploymentAudits(database, ['admin.promoted'], CLI_ID);
          const login = await postCliLogin(baseUrl, CLI_PASSWORD);
          expect(login.status).toBe(status === 'active' ? 200 : 403);
          if (status === 'active') {
            expect(await login.json()).toEqual({ id: CLI_ID, email: CLI_EMAIL, role: 'admin' });
          }
        });
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it(
    'leaves an already-administrator disabled account and all persisted state unchanged without reset',
    async () => {
      const workspace = createCliWorkspace();
      try {
        const seeded = await seedCliAccounts(workspace, 'admin', 'disabled');
        const result = runPty(workspace, {
          actions: [{ prompt: 'Reset password? [y/N]: ', text: 'n' }],
        });

        expect(result.exitCode).toBe(0);
        expectRestoredTerminal(result);
        expect(result.output).toMatch(/already an administrator/i);
        const database = openDatabase(workspace.databasePath);
        try {
          expect(readCliState(database)).toEqual(seeded.before);
        } finally {
          database.close();
        }
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it.each([
    { role: 'employee', status: 'active' },
    { role: 'admin', status: 'active' },
    { role: 'admin', status: 'disabled' },
  ] as const)(
    'resets a $status $role with correct audits and complete target-session revocation',
    async ({ role, status }) => {
      const workspace = createCliWorkspace();
      try {
        const seeded = await seedCliAccounts(workspace, role, status);
        const result = runPty(workspace, {
          actions: [
            { prompt: 'Reset password? [y/N]: ', text: 'y' },
            ...matchingPasswords(CLI_REPLACEMENT),
          ],
          secrets: [CLI_REPLACEMENT, CLI_PASSWORD],
        });

        expect(result.exitCode).toBe(0);
        expectRestoredTerminal(result);
        expect(result.echoDuring).toEqual([false, false, false]);
        await withCliHttp(workspace, async (baseUrl, database) => {
          const account = readAccount(database);
          if (account === undefined) {
            throw new Error('expected reset administrator');
          }
          expect(account.password_hash).not.toBe(seeded.account.password_hash);
          expect(account).toEqual({
            ...seeded.account,
            role: 'admin',
            password_hash: account.password_hash,
          });
          expect(readAccount(database, 'other@example.com')).toEqual(seeded.otherAccount);
          expect(await verifyPassword(CLI_REPLACEMENT, account.password_hash)).toBe(true);
          expect(await verifyPassword(CLI_PASSWORD, account.password_hash)).toBe(false);
          for (const token of seeded.oldTokens) {
            expect(getSessionUser(database, token, Date.now(), false)).toBeNull();
          }
          expect(getSessionUser(database, seeded.otherToken, Date.now(), false)).toEqual({
            id: 'mnopqrstuvwx',
            email: 'other@example.com',
            role: 'employee',
          });
          expect(
            database.prepare('SELECT * FROM platform_sessions WHERE user_id = ?').all(CLI_ID),
          ).toEqual([]);
          const otherSessions = database
            .prepare("SELECT * FROM platform_sessions WHERE user_id = 'mnopqrstuvwx'")
            .all();
          expect(otherSessions).toEqual(
            seeded.before.sessions.filter(
              (session) =>
                typeof session === 'object' &&
                session !== null &&
                'user_id' in session &&
                session.user_id === 'mnopqrstuvwx',
            ),
          );
          expectDeploymentAudits(
            database,
            role === 'employee' ? ['password.reset', 'admin.promoted'] : ['password.reset'],
            CLI_ID,
          );

          if (status === 'active') {
            const oldLogin = await postCliLogin(baseUrl, CLI_PASSWORD);
            expect(oldLogin.status).toBe(401);
            const newLogin = await postCliLogin(baseUrl, CLI_REPLACEMENT);
            expect(newLogin.status).toBe(200);
            expect(await newLogin.json()).toEqual({ id: CLI_ID, email: CLI_EMAIL, role: 'admin' });
            for (const token of seeded.oldTokens) {
              const logout = await fetch(`${baseUrl}/_platform/api/logout`, {
                method: 'POST',
                headers: {
                  origin: CLI_ORIGIN,
                  'content-type': 'application/json',
                  cookie: `platform_session=${token}`,
                },
                body: '{}',
              });
              expect(logout.status).toBe(401);
            }
          } else {
            const login = await postCliLogin(baseUrl, CLI_REPLACEMENT);
            expect(login.status).toBe(403);
          }
        });
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it.each([
    {
      kind: 'mismatched confirmation',
      password: CLI_REPLACEMENT,
      confirmation: 'different-password-sentinel',
    },
    { kind: 'five Unicode code points', password: '😀'.repeat(5), confirmation: '😀'.repeat(5) },
    {
      kind: '257 Unicode code points',
      // Keep this actual-PTY burst below Darwin's input queue while retaining 257 code points.
      // Pure-astral count boundaries remain covered by the password and administrator unit tests.
      password: `😀${'a'.repeat(256)}`,
      confirmation: `😀${'a'.repeat(256)}`,
    },
  ])(
    'rejects $kind without changing populated account/session/audit state',
    async ({ password, confirmation }) => {
      const workspace = createCliWorkspace();
      try {
        const seeded = await seedCliAccounts(workspace);
        const result = runPty(workspace, {
          actions: [
            { prompt: 'Reset password? [y/N]: ', text: 'yes' },
            { prompt: 'Password: ', text: password },
            { prompt: 'Confirm password: ', text: confirmation },
          ],
          secrets: [password, confirmation],
        });

        expect(result.exitCode).toBeGreaterThan(0);
        expectRestoredTerminal(result);
        expect(result.echoDuring).toEqual([false, false, false]);
        const database = openDatabase(workspace.databasePath);
        try {
          expect(readCliState(database)).toEqual(seeded.before);
        } finally {
          database.close();
        }
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  const cancellations: readonly { kind: string; actions: readonly PromptAction[] }[] = [
    { kind: 'terminal EOF', actions: [{ prompt: 'Password: ', control: 'EOF' }] },
    { kind: 'Ctrl-C', actions: [{ prompt: 'Password: ', control: 'Ctrl-C' }] },
    {
      kind: 'SIGTERM during confirmation',
      actions: [
        { prompt: 'Password: ', text: CLI_REPLACEMENT },
        { prompt: 'Confirm password: ', signal: 'SIGTERM' },
      ],
    },
  ];
  it.each(cancellations)(
    'cancels on $kind with unchanged populated state and restored echo',
    async ({ actions }) => {
      const workspace = createCliWorkspace();
      try {
        const seeded = await seedCliAccounts(workspace);
        const result = runPty(workspace, {
          actions: [{ prompt: 'Reset password? [y/N]: ', text: 'y' }, ...actions],
          secrets: [CLI_REPLACEMENT],
        });

        expect(result.exitCode).toBeGreaterThan(0);
        expectRestoredTerminal(result);
        const database = openDatabase(workspace.databasePath);
        try {
          expect(readCliState(database)).toEqual(seeded.before);
        } finally {
          database.close();
        }
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it.each([
    { kind: 'piped input', stdinMode: 'pipe' },
    { kind: 'redirected output', stdoutMode: 'pipe' },
  ] as const)(
    'rejects $kind independently before creating its data directory',
    ({ kind }) => {
      const workspace = createCliWorkspace();
      const sentinel = 'piped-input-sentinel';
      try {
        const result = runPty(workspace, {
          ...(kind === 'piped input' ? { stdinMode: 'pipe' } : { stdoutMode: 'pipe' }),
          pipedInput: `${sentinel}\n`,
          secrets: [sentinel],
        });

        expect(result.exitCode).toBeGreaterThan(0);
        expectRestoredTerminal(result);
        expect(result.output).toMatch(/interactive terminal/i);
        expect(readdirSync(workspace.directory)).toEqual([]);
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );

  it.each([
    { kind: 'positional password', extra: ['argument-password-sentinel'] },
    { kind: 'password option', extra: ['--password=argument-password-sentinel'] },
    { kind: 'extra option', extra: ['--force'] },
  ])(
    'rejects $kind on a real terminal without argument disclosure or data creation',
    ({ extra }) => {
      const workspace = createCliWorkspace();
      try {
        const result = runPty(workspace, {
          args: ['admin', 'create', CLI_EMAIL, ...extra],
          secrets: [...extra, 'argument-password-sentinel'],
        });

        expect(result.exitCode).toBeGreaterThan(0);
        expectRestoredTerminal(result);
        expect(result.output).toMatch(/usage/i);
        expect(readdirSync(workspace.directory)).toEqual([]);
      } finally {
        removeCliWorkspace(workspace);
      }
    },
    PTY_TEST_TIMEOUT,
  );
});

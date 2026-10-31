/** Local full-stack verification entry: prerequisites before any resource, exact-owned retirement. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDockerCommands } from '../platform/test/docker-command.ts';
import { readCleanupJournal, retireCleanupJournal } from '../platform/test/docker-cleanup.ts';
import { readPrivateJsonFile } from './docker-proxy-environment.mjs';
import {
  STACK_CONFIG_RELATIVE_PATH,
  assessStackPrerequisites,
} from './test-stack-prerequisites.mjs';

const BODY_LIMIT = 65_536;

/**
 * @typedef {import('./test-stack-prerequisites.mjs').StackFacts} StackFacts
 * @typedef {import('./test-stack-prerequisites.mjs').VersionFact} VersionFact
 * @typedef {{code: number | null, signal: NodeJS.Signals | null}} CaseOutcome
 * @typedef {{
 *   env: NodeJS.ProcessEnv, platform: string, arch: string, repositoryRoot: string,
 *   dockerCommands: (repositoryRoot: string, config: string) =>
 *     import('../platform/test/docker-command.ts').DockerCommands,
 *   probeVersion: (ragflowUrl: string) => Promise<VersionFact>,
 *   spawnCases: (env: NodeJS.ProcessEnv, repositoryRoot: string) => Promise<CaseOutcome>,
 *   retire: typeof retireCleanupJournal,
 *   stderr: (text: string) => void,
 * }} StackRun
 */

/**
 * Unauthenticated, non-redirecting, deadline- and size-bounded; failures carry no evidence.
 * @param {string} ragflowUrl origin without a trailing slash
 * @param {number} [deadline]
 * @returns {Promise<VersionFact>}
 */
export async function probeRagflowVersion(ragflowUrl, deadline = 5000) {
  try {
    const response = await fetch(`${ragflowUrl}/api/v1/system/version`, {
      redirect: 'error',
      signal: AbortSignal.timeout(deadline),
    });
    const reader = response.body?.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let size = 0;
    for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
      size += chunk.value.length;
      if (size > BODY_LIMIT) {
        await reader?.cancel();
        return 'unreachable';
      }
      chunks.push(chunk.value);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  } catch {
    return 'unreachable';
  }
}

/**
 * Facts are gathered lazily: a later fact is never observed after an earlier failure.
 * @param {StackRun} options
 * @param {import('../platform/test/docker-command.ts').DockerCommands} commands
 */
async function assess(options, commands) {
  /** @type {StackFacts} */
  const facts = {
    dockerHost: options.env.DOCKER_HOST,
    dockerContext: options.env.DOCKER_CONTEXT,
    platform: options.platform,
    arch: options.arch,
  };
  let assessment = assessStackPrerequisites(facts);
  if (assessment.ok === undefined) {
    try {
      facts.config = readPrivateJsonFile(
        join(homedir(), STACK_CONFIG_RELATIVE_PATH),
        process.getuid?.() ?? -1,
      );
    } catch {
      facts.config = 'invalid';
    }
    assessment = assessStackPrerequisites(facts);
  }
  if (assessment.ok === undefined) {
    try {
      facts.dockerInfo = commands.command(['info', '--format', '{{json .}}'], 30_000);
    } catch {
      facts.dockerInfo = { status: null, stdout: '' };
    }
    assessment = assessStackPrerequisites(facts);
  }
  if (assessment.ok === undefined) {
    facts.version = await options.probeVersion(assessment.ragflowUrl ?? '');
    assessment = assessStackPrerequisites(facts);
  }
  return assessment;
}

/** @param {CaseOutcome} outcome */
function caseStatus({ code, signal }) {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

/**
 * @param {StackRun} options
 * @returns {Promise<number>} process exit status
 */
export async function runTestStack(options) {
  const runDir = await mkdtemp(join(tmpdir(), 'dsh-team-stack-'));
  const journal = join(runDir, 'cleanup.journal');
  await mkdir(join(runDir, 'docker-config'), { mode: 0o700 });
  await writeFile(journal, '', { mode: 0o600, flag: 'wx' });
  // docker info and retirement share one fixed-PATH, private-DOCKER_CONFIG transport.
  const commands = options.dockerCommands(options.repositoryRoot, join(runDir, 'docker-config'));
  const assessment = await assess(options, commands);
  if (assessment.ok !== true) {
    await rm(runDir, { recursive: true, force: true });
    options.stderr(`test:stack prerequisite failed: ${String(assessment.reason)}\n`);
    return 1;
  }
  let status = 1;
  try {
    status = caseStatus(
      await options.spawnCases(
        { ...options.env, DSH_TEAM_CI_RESOURCE_JOURNAL: journal },
        options.repositoryRoot,
      ),
    );
  } catch {
    // A failed case launch still retires whatever the journal registered.
  }
  /** @type {unknown[]} */
  const failures = [];
  const retirement = {
    command: commands.command,
    commandAsync: commands.commandAsync,
    // The local lane sets no DSH_TEAM_VERIFICATION_SUBMISSIONS: there is no submission ledger.
    requireSettled: () => undefined,
    // flock is absent on macOS; 10.3 replaces this before it registers the fixed platform.
    acquireLock: () => Promise.reject(new Error('deployment lock unavailable in the local lane')),
  };
  try {
    await options.retire(readCleanupJournal(journal), retirement, failures);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) await rm(runDir, { recursive: true, force: true });
  else
    options.stderr(
      `test:stack cleanup failed (${String(failures.length)}); journal retained at ${runDir}\n`,
    );
  return status || (failures.length === 0 ? 0 : 1);
}

/**
 * Launches the vitest entry directly under this Node, without a pnpm hop: forwarded
 * SIGINT/SIGTERM reach the case runner itself, and settlement is its own `close`, so
 * retirement never starts while it can still register resources.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {{file: string, args: string[]}} [launch]
 * @returns {Promise<CaseOutcome>}
 */
export function spawnCases(env, cwd, launch) {
  const { file, args } = launch ?? {
    file: process.execPath,
    args: [join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'stack'],
  };
  const child = spawn(file, args, { cwd, env, stdio: 'inherit' });
  /** @type {NodeJS.Signals | undefined} */
  let interrupted;
  let failed = false;
  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => {
    interrupted ??= signal;
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.once('error', () => (failed = true));
  return new Promise((done) => {
    child.once('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (interrupted !== undefined) done({ code: null, signal: interrupted });
      else done(failed ? { code: 1, signal: null } : { code, signal });
    });
  });
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  process.exitCode = await runTestStack({
    env: process.env,
    platform: platform(),
    arch: arch(),
    repositoryRoot,
    dockerCommands: (directory, config) => createDockerCommands(directory, config, true),
    probeVersion: probeRagflowVersion,
    spawnCases: (env, cwd) => spawnCases(env, cwd),
    retire: retireCleanupJournal,
    stderr: (text) => process.stderr.write(text),
  });
}

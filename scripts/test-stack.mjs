/** Local full-stack verification entry: prerequisites before any resource, exact-owned retirement. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createDockerCommands } from '../platform/test/docker-command.ts';
import {
  acquireDeploymentLock,
  output,
  OWNER_LABEL,
  readCleanupJournal,
  retireCleanupJournal,
} from '../platform/test/docker-cleanup.ts';
import { readPrivateJsonFile } from './docker-proxy-environment.mjs';
import {
  DOCUMENT_SERVER_IMAGE,
  STACK_CONFIG_RELATIVE_PATH,
  assessStackPrerequisites,
} from './test-stack-prerequisites.mjs';
import { groupSettlesAfterClose } from './trusted-docker-record.mjs';

const BODY_LIMIT = 65_536;

/**
 * @typedef {import('./test-stack-prerequisites.mjs').StackFacts} StackFacts
 * @typedef {import('./test-stack-prerequisites.mjs').VersionFact} VersionFact
 * @typedef {{code: number | null, signal: NodeJS.Signals | null, settled: boolean}} CaseOutcome
 * @typedef {import('../platform/test/docker-command.ts').DockerCommands} DockerCommands
 * @typedef {{
 *   env: NodeJS.ProcessEnv, platform: string, arch: string, repositoryRoot: string,
 *   dockerCommands: (repositoryRoot: string, config: string) => DockerCommands,
 *   probeVersion: (ragflowUrl: string) => Promise<VersionFact>,
 *   probeFonts: (path: string) => boolean,
 *   probePython: () => boolean,
 *   probeChromium: () => boolean,
 *   spawnCases: (env: NodeJS.ProcessEnv, repositoryRoot: string) => Promise<CaseOutcome>,
 *   retire: typeof retireCleanupJournal,
 *   acquireLock: () => Promise<() => Promise<void>>,
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

/** The darwin deployment lock holder's interpreter and module, as `acquireDeploymentLock` runs it. */
function probePython() {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', 'import fcntl'], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
    timeout: 30_000,
  });
  return result.error === undefined && result.status === 0;
}

/** The repository-pinned Playwright Chromium the browser cases launch, as `test:ui:install` placed it. */
function probeChromium() {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * The operator font directory the delivered compose binds read-only; never created here.
 * @param {string} path
 */
function probeFonts(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @param {DockerCommands} commands @param {string[]} args */
function dockerFact(commands, args) {
  try {
    return commands.command(args, 30_000);
  } catch {
    return { status: null, stdout: '' };
  }
}

/**
 * Facts are gathered lazily: a later fact is never observed after an earlier failure.
 * @param {StackRun} options
 * @param {DockerCommands} commands
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
  /** @type {[keyof StackFacts, () => StackFacts[keyof StackFacts]][]} */
  const gathered = [
    ['dockerInfo', () => dockerFact(commands, ['info', '--format', '{{json .}}'])],
    ['compose', () => dockerFact(commands, ['compose', 'version', '--short'])],
    ['buildx', () => dockerFact(commands, ['buildx', 'version'])],
    // Present locally, never pulled; the font directory resolves from the repository root.
    [
      'documentServerImage',
      () => dockerFact(commands, ['image', 'inspect', DOCUMENT_SERVER_IMAGE]),
    ],
    ['fonts', () => options.probeFonts(join(options.repositoryRoot, 'assets/fonts'))],
    ['python', () => options.probePython()],
    ['chromium', () => options.probeChromium()],
  ];
  for (const [fact, gather] of gathered) {
    if (assessment.ok !== undefined || assessment.ragflowUrl === undefined) break;
    if (fact === 'python' && options.platform !== 'darwin') break;
    Object.assign(facts, { [fact]: gather() });
    assessment = assessStackPrerequisites(facts);
  }
  if (assessment.ok === undefined) {
    facts.version = await options.probeVersion(assessment.ragflowUrl ?? '');
    assessment = assessStackPrerequisites(facts);
  }
  return assessment;
}

/** @param {Omit<CaseOutcome, 'settled'>} outcome */
function caseStatus({ code, signal }) {
  if (code !== null) return code;
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

/**
 * Read-only: a killed CLI's daemon-side creation can land after exact retirement, and the local
 * lane has no submission ledger. Every journal run label, then every distinct record ownership
 * not equal to one, must list nothing afterwards; multiple label filters all have to match.
 * @param {DockerCommands} commands
 * @param {readonly import('../platform/test/docker-cleanup.ts').CleanupJournalEntry[]} entries
 * @param {unknown[]} failures
 */
function requireEmptyInventory(commands, entries, failures) {
  /** @type {Map<string, [string, string][]>} */
  const owners = new Map();
  for (const ownership of [
    ...entries.map(({ runId }) => ({ [OWNER_LABEL]: runId })),
    // Absent ownership means the run label, as retirement reads it.
    ...entries.map(({ runId, target }) => target.ownership ?? { [OWNER_LABEL]: runId }),
  ]) {
    const pairs = Object.entries(ownership).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = JSON.stringify(pairs);
    if (!owners.has(key)) owners.set(key, pairs);
  }
  for (const pairs of owners.values()) {
    const filter = pairs.flatMap(([label, value]) => ['--filter', `label=${label}=${value}`]);
    const labels = pairs.map(([label]) => label).join(', ');
    for (const args of [
      ['container', 'ls', '--all', '--quiet', '--no-trunc', ...filter],
      ['network', 'ls', '--quiet', '--no-trunc', ...filter],
      ['volume', 'ls', '--quiet', ...filter],
      ['image', 'ls', '--all', '--quiet', '--no-trunc', ...filter],
    ]) {
      try {
        if (output(commands.command(args, 30_000), args).trim() !== '')
          throw new Error(`Owned ${String(args[0])} remains after retirement (${labels})`);
      } catch (error) {
        failures.push(error);
      }
    }
  }
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
  // Announced before any case output: an operator still finds the journal after SIGKILL.
  options.stderr(`test:stack run directory ${runDir}\n`);
  /** @type {CaseOutcome | undefined} */
  let outcome;
  try {
    outcome = await options.spawnCases(
      { ...options.env, DSH_TEAM_CI_RESOURCE_JOURNAL: journal },
      options.repositoryRoot,
    );
  } catch {
    outcome = undefined;
  }
  const status = outcome === undefined ? 1 : caseStatus(outcome);
  if (outcome?.settled !== true) {
    // A live group member may still register or create: neither read nor retire the journal.
    options.stderr(`test:stack case processes unsettled; journal retained at ${runDir}\n`);
    return status || 1;
  }
  /** @type {unknown[]} */
  const failures = [];
  const retirement = {
    command: commands.command,
    commandAsync: commands.commandAsync,
    // The local lane sets no DSH_TEAM_VERIFICATION_SUBMISSIONS: there is no submission ledger.
    requireSettled: () => undefined,
    acquireLock: options.acquireLock,
  };
  try {
    const entries = readCleanupJournal(journal);
    await options.retire(entries, retirement, failures);
    requireEmptyInventory(commands, entries, failures);
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
 * Launches the vitest entry directly under this Node, without a pnpm hop, as the leader of its
 * own process group: forks-pool workers, docker CLI children and the deployment lock holder are
 * its members. SIGINT/SIGTERM are forwarded to the whole group until it settles, not only until
 * vitest closes; settlement is vitest's own `close` followed by the bounded ESRCH-only group
 * observation. An unsettled group is reported, never inferred settled.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {{file: string, args: string[]}} [launch]
 * @returns {Promise<CaseOutcome>}
 */
export async function spawnCases(env, cwd, launch) {
  const { file, args } = launch ?? {
    file: process.execPath,
    args: [join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'stack'],
  };
  const child = spawn(file, args, { cwd, env, stdio: 'inherit', detached: true });
  /** @type {NodeJS.Signals | undefined} */
  let interrupted;
  let failed = false;
  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => {
    interrupted ??= signal;
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // Darwin answers EPERM for a group of unreaped zombies: like ESRCH, the interruption stays
      // recorded and the bounded group observation alone decides settlement.
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.once('error', () => (failed = true));
  try {
    /** @type {[number | null, NodeJS.Signals | null]} */
    const [code, signal] = await new Promise((done) => {
      child.once('close', (...closed) => done(closed));
    });
    // No pid means no process, hence no group, was ever created.
    const settled = child.pid === undefined || (await groupSettlesAfterClose(child.pid));
    if (interrupted !== undefined) return { code: null, signal: interrupted, settled };
    return failed ? { code: 1, signal: null, settled } : { code, signal, settled };
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
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
    probeFonts,
    probePython,
    probeChromium,
    spawnCases: (env, cwd) => spawnCases(env, cwd),
    retire: retireCleanupJournal,
    acquireLock: () => acquireDeploymentLock(),
    stderr: (text) => process.stderr.write(text),
  });
}

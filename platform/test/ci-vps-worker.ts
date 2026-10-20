import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readReceipt, rescueChrome, writeReceipt } from '../../scripts/probe-browser-runtime.mjs';
import { retireAcquisition, stopOwnedUnit } from '../../scripts/ci-vps-units.mjs';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
import { admitVpsIdentity } from './ci-vps-identity.ts';
import type { VpsApproval } from './ci-vps-identity.ts';
import { cleanupTargets, readCleanupJournal, removeOwned } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import type { DockerCommand } from './docker-command.ts';

const [mode, invocation] = process.argv.slice(2);
if (
  process.platform !== 'linux' ||
  process.getuid?.() === 0 ||
  !/^[a-f0-9-]{36}$/.test(invocation ?? '')
)
  throw new Error('Trusted nonroot VPS invocation required');
const id = invocation ?? '';
const root = join(homedir(), '.local/share/dsh-team/ci', id);
const unit = `dsh-team-ci-${id}-run`;
const source = join(root, 'checkout');
// The pinned VPS home plus this child keeps browser AF_UNIX paths below Linux's 108-byte bound.
const temporary = join(root, 'tmp');
const path = `${dirname(process.execPath)}:${homedir()}/.local/share/dsh-team/toolchain/pnpm-10.34.6/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`;
const environment = {
  PATH: path,
  HOME: homedir(),
  TMPDIR: temporary,
  XDG_RUNTIME_DIR: `/run/user/${String(process.getuid?.())}`,
};
const docker: DockerCommand = (args, timeout) =>
  spawnSync('docker', [...args], {
    env: { PATH: path, DOCKER_CONFIG: join(root, 'docker-config'), ...dockerProxyEnvironment() },
    encoding: 'utf8',
    timeout,
    maxBuffer: 1_048_576,
  });

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function privateJson(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 16_384
  )
    throw new Error('Invalid private invocation record');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid invocation record');
  // The envelope is checked; consumers validate every identity/state field.
  return value as Record<string, unknown>;
}

async function approval(): Promise<VpsApproval> {
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Untrusted invocation directory');
  const value = await privateJson(join(root, 'approval.json'));
  for (const field of [
    'repository',
    'repositoryId',
    'ownerId',
    'actorId',
    'sha',
    'workflowSha',
    'ref',
    'workflowRef',
    'audience',
  ])
    if (typeof value[field] !== 'string' || value[field].length === 0)
      throw new Error('Invalid approval');
  if (
    value.repository !== 'DankerMu/dsh-team' ||
    typeof value.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sha)
  )
    throw new Error('Unapproved repository revision');
  if (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt))
    throw new Error('Invalid expiry');
  // Every required field is checked above; approval is operator-owned, never an SSH input.
  return value as unknown as VpsApproval;
}

function command(binary: string, args: string[], cwd = source, timeout = 600_000) {
  const result = spawnSync(binary, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16_777_216,
  });
  if (result.status !== 0 || result.error) throw new Error('Approved verification command failed');
  process.stdout.write(result.stdout);
}

async function execute() {
  const approved = await approval();
  // This cgroup is installed before admission. Serve can release it, never recreate it after retirement.
  while (!(await exists(join(root, 'admitted.json')))) {
    if (Date.now() >= approved.expiresAt * 1000 || (await exists(join(root, 'cancel'))))
      throw new Error('Unadmitted execution expired');
    await delay(250);
  }
  if ((await exists(join(root, 'cancel'))) || (await exists(join(root, 'final.json'))))
    throw new Error('Execution already retiring');
  await mkdir(source, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  command('git', ['init', '--quiet']);
  command('git', ['remote', 'add', 'origin', 'https://github.com/DankerMu/dsh-team.git']);
  command('git', ['fetch', '--quiet', '--depth=1', 'origin', approved.sha]);
  command('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    env: environment,
    encoding: 'utf8',
  });
  if (head.status !== 0 || head.stdout.trim() !== approved.sha)
    throw new Error('Checkout identity mismatch');
  command('pnpm', ['install', '--frozen-lockfile']);
  command('pnpm', ['build']);
  const driver = `const {spawnSync}=require('node:child_process');
const env={}; for(const name of ['PATH','HOME','TMPDIR','CHROME_BIN','DSH_TEAM_CI_RESOURCE_JOURNAL','DSH_TEAM_CI_INVOCATION']) env[name]=process.env[name];
process.loadEnvFile(${JSON.stringify(join(homedir(), '.config/dsh-team/env'))});
const key=process.env.DMXAPI_KEY; if(key) env.DMXAPI_KEY=key;
const r=spawnSync('pnpm',['test:model'],{env,encoding:'utf8',maxBuffer:16777216});
for(const [stream,text] of [[process.stdout,r.stdout],[process.stderr,r.stderr]]) stream.write(key?(text??'').replaceAll(key,'[REDACTED]'):(text??''));
process.exit(r.status??1);`;
  const result = spawnSync(process.execPath, ['-e', driver], {
    cwd: source,
    env: {
      ...environment,
      CHROME_BIN: join(
        homedir(),
        '.local/share/dsh-team/toolchain/chrome-140.0.7339.82/chrome-headless-shell-linux64/chrome-headless-shell',
      ),
      DSH_TEAM_CI_RESOURCE_JOURNAL: join(root, 'resources.jsonl'),
      DSH_TEAM_CI_INVOCATION: id,
    },
    encoding: 'utf8',
    maxBuffer: 16_777_216,
  });
  process.exitCode = result.status ?? 1;
  await writeFile(join(root, 'execution.log'), `${result.stdout}\n${result.stderr}`, {
    mode: 0o600,
  });
}

async function bearer() {
  let text = '';
  const timer = setTimeout(
    () => process.stdin.destroy(new Error('Admission input deadline')),
    15_000,
  );
  try {
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 16_385) throw new Error('Admission input too large');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function signingKeys(): Promise<unknown[]> {
  const response = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks', {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body) throw new Error('Trusted signing keys unavailable');
  let text = '';
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString('utf8');
    if (text.length > 262_144) throw new Error('Signing keys exceed bound');
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('keys' in value) ||
    !Array.isArray(value.keys)
  )
    throw new Error('Invalid signing keys');
  const keys: unknown[] = value.keys;
  return keys;
}

async function awaitFinal(timeout = 1_200_000) {
  const until = Date.now() + timeout;
  while (!(await exists(join(root, 'final.json'))) && Date.now() < until) await delay(500);
  return privateJson(join(root, 'final.json'));
}

async function serve() {
  if (process.env.SSH_ORIGINAL_COMMAND !== 'verify')
    throw new Error('Command substitution rejected');
  const approved = await approval();
  const identity = admitVpsIdentity(await bearer(), approved, await signingKeys());
  if ((await exists(join(root, 'cancel'))) || (await exists(join(root, 'final.json'))))
    throw new Error('Admission closed');
  await mkdir(join(root, 'claimed'), { mode: 0o700 });
  await writeReceipt(join(root, 'admitted.json'), { ...identity, startedAt: Date.now() });
  const final = await awaitFinal();
  if (await exists(join(root, 'execution.log')))
    process.stdout.write(await readFile(join(root, 'execution.log'), 'utf8'));
  if (final.vpsCleanupComplete !== true || final.exitCode !== 0)
    throw new Error('Execution or cleanup failed');
  process.stdout.write(
    `${JSON.stringify({ ...identity, sha: approved.sha, command: 'pnpm test:model', exitCode: 0, vpsCleanupComplete: true })}\n`,
  );
}

async function removeAuthorization() {
  if (!(await exists(join(root, 'authorization-line')))) return;
  const selected = (await readFile(join(root, 'authorization-line'), 'utf8')).trim();
  if (!selected.startsWith('restrict,') || !selected.endsWith(`dsh-team-ci-${id}`))
    throw new Error('Invalid authorization owner');
  const key = / ssh-ed25519 [A-Za-z0-9+/=]+/.exec(selected)?.[0];
  if (!key) throw new Error('Invalid authorization public-key identity');
  const ownsLine = (line: string) =>
    (line.endsWith(key) || line.includes(`${key} `)) && line.includes(` serve ${id}"`);
  const file = join(homedir(), '.ssh/authorized_keys');
  const before = await lstat(file);
  if (!before.isFile()) throw new Error('Invalid authorized keys identity');
  const content = await readFile(file, 'utf8');
  const lines = content.split('\n');
  if (!lines.some(ownsLine)) return;
  const replacement = join(dirname(file), `dsh-team-ci-${id}`);
  await writeFile(replacement, lines.filter((line) => !ownsLine(line)).join('\n'), {
    flag: 'wx',
    mode: before.mode & 0o777,
  });
  try {
    const current = await lstat(file);
    if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs)
      throw new Error('Concurrent authorization edit');
    await rename(replacement, file);
  } finally {
    await rm(replacement, { force: true });
  }
}

function stopExecution() {
  stopOwnedUnit(unit, `dsh-team-ci:${id}`);
}

async function rescueBrowserImage(directory: string) {
  const imageFile = join(directory, 'image.json');
  if (!(await exists(imageFile))) return;
  const image = await privateJson(imageFile);
  if (
    typeof image.tag !== 'string' ||
    typeof image.invocation !== 'string' ||
    image.tag !== `dsh-team-browser-runtime-${image.invocation}` ||
    typeof image.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(image.imageId)
  )
    throw new Error('Invalid browser image receipt');
  const exact = docker(['image', 'inspect', image.imageId], 30_000);
  if (isAbsentResource(exact, 'image', image.imageId)) return;
  const tagged = docker(['image', 'inspect', '--format', '{{.Id}}', image.tag], 30_000);
  if (
    exact.error ||
    exact.status !== 0 ||
    tagged.error ||
    tagged.status !== 0 ||
    tagged.stdout.trim() !== image.imageId
  )
    throw new Error('Browser image rescue identity unconfirmed');
  removeOwned(docker, 'image', image.imageId, image.invocation, {
    'dsh-team.browser-invocation': image.invocation,
  });
}

async function rescueBrowsers() {
  if (!(await exists(temporary))) return;
  for (const name of await readdir(temporary)) {
    if (!name.startsWith('dsh-browser-command-')) continue;
    const directory = join(temporary, name);
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Invalid browser receipt directory');
    process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = directory;
    process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG = join(directory, 'docker');
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.launch.json')) continue;
      const receipt = join(directory, file);
      const pointer = await readReceipt(receipt);
      if (
        typeof pointer.receiptFile !== 'string' ||
        !resolve(pointer.receiptFile).startsWith(`${temporary}/`)
      )
        throw new Error('Browser receipt escaped invocation');
      await rescueChrome(
        pointer.state === 'stopped' ? receipt : pointer.receiptFile,
        typeof pointer.nonce === 'string' ? pointer.nonce : undefined,
      );
      retireAcquisition(id, pointer.nonce);
    }
    await rescueBrowserImage(directory);
  }
}

async function performFinalization() {
  const failures: string[] = [];
  const attempt = async (phase: string, action: () => void | Promise<void>) => {
    try {
      await action();
    } catch {
      failures.push(phase);
    }
  };
  await attempt('authorization', removeAuthorization);
  await attempt('execution-cgroup', stopExecution);
  await attempt('browser-rescue', rescueBrowsers);
  await attempt('docker-rescue', async () => {
    const journal = join(root, 'resources.jsonl');
    if (!(await exists(journal))) return;
    const entries = readCleanupJournal(journal);
    const errors: unknown[] = [];
    for (const runId of new Set(entries.map((entry) => entry.runId)))
      cleanupTargets(
        docker,
        entries.filter((entry) => entry.runId === runId).map((entry) => entry.target),
        runId,
        errors,
      );
    if (errors.length) throw new Error('Owned resource retirement failed');
  });
  await attempt('evidence', async () => {
    const evidence = join(source, '.run/issue82');
    if (await exists(evidence)) await cp(evidence, join(root, 'evidence'), { recursive: true });
  });
  if (!failures.length) {
    await attempt('temporary-files', async () => {
      await rm(temporary, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    });
  }
  const execution = (await exists(join(root, 'execution.json')))
    ? await privateJson(join(root, 'execution.json'))
    : { exitCode: 1 };
  await writeReceipt(join(root, 'final.json'), {
    vpsCleanupComplete: failures.length === 0,
    failures,
    exitCode: execution.exitCode,
  });
  if (failures.length) throw new Error('Independent VPS finalization failed');
}

async function finalizeLocked() {
  if (await exists(join(root, 'final.json'))) {
    if ((await privateJson(join(root, 'final.json'))).vpsCleanupComplete !== true)
      throw new Error('Prior finalization failed; authority retained for explicit recovery');
    return;
  }
  await writeFile(join(root, 'cancel'), '', { mode: 0o600 });
  await performFinalization();
}

function finalize() {
  const result = spawnSync(
    'flock',
    [
      '--wait',
      '190',
      join(root, 'lifecycle.lock'),
      process.execPath,
      process.argv[1] ?? '',
      'finalize-locked',
      id,
    ],
    { env: environment, encoding: 'utf8', timeout: 200_000, maxBuffer: 16_384 },
  );
  if (result.error || result.status !== 0) throw new Error('Serialized VPS finalization failed');
}

async function watch() {
  const approved = await approval();
  for (;;) {
    if (await exists(join(root, 'cancel'))) break;
    if (await exists(join(root, 'execution.json'))) break;
    if (await exists(join(root, 'admitted.json'))) {
      const admitted = await privateJson(join(root, 'admitted.json'));
      if (typeof admitted.startedAt !== 'number' || Date.now() > admitted.startedAt + 1_020_000)
        break;
    } else if (Date.now() >= approved.expiresAt * 1000) break;
    await delay(500);
  }
  finalize();
}

async function executeAndRecord() {
  try {
    await execute();
  } catch {
    process.exitCode = 1;
  } finally {
    await writeReceipt(join(root, 'execution.json'), { exitCode: Number(process.exitCode ?? 0) });
  }
}

try {
  if (mode === 'serve') await serve();
  else if (mode === 'execute') await executeAndRecord();
  else if (mode === 'finalize') finalize();
  else if (mode === 'finalize-locked') await finalizeLocked();
  else if (mode === 'watch') await watch();
  else if (mode === 'await' || mode === 'await-retirement')
    process.stdout.write(
      `${JSON.stringify(await awaitFinal(mode === 'await' ? 1_800_000 : 180_000))}\n`,
    );
  else throw new Error('Unknown VPS execution mode');
} catch {
  process.stderr.write('Trusted VPS execution failed; inspect private sanitized receipt\n');
  process.exitCode = 1;
}

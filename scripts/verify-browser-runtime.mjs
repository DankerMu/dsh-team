/** Root-command provisioning. Never called by ordinary native integration tests. */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeDigest, readReceipt, rescueChrome } from './probe-browser-runtime.mjs';
import { startChrome } from './probe-dsh-api-cdp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = {
  docker: ['pnpm', ['exec', 'vitest', 'run', '--project', 'docker']],
  'dsh-api': ['bash', [join(root, 'scripts/probe-dsh-api.sh')]],
  'first-run': ['bash', [join(root, 'scripts/probe-first-run.sh')]],
};
const command = commands[process.argv[2]];
const forwardedArguments = process.argv.slice(3);
if (command) command[1].push(...forwardedArguments);
let status = 1;
let buildStarted = false;
let directory;
let imageId;
let child;
let interrupted = false;
const invocation = randomUUID();
const tag = `dsh-team-browser-runtime-${invocation}`;
const environment = () => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  DOCKER_CONFIG: join(directory, 'docker'),
});
function docker(args, ms = 30000, build = false) {
  const result = spawnSync('docker', args, {
    cwd: root,
    env: environment(),
    encoding: 'utf8',
    timeout: ms,
    killSignal: 'SIGKILL',
    maxBuffer: build ? 16 * 1024 * 1024 : 65536,
  });
  if (result.error || result.status !== 0) throw new Error('browser runtime provisioning failed');
  return result.stdout.trim();
}
function runVerificationChild(env) {
  return new Promise((done, reject) => {
    child = spawn(command[0], command[1], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      done(signal ? (signal === 'SIGINT' ? 130 : 143) : (code ?? 1)),
    );
  });
}

function requireLocalRuntime() {
  if (!command) throw new Error('usage: verify-browser-runtime.mjs docker|dsh-api|first-run');
  if (platform() !== 'linux' || arch() !== 'x64' || process.getuid() === 0)
    throw new Error('browser isolation requires trusted nonroot Linux amd64');
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    throw new Error('browser isolation requires the local default Docker daemon');
}

async function prepare() {
  requireLocalRuntime();
  directory = await mkdtemp(join(tmpdir(), 'dsh-browser-command-'));
  const daemon = JSON.parse(docker(['info', '--format', '{{json .}}']));
  if (
    daemon.OSType !== 'linux' ||
    !['x86_64', 'amd64'].includes(daemon.Architecture) ||
    daemon.SecurityOptions?.some((value) => /rootless|userns/.test(value))
  )
    throw new Error('browser isolation requires qualified local Linux Docker UID mapping');
  if (!process.env.CHROME_BIN)
    throw new Error('CHROME_BIN must select pinned CfT 140.0.7339.82 chrome-headless-shell');
  const bin = await realpath(process.env.CHROME_BIN);
  if (!bin.endsWith('/chrome-headless-shell'))
    throw new Error(
      'browser isolation requires the complete pinned CfT headless-shell distribution',
    );
  const sha256 = await chromeDigest(bin);
  await readFile(join(dirname(bin), 'deb.deps'));
  const context = join(directory, 'build-context');
  await mkdir(context, { mode: 0o700 });
  await copyFile(
    join(root, 'scripts/probe-browser-runtime.mjs'),
    join(context, 'probe-browser-runtime.mjs'),
  );
  await copyFile(
    join(root, 'scripts/probe-browser-native.mjs'),
    join(context, 'probe-browser-native.mjs'),
  );
  await copyFile(
    join(root, 'scripts/probe-browser-receipt.mjs'),
    join(context, 'probe-browser-receipt.mjs'),
  );
  await writeFile(
    join(directory, 'image.json'),
    JSON.stringify({ invocation, tag, imageId: null, state: 'build-submitting' }),
    { mode: 0o600 },
  );
  buildStarted = true;
  docker(
    [
      'build',
      '--label',
      `dsh-team.browser-invocation=${invocation}`,
      '--build-context',
      `browser-runtime=${context}`,
      '-t',
      tag,
      '-f',
      join(root, 'images/browser-verification/Dockerfile'),
      join(root, 'images/browser-verification'),
    ],
    600000,
    true,
  );
  imageId = docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error('browser runtime immutable image ID missing');
  await writeFile(
    join(directory, 'image.json'),
    JSON.stringify({ invocation, tag, imageId, state: 'built' }),
    { mode: 0o600 },
  );
  process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG = environment().DOCKER_CONFIG;
  process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = directory;
  const qualification = await startChrome({
    runtime: {
      kind: 'docker-network-none',
      imageId,
      chromeDirectory: dirname(bin),
      chromeSha256: sha256,
      runId: invocation,
    },
    origin: 'http://127.0.0.1:12345',
    profile: join(directory, 'qualification-profile'),
    receiptFile: join(directory, 'qualification.receipt.json'),
  });
  await qualification.stop();
  if (interrupted) throw new Error('browser runtime invocation interrupted');
  const identities = {
    invocation,
    imageId,
    base: 'sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2',
    chromeVersion: '140.0.7339.82',
    chromeSha256: sha256,
    uid: process.getuid(),
    gid: process.getgid(),
  };
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(identities), { mode: 0o600 });
  process.stdout.write(
    `browser runtime image=${imageId} Chrome=140.0.7339.82 sha256=${sha256} receipt=${join(directory, 'runtime.json')}\n`,
  );
  const env = {
    ...process.env,
    CHROME_BIN: bin,
    DSH_TEAM_BROWSER_RUNTIME: 'docker-network-none',
    DSH_TEAM_BROWSER_IMAGE_ID: imageId,
    DSH_TEAM_BROWSER_CHROME_SHA256: sha256,
    DSH_TEAM_BROWSER_DOCKER_CONFIG: environment().DOCKER_CONFIG,
    DSH_TEAM_BROWSER_RECEIPT_DIRECTORY: directory,
    DSH_TEAM_BROWSER_INVOCATION: invocation,
  };
  status = await runVerificationChild(env);
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    interrupted = true;
    status = code;
    child?.kill(signal);
  });
}
async function rescueRegistration(name) {
  const pointerPath = join(directory, name);
  const pointer = await readReceipt(pointerPath);
  if (pointer.kind !== 'docker-network-none' || typeof pointer.receiptFile !== 'string')
    throw new Error('browser registered receipt identity invalid');
  await rescueChrome(
    pointer.state === 'stopped' ? pointerPath : pointer.receiptFile,
    pointer.nonce,
  );
}

async function cleanup() {
  if (!directory) return;
  let complete = true;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.launch.json')) continue;
    try {
      await rescueRegistration(name);
    } catch {
      complete = false;
    }
  }
  if (!buildStarted) return;
  try {
    const selected = imageId ?? docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
    const owner = docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "dsh-team.browser-invocation"}}',
      selected,
    ]);
    if (owner !== invocation) throw new Error('browser image cleanup identity mismatch');
    if (docker(['image', 'inspect', '--format', '{{.Id}}', tag]) !== selected)
      throw new Error('browser image tag identity changed');
    if (complete) docker(['image', 'rm', selected]);
  } catch {
    complete = false;
  }
  if (!complete) {
    if (status === 0) status = 1;
    process.stderr.write(`browser cleanup incomplete; private receipts retained at ${directory}\n`);
  }
}
try {
  if (command && forwardedArguments.some((value) => value === '--help' || value === '-h'))
    status = await runVerificationChild(process.env);
  else await prepare();
} catch (error) {
  const known = [
    'usage: verify-browser-runtime.mjs docker|dsh-api|first-run',
    'browser isolation requires trusted nonroot Linux amd64',
    'browser isolation requires the local default Docker daemon',
    'browser isolation requires qualified local Linux Docker UID mapping',
    'CHROME_BIN must select pinned CfT 140.0.7339.82 chrome-headless-shell',
    'browser isolation requires the complete pinned CfT headless-shell distribution',
    'browser runtime provisioning failed',
    'browser runtime immutable image ID missing',
    'browser runtime invocation interrupted',
  ];
  process.stderr.write(
    `${known.includes(error.message) ? error.message : 'browser runtime invocation failed; inspect private lifecycle receipts'}\n`,
  );
  if (!interrupted) status = 1;
} finally {
  await cleanup();
}
// Runtime identities and bounded lifecycle receipts intentionally remain durable.
process.exitCode = status;

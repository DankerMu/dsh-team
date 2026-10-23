/** Root-command provisioning. Never called by ordinary native integration tests. */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeDigest, readReceipt, rescueChrome, writeReceipt } from './probe-browser-runtime.mjs';
import { connectPage, startChrome } from './probe-dsh-api-cdp.mjs';
import { qualifyBrowserConfinement } from './probe-browser-confinement.mjs';
import { qualificationDiagnostic, qualificationError } from './probe-browser-qualification.mjs';
import { dockerProxyEnvironment } from './docker-proxy-environment.mjs';
import { buildFailureDiagnostic } from './docker-build-diagnostics.mjs';
import { prepareVerificationImage } from './verification-image.mjs';
import { runDockerCommand, selectDockerExecution } from './docker-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = {
  docker: ['pnpm', ['exec', 'vitest', 'run', '--project', 'docker']],
  model: ['pnpm', ['exec', 'vitest', 'run', '--project', 'model']],
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
let imageFailure;
let imageCleanup;
let child;
let interrupted = false;
let qualificationEvidence;
const invocation = randomUUID();
const tag = `dsh-team-browser-runtime-${invocation}`;
const environment = () => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  DOCKER_CONFIG: join(directory, 'docker'),
  ...dockerProxyEnvironment(),
});
function docker(args, ms = 30000, build = false) {
  const started = build ? performance.now() : undefined;
  const result = dockerResult(args, ms, build);
  if (result.error || result.status !== 0) {
    if (build)
      imageFailure = { phase: 'image-build', ...buildFailureDiagnostic(result, ms, started) };
    throw new Error('browser runtime provisioning failed');
  }
  return result.stdout.trim();
}
function dockerResult(args, ms, build = false) {
  return runDockerCommand(selectDockerExecution(args), (execution) =>
    spawnSync(execution.file, execution.args, {
      cwd: root,
      env: environment(),
      encoding: 'utf8',
      timeout: ms,
      killSignal: 'SIGKILL',
      maxBuffer: build ? 16 * 1024 * 1024 : 65536,
    }),
  );
}
async function publishImageReceipt() {
  const path = join(directory, 'image.json');
  try {
    await writeReceipt(path, {
      invocation,
      tag,
      imageId: imageId ?? null,
      state: imageFailure ? 'build-failed' : imageId ? 'built' : 'build-submitting',
      ...(imageFailure ? { failure: imageFailure } : {}),
      ...(imageCleanup ? { cleanup: imageCleanup } : {}),
    });
    return true;
  } catch {
    if (status === 0) status = 1;
    process.stderr.write(`browser image evidence unavailable; expected-receipt=${path}\n`);
    return false;
  }
}

function runVerificationChild(env) {
  if (interrupted) throw new Error('browser runtime invocation interrupted');
  return new Promise((done, reject) => {
    child = spawn(command[0], command[1], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      done(interrupted ? status : signal ? (signal === 'SIGINT' ? 130 : 143) : (code ?? 1)),
    );
  });
}

function requireLocalRuntime() {
  if (!command) throw new Error('usage: verify-browser-runtime.mjs docker|model|dsh-api|first-run');
  if (platform() !== 'linux' || arch() !== 'x64' || process.getuid() === 0)
    throw new Error('browser isolation requires trusted nonroot Linux amd64');
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    throw new Error('browser isolation requires the local default Docker daemon');
}

async function qualifyRuntime(chrome) {
  let page;
  let proof;
  let failure;
  const cleanupErrors = [];
  try {
    qualificationEvidence.enter('page-attach');
    page = await connectPage(chrome.browserWs);
    qualificationEvidence.enter('online-evaluate');
    const result = await page.send('Runtime.evaluate', {
      expression: 'navigator.onLine',
      returnByValue: true,
    });
    qualificationEvidence.enter('online-invariant');
    if (result?.result?.value !== true)
      throw qualificationError('BROWSER_OFFLINE', 'online-invariant');
    proof = {
      ...(await qualifyBrowserConfinement(
        await readReceipt(join(directory, 'qualification.receipt.json')),
        qualificationEvidence,
      )),
      naturallyOnline: true,
    };
  } catch (error) {
    qualificationEvidence.fail(error);
    failure = { error };
  }
  try {
    qualificationEvidence.enter('page-cleanup');
    page?.close();
  } catch (error) {
    cleanupErrors.push(error);
    qualificationEvidence.cleanup(error, 'page-cleanup');
  }
  try {
    qualificationEvidence.enter('chrome-cleanup');
    await chrome.stop();
  } catch (error) {
    cleanupErrors.push(error);
    qualificationEvidence.cleanup(error, 'chrome-cleanup');
  }
  if (failure) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [failure.error, ...cleanupErrors],
        'browser qualification and cleanup failed',
        {
          cause: failure.error,
        },
      );
    throw failure.error;
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'browser qualification cleanup failed');
  return proof;
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
  await copyFile(join(root, 'scripts/byte-listener.mjs'), join(context, 'byte-listener.mjs'));
  await copyFile(
    join(root, 'scripts/probe-browser-native.mjs'),
    join(context, 'probe-browser-native.mjs'),
  );
  await copyFile(
    join(root, 'scripts/probe-browser-receipt.mjs'),
    join(context, 'probe-browser-receipt.mjs'),
  );
  await copyFile(
    join(root, 'scripts/probe-browser-network.mjs'),
    join(context, 'probe-browser-network.mjs'),
  );
  await copyFile(
    join(root, 'scripts/docker-proxy-environment.mjs'),
    join(context, 'docker-proxy-environment.mjs'),
  );
  const artifact = prepareVerificationImage(
    'browser',
    tag,
    { 'dsh-team.browser-invocation': invocation },
    directory,
    dockerResult,
  );
  for (const file of [
    'docker-command.mjs',
    'verification-submissions.mjs',
    'verification-submission-storage.mjs',
  ]) {
    await copyFile(join(root, 'scripts', file), join(context, file));
  }
  if (!(await publishImageReceipt())) throw new Error('browser image evidence unavailable');
  buildStarted = true;
  docker(
    artifact?.args ?? [
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
  artifact?.verify(imageId);
  if (!(await publishImageReceipt())) throw new Error('browser image evidence unavailable');
  process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG = environment().DOCKER_CONFIG;
  process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = directory;
  qualificationEvidence = qualificationDiagnostic(invocation);
  qualificationEvidence.enter('browser-launch');
  const qualification = await startChrome({
    runtime: {
      kind: 'docker-isolated-network',
      imageId,
      chromeDirectory: dirname(bin),
      chromeSha256: sha256,
      runId: invocation,
    },
    origin: 'http://127.0.0.1:12345',
    profile: join(directory, 'qualification-profile'),
    receiptFile: join(directory, 'qualification.receipt.json'),
  });
  const confinement = await qualifyRuntime(qualification);
  qualificationEvidence = undefined;
  if (interrupted) throw new Error('browser runtime invocation interrupted');
  const identities = {
    invocation,
    imageId,
    base: 'sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2',
    chromeVersion: '140.0.7339.82',
    chromeSha256: sha256,
    uid: process.getuid(),
    gid: process.getgid(),
    confinement,
  };
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(identities), { mode: 0o600 });
  process.stdout.write(
    `browser runtime image=${imageId} Chrome=140.0.7339.82 sha256=${sha256} receipt=${join(directory, 'runtime.json')}\n`,
  );
  const env = {
    ...process.env,
    CHROME_BIN: bin,
    DSH_TEAM_BROWSER_RUNTIME: 'docker-isolated-network',
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
    if (!interrupted) {
      interrupted = true;
      status = code;
    }
    child?.kill(signal);
  });
}
async function rescueRegistration(name) {
  const pointerPath = join(directory, name);
  const pointer = await readReceipt(pointerPath);
  if (pointer.kind !== 'docker-isolated-network' || typeof pointer.receiptFile !== 'string')
    throw new Error('browser registered receipt identity invalid');
  await rescueChrome(
    pointer.state === 'stopped' ? pointerPath : pointer.receiptFile,
    pointer.nonce,
  );
}

function verifiedImageIdentity() {
  const selected = imageId ?? docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (!/^sha256:[a-f0-9]{64}$/.test(selected))
    throw new Error('browser image cleanup immutable identity missing');
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
  return selected;
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
  imageCleanup = {
    browserResources: complete ? 'confirmed' : 'unconfirmed',
    image: 'ownership-unconfirmed',
  };
  try {
    const selected = verifiedImageIdentity();
    imageId = selected;
    imageCleanup.image = 'blocked';
    if (complete && (await publishImageReceipt())) {
      // Receipt publication yields; ownership must still hold at the removal boundary.
      imageCleanup.image = 'ownership-unconfirmed';
      verifiedImageIdentity();
      imageCleanup.image = 'removal-failed';
      docker(['image', 'rm', selected]);
      imageCleanup.image = 'confirmed';
    }
  } catch {
    // The reached boundary distinguishes unconfirmed ownership from a failed authorized removal.
  }
  await publishImageReceipt();
  if (!complete || imageCleanup.image !== 'confirmed') {
    if (status === 0) status = 1;
    const outcome =
      imageCleanup.image === 'ownership-unconfirmed' ? 'ownership unconfirmed' : 'incomplete';
    process.stderr.write(`browser cleanup ${outcome}; private receipts retained at ${directory}\n`);
  }
}
async function persistQualificationFailure(error) {
  const path = join(directory, 'qualification.failure.json');
  try {
    qualificationEvidence.fail(error);
    await writeReceipt(path, qualificationEvidence.snapshot(error));
    process.stderr.write(`browser qualification failed; receipt=${path}\n`);
  } catch (evidenceError) {
    const selected = qualificationDiagnostic(invocation);
    selected.enter('evidence-write');
    selected.fail(evidenceError);
    const code = selected.snapshot(evidenceError).primary.root.code;
    process.stderr.write(
      `browser qualification evidence unavailable code=${code}; expected-receipt=${path}\n`,
    );
  }
}

try {
  if (process.argv[2] === 'model' && !process.env.DMXAPI_KEY?.trim())
    throw new Error('DMXAPI_KEY is required for real-model verification');
  if (command && forwardedArguments.some((value) => value === '--help' || value === '-h'))
    status = await runVerificationChild(process.env);
  else await prepare();
} catch (error) {
  if (qualificationEvidence) await persistQualificationFailure(error);
  if (imageFailure && (await publishImageReceipt()))
    process.stderr.write(`browser image build failed; receipt=${join(directory, 'image.json')}\n`);
  const known = [
    'usage: verify-browser-runtime.mjs docker|model|dsh-api|first-run',
    'DMXAPI_KEY is required for real-model verification',
    'browser isolation requires trusted nonroot Linux amd64',
    'browser isolation requires the local default Docker daemon',
    'browser isolation requires qualified local Linux Docker UID mapping',
    'CHROME_BIN must select pinned CfT 140.0.7339.82 chrome-headless-shell',
    'browser isolation requires the complete pinned CfT headless-shell distribution',
    'browser runtime provisioning failed',
    'browser runtime immutable image ID missing',
    'browser image evidence unavailable',
    'browser runtime invocation interrupted',
    'Verification image artifact input rejected',
    'Verification image artifact identity mismatch',
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

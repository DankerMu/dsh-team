// Parent-side exact-head VPS lane: `pnpm lane:vps <label> <sha> <branch>` (run) and
// `pnpm lane:vps:post <pr> <label> [--note <text>]` (post, scripts/vps-lane-post.mjs).
// Run builds the images locally, uploads them with hashes to giap-vps, prepares a private
// staging directory, runs install/build, custody `pnpm test:docker`, then `pnpm test:deploy`,
// fences the host before and after, and records everything in .run/vps-lane/<label>/.
// It never removes, stops or cancels anything remotely; a transport failure is never a verdict.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CHROME_VERSION } from './verify-browser-runtime.mjs';
import { buildImages } from './vps-lane-build.mjs';
import { postLane } from './vps-lane-post.mjs';
import {
  capture,
  HOST,
  LABEL,
  labelState,
  laneFailures,
  LaneRefusal,
  repositoryRoot,
  runDirectory,
  SHA,
  summaryText,
  vitestCounts,
  writeSummary,
} from './vps-lane-record.mjs';
import { shellQuote as q, sha256File } from './vps-lane-remote.mjs';

const USAGE = 'usage: pnpm lane:vps <label> <sha> <branch>';
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30'];
const TOOLCHAIN = '.local/share/dsh-team/toolchain';
const HELPERS = ['vps-lane-remote.mjs', 'docker-proxy-environment.mjs'];
const UPLOADS = [
  'source.bundle',
  'user-image.tar',
  'platform-image.tar',
  'browser-image.tar',
  'lane.json',
  ...HELPERS,
];
// Seconds between attempts. DSH_TEAM_LANE_INTERVAL_MS replaces every interval (tests only).
const RETRY_S = 60;
const STATUS_S = 180;
const UNIT_S = 60;
// Consecutive transport failures before a remote state is UNKNOWN: two hours at RETRY_S.
const ATTEMPTS = 120;
// Custody start returns within its own 60 s admission plus SSH setup.
const LAUNCH_MS = 300_000;
const OBSERVER_CLOSE_MS = 30_000;
const SSH_MS = 120_000;
// Hashing, cloning and extracting the uploaded images on the host.
const PREPARE_MS = 3_600_000;
const TRANSFER_MS = 10_800_000;
const UNIT_DONE = new Set(['dead', 'exited', 'failed']);

const log = (message) =>
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);
const tail = (text) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .at(-1)
    ?.slice(-300) ?? '';

function stop(step, reason) {
  return Object.assign(new LaneRefusal(`${step} failed: ${reason}`), { step, reason });
}

function intervalOverride() {
  const value = process.env.DSH_TEAM_LANE_INTERVAL_MS;
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(value))
    throw new LaneRefusal('DSH_TEAM_LANE_INTERVAL_MS must be 1-999999 milliseconds', 2);
  return Number(value);
}

function readPins(root, sha) {
  const show = (path) =>
    spawnSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'utf8' }).stdout ?? '';
  const pin = (text, pattern, name, file) => {
    const value = pattern.exec(text)?.[1];
    if (!value || !/^[0-9A-Za-z.+-]+$/.test(value))
      throw new LaneRefusal(`pin missing: ${name} in ${file}`);
    return value;
  };
  const versions = show('.tool-versions');
  const ci = show('.github/workflows/ci.yml');
  return {
    node: pin(versions, /^nodejs[ \t]+(\S+)[ \t]*$/m, 'nodejs', '.tool-versions'),
    pnpm: pin(versions, /^pnpm[ \t]+(\S+)[ \t]*$/m, 'pnpm', '.tool-versions'),
    hurl: pin(
      ci,
      /^[ \t]*HURL_VERSION:[ \t]*"?([^"\s]+)"?[ \t]*$/m,
      'HURL_VERSION',
      '.github/workflows/ci.yml',
    ),
    chrome: CHROME_VERSION,
  };
}

/** Remote toolchain entries relative to the SSH session's HOME. */
const toolchainLayout = (pins) => ({
  node: `${TOOLCHAIN}/node-v${pins.node}-linux-x64/bin`,
  pnpm: `${TOOLCHAIN}/pnpm-${pins.pnpm}/node_modules/.bin`,
  hurl: `${TOOLCHAIN}/hurl-${pins.hurl}/usr/bin`,
  chrome: `${TOOLCHAIN}/chrome-${pins.chrome}/chrome-headless-shell-linux64/chrome-headless-shell`,
});

/** Argument grammar, label claim, branch and pins: all checked before any remote command. */
function admit(args) {
  const [label, sha, branch, ...extra] = args;
  if (
    extra.length ||
    !LABEL.test(label ?? '') ||
    !SHA.test(sha ?? '') ||
    !branch ||
    branch.startsWith('-')
  )
    throw new LaneRefusal(USAGE, 2);
  const interval = intervalOverride();
  const root = repositoryRoot();
  const dir = runDirectory(root, label);
  if (existsSync(dir))
    throw new LaneRefusal(`label ${label} already holds a ${labelState(dir)} run`);
  const at = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (at.stdout?.trim() !== sha) throw new LaneRefusal(`branch ${branch} is not at ${sha}`);
  const pins = readPins(root, sha);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    throw new LaneRefusal(`label ${label} was claimed concurrently`);
  }
  process.umask(0o022);
  const summary = {
    version: 1,
    label,
    head: sha,
    branch,
    state: 'running',
    pid: process.pid,
    failure: null,
    toolchain: pins,
  };
  const lane = { label, sha, branch, root, dir, interval, pins, summary, remoteStarted: false };
  writeSummary(dir, summary);
  return lane;
}

const save = (lane) => writeSummary(lane.dir, lane.summary);
const wait = (lane, seconds) => delay(lane.interval ?? seconds * 1000);
const ssh = (command, options = {}) =>
  spawnSync('ssh', [...SSH, HOST, command], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: SSH_MS,
    ...options,
  });
const remote = (lane, operation, ...args) =>
  [q(lane.node), q(`${lane.remoteRoot}/vps-lane-remote.mjs`), operation, ...args.map(q)].join(' ');

// ssh exits 255 for its own failures; a timeout or spawn error is transport too. Any other
// non-zero exit is the remote command's own answer and is not retried.
const transport = (result) =>
  result.error !== undefined || result.signal !== null || result.status === 255;
const miss = (result) => {
  const reason = tail(result.stderr) || `exit ${String(result.status)}`;
  return transport(result) ? { reason } : { answer: reason };
};

/**
 * Repeats `query` until it yields a value. `pending` waits `seconds` without counting; `reason`
 * is a transport failure, retried up to ATTEMPTS in a row; `answer` is final. Both misses end
 * in undefined (UNKNOWN or unavailable), never in a verdict.
 */
async function poll(lane, what, query, seconds = RETRY_S) {
  for (let failures = 0; ;) {
    const outcome = query();
    if ('value' in outcome) return outcome.value;
    if (outcome.answer !== undefined) {
      log(`${what} answered: ${outcome.answer}`);
      return undefined;
    }
    if (outcome.pending) {
      failures = 0;
      await wait(lane, seconds);
      continue;
    }
    failures += 1;
    if (failures >= ATTEMPTS) return undefined;
    log(`${what} failed (${failures}), retrying: ${outcome.reason}`);
    await wait(lane, RETRY_S);
  }
}

function remoteHome() {
  const result = ssh(`printf '%s' "$HOME"`);
  if (result.status !== 0)
    throw new LaneRefusal(`remote HOME unavailable over ssh: ${tail(result.stderr)}`);
  if (!/^\/[A-Za-z0-9._/-]+$/.test(result.stdout))
    throw new LaneRefusal('remote HOME is not a plain absolute path');
  return result.stdout;
}

function checkToolchain(layout) {
  const entries = Object.entries(layout);
  const paths = entries.map(([, path]) => q(path)).join(' ');
  const result = ssh(`cd && for p in ${paths}; do test -e "$p" || printf '%s\\n' "$p"; done`);
  if (result.status !== 0)
    throw new LaneRefusal(`remote toolchain check failed: ${tail(result.stderr)}`);
  const missing = new Set(result.stdout.split('\n').filter(Boolean));
  const named = entries
    .filter(([, path]) => missing.has(path))
    .map(([item, path]) => `${item} (~/${path})`);
  if (named.length) throw new LaneRefusal(`remote toolchain missing: ${named.join(', ')}`);
}

/** Everything before the first remote write; a failure here clears the whole run directory. */
async function preUpload(lane) {
  lane.home = remoteHome();
  const layout = toolchainLayout(lane.pins);
  checkToolchain(layout);
  lane.node = `${lane.home}/${layout.node}/node`;
  lane.build = join(lane.dir, 'build');
  log(`build images from ${lane.sha}`);
  const images = await buildImages({
    root: lane.root,
    sha: lane.sha,
    build: lane.build,
    run: randomUUID(),
  });
  lane.summary.images = images;
  capture('git', ['bundle', 'create', join(lane.build, 'source.bundle'), lane.branch], {
    cwd: lane.root,
  });
  writeFileSync(
    join(lane.build, 'lane.json'),
    JSON.stringify({ head: lane.sha, label: lane.label, toolchain: layout }),
  );
  for (const helper of HELPERS) copyFileSync(join(SCRIPTS, helper), join(lane.build, helper));
  const hashes = {};
  for (const name of UPLOADS)
    hashes[name] =
      images[name.replace('-image.tar', '')]?.sha256 ?? (await sha256File(join(lane.build, name)));
  writeFileSync(join(lane.build, 'hashes.json'), JSON.stringify(hashes));
  save(lane);
}

function upload(lane) {
  const staging = `${lane.home}/.local/share/dsh-team/verify`;
  lane.remoteRoot = `${staging}/${lane.label}-${randomBytes(4).toString('hex')}`;
  lane.summary.remoteRoot = lane.remoteRoot;
  lane.remoteStarted = true;
  save(lane);
  const made = ssh(`umask 077 && mkdir -p ${q(staging)} && mkdir ${q(lane.remoteRoot)}`);
  if (made.status !== 0) throw stop('upload', tail(made.stderr) || 'staging directory not created');
  log(`upload to ${HOST}:${lane.remoteRoot}`);
  const sent = spawnSync(
    'scp',
    ['-q', '-o', 'BatchMode=yes', ...UPLOADS, 'hashes.json', `${HOST}:${lane.remoteRoot}/`],
    {
      cwd: lane.build,
      encoding: 'utf8',
      timeout: TRANSFER_MS,
    },
  );
  if (sent.status !== 0)
    throw stop('upload', tail(sent.stderr) || `scp exit ${String(sent.status)}`);
  const prepared = ssh(remote(lane, 'prepare', lane.remoteRoot, lane.sha), { timeout: PREPARE_MS });
  if (prepared.status !== 0)
    throw stop('prepare', tail(prepared.stderr) || `exit ${String(prepared.status)}`);
  lane.summary.prepare = { verified: true };
  save(lane);
}

/** Reads one remote staging file (read-only `cat`), retrying transport failures. */
function fetchText(lane, name) {
  return poll(lane, `${name} read`, () => {
    const result = ssh(`cat ${q(`${lane.remoteRoot}/${name}`)}`);
    return result.status === 0 ? { value: result.stdout } : miss(result);
  });
}

async function runUnit(lane, kind, steps) {
  const name = `dsh-team-lane-${lane.label}-${kind}-${randomBytes(3).toString('hex')}`;
  log(`remote ${steps.join('+')} in user unit ${name}`);
  const started = ssh(remote(lane, 'unit', lane.remoteRoot, lane.sha, name, ...steps));
  if (started.status !== 0) return { reason: `unit not started: ${tail(started.stderr)}` };
  const state = await poll(
    lane,
    `unit ${name} state query`,
    () => {
      const result = ssh(remote(lane, 'unit-state', name));
      const value = result.stdout?.trim();
      if (result.status !== 0) return miss(result);
      if (!value) return { reason: 'empty unit state' };
      return UNIT_DONE.has(value) ? { value } : { pending: true };
    },
    UNIT_S,
  );
  if (state === undefined) return { reason: `unit ${name} state UNKNOWN` };
  const rows = (await fetchText(lane, 'steps.jsonl'))
    ?.split('\n')
    .filter(Boolean)
    .map((row) => JSON.parse(row));
  lane.summary.steps = rows ?? lane.summary.steps;
  return { rows: rows ?? [] };
}

async function installAndBuild(lane) {
  const { rows, reason } = await runUnit(lane, 'prep', ['install', 'build']);
  if (reason) throw stop('install', reason);
  for (const step of ['install', 'build']) {
    const row = rows.find((candidate) => candidate.step === step);
    if (row?.exit !== 0) throw stop(step, row ? `exit ${String(row.exit)}` : 'no exit record');
  }
  save(lane);
}

async function launchCustody(lane) {
  log('start custody pnpm test:docker with one observing SSH');
  const child = spawn('ssh', [...SSH, HOST, remote(lane, 'launch', lane.remoteRoot, lane.sha)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const start = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), LAUNCH_MS);
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready === true) resolve(message.start);
      } catch {
        // Only the helper's JSON ready line matters; other output is ignored.
      }
    });
    child.once('close', () => resolve(undefined));
    child.once('close', () => clearTimeout(timer));
  });
  return { child, start, stderr: () => tail(stderr) };
}

async function closeObserver(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), OBSERVER_CLOSE_MS);
  await closed;
  clearTimeout(timer);
}

function custodyStatus(lane, invocation) {
  return poll(
    lane,
    'custody status query',
    () => {
      const result = ssh(remote(lane, 'custody-status', lane.remoteRoot, invocation));
      let value;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        // Unparseable output is a transport failure, never a verdict.
      }
      if (result.status !== 0 || typeof value?.state !== 'string')
        return { reason: tail(result.stderr) || `exit ${String(result.status)}` };
      return value.state === 'running' ? { pending: true } : { value };
    },
    STATUS_S,
  );
}

async function fetchStdout(lane, invocation) {
  const file = join(lane.dir, 'custody-stdout.log');
  const fetched = await poll(lane, 'custody stdout fetch', () => {
    const output = openSync(file, 'w', 0o600);
    const result = spawnSync(
      'ssh',
      [...SSH, HOST, remote(lane, 'custody-logs', lane.remoteRoot, invocation)],
      {
        stdio: ['ignore', output, 'pipe'],
        encoding: 'utf8',
        timeout: PREPARE_MS,
      },
    );
    closeSync(output);
    return result.status === 0 ? { value: true } : miss(result);
  });
  if (!fetched) return;
  lane.summary.custody.stdoutSha256 = await sha256File(file);
  lane.summary.custody.tests = vitestCounts(readFileSync(file, 'utf8'));
}

async function custody(lane) {
  const observer = await launchCustody(lane);
  try {
    if (!observer.start) throw stop('custody-start', observer.stderr() || 'no ready line');
    const invocation = observer.start.invocation;
    lane.summary.custody = { invocation, state: 'running' };
    save(lane);
    log(`custody invocation ${invocation}`);
    const status = await custodyStatus(lane, invocation);
    if (status === undefined) {
      lane.summary.custody = { invocation, state: 'unknown', reason: 'custody status unreachable' };
      process.stderr.write(
        'lane:vps: custody status unreachable; state UNKNOWN, nothing removed\n',
      );
      return false;
    }
    writeFileSync(join(lane.dir, 'custody-status.json'), `${JSON.stringify(status, null, 2)}\n`);
    lane.summary.custody = {
      invocation,
      state: status.state,
      head: status.head,
      cleanup: status.cleanup?.state,
      command: status.command,
      interruption: status.interruption,
      failure: status.failure,
      statusStdoutSha256: status.output?.stdout?.sha256 ?? null,
      stdoutSha256: null,
      tests: null,
    };
    log(`custody state ${status.state}`);
    if (status.state !== 'passed' && status.state !== 'failed') return false;
    await fetchStdout(lane, invocation);
    return true;
  } finally {
    await closeObserver(observer.child);
  }
}

async function deployAndFence(lane) {
  const { rows, reason } = await runUnit(lane, 'deploy', ['test:deploy']);
  const row = rows?.find((candidate) => candidate.step === 'test:deploy');
  const text = await fetchText(lane, 'test-deploy.log');
  if (text !== undefined) writeFileSync(join(lane.dir, 'test-deploy.log'), text);
  lane.summary.deploy = {
    exit: row?.exit ?? null,
    reason: reason ?? null,
    tests: text ? vitestCounts(text) : null,
  };
  log(`test:deploy exit ${String(lane.summary.deploy.exit)}; host fence`);
  const fence = await poll(lane, 'host fence observation', () => {
    const result = ssh(remote(lane, 'fence', lane.remoteRoot, lane.summary.custody.invocation));
    if (result.status !== 0) return miss(result);
    try {
      const { before, after } = JSON.parse(result.stdout);
      if (before && after) return { value: { before, after } };
    } catch {
      // Missing or partial output: retry, never a verdict.
    }
    return { reason: 'incomplete fence output' };
  });
  lane.summary.fence = fence ?? null;
  for (const side of ['before', 'after'])
    if (fence)
      writeFileSync(
        join(lane.dir, `host-${side}.json`),
        `${JSON.stringify(fence[side], null, 2)}\n`,
      );
}

function complete(lane) {
  lane.summary.state = 'completed';
  lane.summary.failed = laneFailures(lane.summary);
  save(lane);
  writeFileSync(join(lane.dir, 'summary.txt'), summaryText(lane.summary));
  const failed = lane.summary.failed;
  if (failed.length) process.stderr.write(`lane:vps: not a pass: ${failed.join(', ')}\n`);
  else log(`lane passed; evidence in .run/vps-lane/${lane.label}/`);
  return failed.length ? 1 : 0;
}

async function runLane(args) {
  const lane = admit(args);
  try {
    await preUpload(lane);
    try {
      upload(lane);
    } finally {
      rmSync(lane.build, { recursive: true, force: true });
    }
    await installAndBuild(lane);
    if (await custody(lane)) await deployAndFence(lane);
    return complete(lane);
  } catch (error) {
    if (!lane.remoteStarted) {
      rmSync(lane.dir, { recursive: true, force: true });
      throw error;
    }
    lane.summary.state = 'failed';
    lane.summary.failure = { step: error.step ?? 'lane', reason: error.reason ?? error.message };
    save(lane);
    writeFileSync(join(lane.dir, 'summary.txt'), summaryText(lane.summary));
    throw error;
  }
}

const [operation, ...args] = process.argv.slice(2);
const prefix = operation === 'post' ? 'lane:vps:post' : 'lane:vps';
try {
  if (operation === 'run') process.exitCode = await runLane(args);
  else if (operation === 'post') process.exitCode = postLane(args);
  else throw new LaneRefusal('usage: vps-lane.mjs run|post <arguments>', 2);
} catch (error) {
  process.stderr.write(`${prefix}: ${error.message}\n`);
  process.exitCode = error instanceof LaneRefusal ? error.code : 1;
}

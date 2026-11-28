// Remote half of the parent-side VPS lane (`pnpm lane:vps`, scripts/vps-lane.mjs). The lane
// uploads this file and docker-proxy-environment.mjs into its private staging directory <R> and
// runs it with the pinned toolchain Node. It observes the host read-only and never removes,
// stops or cancels anything; proxy fields are loaded here and never printed or put in argv.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hostProxyEnvironment } from './docker-proxy-environment.mjs';

const ROLES = ['user', 'platform', 'browser'];
const STEPS = {
  install: ['install', '--frozen-lockfile'],
  build: ['build'],
  'test:deploy': ['test:deploy'],
};
const INVENTORY = ['containers', 'volumes', 'networks', 'images', 'labelledImages', 'activeUnits'];
const SHA = /^[a-f0-9]{40}$/;
const INVOCATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UNIT = /^dsh-team-lane-[a-z0-9-]{1,80}$/;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** POSIX single-quote quoting for one shell word. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const stepFile = (step) => step.replace(':', '-');
const ownedName = (name) => name.startsWith('dsh-team') || name.startsWith('dsh-browser');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const emptyList = (value) => Array.isArray(value) && value.length === 0;

/**
 * Names of the fence fields that differ between two host snapshots; the after snapshot must also
 * show every registered target absent and no owned leftover. A missing snapshot fails every field.
 */
export function fenceFailures(before, after) {
  if (!before || !after) return ['snapshot'];
  const failures = [];
  if (!emptyList(after.registeredPresent)) failures.push('registered-targets');
  const owned = after.ownedInventory ?? {};
  if (!INVENTORY.every((kind) => emptyList(owned[kind]))) failures.push('owned-leftovers');
  if (!/^[1-9][0-9]*$/.test(before.daemonPid ?? '') || before.daemonPid !== after.daemonPid)
    failures.push('daemon-pid');
  if (!before.docker0 || !same(before.docker0, after.docker0)) failures.push('docker0');
  const [was, now] = [before.foreignContainers, after.foreignContainers];
  if (!was || !now || !same(Object.entries(was).sort(), Object.entries(now).sort()))
    failures.push('foreign-containers');
  return failures;
}

function fail(message) {
  throw new Error(message);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const runtimeDirectory = () => process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;

function which(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return join(directory, name);
    } catch {
      // Not in this PATH entry; try the next.
    }
  }
  return fail(`${name} not found on PATH`);
}

/** Pinned toolchain paths below this session's HOME, from the uploaded lane.json. */
function toolchain(root) {
  const lane = readJson(join(root, 'lane.json'));
  const home = homedir();
  const at = (key) => join(home, lane.toolchain[key]);
  return { lane, node: join(at('node'), 'node'), pnpm: join(at('pnpm'), 'pnpm'), at };
}

function toolEnvironment(root) {
  const { lane, at } = toolchain(root);
  return {
    HOME: homedir(),
    LANG: 'C.UTF-8',
    CI: 'true',
    XDG_RUNTIME_DIR: runtimeDirectory(),
    PATH: [at('node'), at('pnpm'), at('hurl'), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    CHROME_BIN: at('chrome'),
    DSH_TEAM_REVIEWED_HEAD: lane.head,
    DSH_TEAM_VERIFICATION_IMAGES: join(root, 'images.json'),
  };
}

/** Streaming sha256 of a file of any size, hex. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: OUTPUT_LIMIT,
    timeout: 600_000,
    ...options,
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory(), ...options.env },
  });
  if (result.error || result.status !== 0)
    fail(
      `${file} ${args[0]} failed${result.stderr ? `: ${result.stderr.trim().slice(-300)}` : ''}`,
    );
  return result.stdout;
}

function blobPath(layout, digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) fail('invalid OCI digest');
  return join(layout, 'blobs', 'sha256', digest.slice(7));
}

async function verifiedBlob(layout, digest) {
  const path = blobPath(layout, digest);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
    fail(`OCI blob is not a private single-link file: ${digest}`);
  if (`sha256:${await sha256File(path)}` !== digest) fail(`OCI blob digest mismatch: ${digest}`);
  return readJson(path);
}

/** Follows an image index to its single linux/amd64 manifest. */
async function resolveManifest(layout, descriptor) {
  const document = await verifiedBlob(layout, descriptor.digest);
  if (!Array.isArray(document.manifests)) return { descriptor, manifest: document };
  let candidates = document.manifests.filter(
    (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64',
  );
  if (candidates.length === 0)
    candidates = document.manifests.filter(
      (entry) => !JSON.stringify(entry.annotations ?? {}).includes('attestation'),
    );
  if (candidates.length !== 1) fail('OCI index has no single linux/amd64 manifest');
  return resolveManifest(layout, candidates[0]);
}

async function prepareLayout(root, role) {
  const layout = join(root, 'layouts', role);
  mkdirSync(layout, { recursive: true, mode: 0o700 });
  command('tar', ['-xf', join(root, `${role}-image.tar`), '-C', layout]);
  command('chmod', ['-R', 'go-rwx', layout]);
  const index = readJson(join(layout, 'index.json'));
  if (index.manifests?.length !== 1) fail(`${role} OCI index must name exactly one manifest`);
  const { descriptor, manifest } = await resolveManifest(layout, index.manifests[0]);
  const configId = manifest.config?.digest;
  const config = await verifiedBlob(layout, configId);
  if (config.os !== 'linux' || config.architecture !== 'amd64')
    fail(`${role} image is not linux/amd64`);
  return { layout, manifestDigest: descriptor.digest, configId };
}

async function prepare(root, head) {
  const hashes = readJson(join(root, 'hashes.json'));
  for (const [name, digest] of Object.entries(hashes))
    if ((await sha256File(join(root, name))) !== digest) fail(`hash mismatch: ${name}`);
  if (toolchain(root).lane.head !== head) fail('lane.json names another head');
  const source = join(root, 'source');
  command('git', ['clone', '-q', join(root, 'source.bundle'), source]);
  command('git', ['-C', source, 'checkout', '-q', head]);
  if (command('git', ['-C', source, 'rev-parse', 'HEAD']).trim() !== head)
    fail('source checkout is not at the lane head');
  const roles = {};
  for (const role of ROLES) roles[role] = await prepareLayout(root, role);
  writeFileSync(join(root, 'images.json'), JSON.stringify({ roles }), { mode: 0o600, flag: 'wx' });
  const before = observe([]);
  writeFileSync(join(root, 'host-before.json'), JSON.stringify(before), {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify({ verified: true, roles })}\n`);
}

function registeredTargets(journals) {
  const targets = new Map();
  const present = [];
  for (const { path, required } of journals) {
    if (!existsSync(path)) {
      if (required) present.push(['journal', path, 'missing']);
      continue;
    }
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      try {
        const { kind, name } = JSON.parse(line).target ?? {};
        if (typeof kind === 'string' && typeof name === 'string')
          targets.set(`${kind} ${name}`, [kind, name]);
      } catch {
        present.push(['journal', path, 'malformed']);
      }
    }
  }
  for (const [kind, name] of targets.values()) {
    const result = spawnSync('docker', [kind, 'inspect', name], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status === 0) present.push([kind, name]);
    else if (!/no such|not found/i.test(result.stderr ?? ''))
      present.push([kind, name, 'inspect-error']);
  }
  return { registeredTargets: targets.size, registeredPresent: present };
}

/** Read-only host snapshot: daemon, docker0, foreign containers, owned inventory, targets. */
function observe(journals) {
  const list = (...args) => command('docker', args).split('\n').filter(Boolean);
  const link = JSON.parse(command('ip', ['-j', 'link', 'show', 'docker0']))[0];
  const foreignContainers = {};
  for (const line of list('ps', '-a', '--format', '{{.ID}} {{.Names}}')) {
    const [id, name = ''] = line.split(' ');
    if (!ownedName(name))
      foreignContainers[name] = command('docker', [
        'inspect',
        '--format',
        '{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}',
        id,
      ]).trim();
  }
  const units = command('systemctl', [
    '--user',
    'list-units',
    '--all',
    '--plain',
    '--no-legend',
    '--state=active,activating,deactivating',
    'dsh-team-*',
  ]);
  const ownedInventory = {
    containers: list('ps', '-a', '--format', '{{.Names}}').filter(ownedName),
    volumes: list('volume', 'ls', '--format', '{{.Name}}').filter(ownedName),
    networks: list('network', 'ls', '--format', '{{.Name}}').filter(ownedName),
    images: list('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}').filter(ownedName),
    labelledImages: list('image', 'ls', '-q', '--filter', 'label=dsh-team.test-run'),
    activeUnits: units.split('\n').filter((unit) => unit.trim()),
  };
  return {
    daemonPid: command('systemctl', [
      'show',
      'docker.service',
      '--property=MainPID',
      '--value',
    ]).trim(),
    docker0: { ifindex: link.ifindex, address: link.address, mtu: link.mtu },
    foreignContainers,
    ownedInventory,
    ...registeredTargets(journals),
  };
}

function fence(root, invocation) {
  const before = readJson(join(root, 'host-before.json'));
  const custody = join(homedir(), '.local/share/dsh-team/docker-verification', invocation);
  const after = observe([
    { path: join(custody, 'resources.jsonl'), required: true },
    { path: join(root, 'test-deploy-resources.jsonl'), required: false },
  ]);
  writeFileSync(join(root, 'host-after.json'), JSON.stringify(after), { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ before, after, failed: fenceFailures(before, after) })}\n`,
  );
}

/** Runs inside the systemd user unit; records one steps.jsonl row per step. */
function steps(root, names) {
  const { pnpm } = toolchain(root);
  const environment = { ...toolEnvironment(root), ...hostProxyEnvironment(process.getuid()) };
  for (const step of names) {
    const file = stepFile(step);
    const log = openSync(join(root, `${file}.log`), 'w', 0o600);
    const started = Date.now();
    const result = spawnSync(pnpm, STEPS[step], {
      cwd: join(root, 'source'),
      env: { ...environment, DSH_TEAM_CI_RESOURCE_JOURNAL: join(root, `${file}-resources.jsonl`) },
      stdio: ['ignore', log, log],
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    const row = { step, exit: result.status, signal: result.signal, seconds };
    appendFileSync(join(root, 'steps.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    if (result.status !== 0) return;
  }
}

function unit(root, head, name, names) {
  const { node } = toolchain(root);
  const inner = [
    'exec /usr/bin/env -i',
    `HOME=${shellQuote(homedir())}`,
    'PATH=/usr/bin:/bin',
    shellQuote(node),
    shellQuote(join(root, 'vps-lane-remote.mjs')),
    'steps',
    shellQuote(root),
    head,
    ...names,
  ].join(' ');
  const sg = which('sg');
  command('systemd-run', [
    '--user',
    '--unit',
    name,
    '--collect',
    '-p',
    'UMask=0022',
    '--',
    sg,
    'docker',
    '-c',
    inner,
  ]);
}

async function launch(root, head) {
  const { pnpm } = toolchain(root);
  const environment = { ...toolEnvironment(root), ...hostProxyEnvironment(process.getuid()) };
  process.umask(0o022);
  const result = spawnSync(
    which('sg'),
    ['docker', '-c', `exec ${shellQuote(pnpm)} --silent verify:docker start ${head}`],
    {
      cwd: join(root, 'source'),
      env: environment,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: OUTPUT_LIMIT,
    },
  );
  if (result.status !== 0)
    fail(
      `custody start exited ${String(result.status)}: ${(result.stderr ?? '').trim().slice(-300)}`,
    );
  const start = JSON.parse(result.stdout);
  if (!INVOCATION.test(start.invocation ?? '')) fail('custody start returned no invocation');
  writeFileSync(join(root, 'custody-start.json'), JSON.stringify(start), {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify({ ready: true, start })}\n`);
  // The observing SSH session: stay attached until the lane closes stdin.
  for await (const chunk of process.stdin) void chunk;
}

function custody(root, operation, invocation) {
  if (!INVOCATION.test(invocation ?? '')) fail('invalid custody invocation');
  const { pnpm } = toolchain(root);
  const args = [
    '--silent',
    'verify:docker',
    operation,
    invocation,
    ...(operation === 'logs' ? ['stdout'] : []),
  ];
  const child = spawn(pnpm, args, {
    cwd: join(root, 'source'),
    env: toolEnvironment(root),
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

const checked = (pattern, what) => (value) =>
  pattern.test(value ?? '') ? value : fail(`invalid ${what}`);
const head = checked(SHA, 'head');
const invocation = checked(INVOCATION, 'custody invocation');
const unitName = checked(UNIT, 'unit');
const known = (names) =>
  names.length > 0 && names.every((step) => Object.hasOwn(STEPS, step))
    ? names
    : fail('unknown step');
const OPERATIONS = {
  prepare: (root, [sha]) => prepare(root, head(sha)),
  launch: (root, [sha]) => launch(root, head(sha)),
  fence: (root, [id]) => fence(root, invocation(id)),
  'custody-status': (root, [id]) => custody(root, 'status', invocation(id)),
  'custody-logs': (root, [id]) => custody(root, 'logs', invocation(id)),
  steps: (root, [sha, ...names]) => head(sha) && steps(root, known(names)),
  unit: (root, [sha, name, ...names]) => unit(root, head(sha), unitName(name), known(names)),
};

async function main([operation, root, ...rest]) {
  if (operation === 'unit-state') {
    const name = unitName(root);
    process.stdout.write(
      command('systemctl', ['--user', 'show', '-p', 'SubState', '--value', name]),
    );
    return 0;
  }
  if (!Object.hasOwn(OPERATIONS, operation ?? '')) fail(`unknown operation ${String(operation)}`);
  if (!root?.startsWith('/')) fail('staging root must be absolute');
  return (await OPERATIONS[operation](root, rest)) ?? 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`vps-lane-remote: ${error.message}\n`);
    process.exitCode = 1;
  }
}

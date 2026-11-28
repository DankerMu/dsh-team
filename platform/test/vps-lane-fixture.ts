import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const FAKE = fileURLToPath(new URL('./vps-lane-fake.mjs', import.meta.url));
// One lane child: a few hundred fake processes at a 1 ms interval; generous for loaded runners.
export const LANE_MS = 60_000;
// Background fake units settle within one lane bound after the lane itself returned.
const UNIT_SETTLE_MS = 10_000;
export const NODE_PIN = '24.9.1';
const PNPM_PIN = '10.9.2';
const HURL_PIN = '7.7.7';
// Differs from the lane checkout's own pin, so every run proves the pin is read from <sha>.
const CHROME_PIN = '150.0.7000.1';
const CHROME_LINE = /^(export const CHROME_VERSION = ')[^']*(';)$/m;
const TOOLCHAIN = '.local/share/dsh-team/toolchain';
const ACCEPTED_LOGIN = 'DankerMu';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

interface Host {
  daemonPid: string;
  docker0: { ifindex: number; address: string; mtu: number };
  containers: { id: string; name: string; detail: string }[];
  volumes: string[];
  networks: string[];
  images: string[];
  labelledImages: string[];
  activeUnits: string[];
  present: string[];
}

interface GhRun {
  databaseId: number;
  headSha: string;
  conclusion: string;
}

interface GhState {
  login: string;
  head: string;
  body: string;
  runs: GhRun[];
  statuses: { sha: string; state: string; context: string; creator: { login: string } }[];
  failEdit: number;
  failStatus: number;
  edits: number;
}

export interface Scenario {
  buildFail?: string;
  logsFail?: boolean;
  oci: Record<string, string>;
  hostBefore: Host;
  hostAfter: Host;
  targets: { kind: string; name: string }[];
  deployTargets: { kind: string; name: string }[];
  statuses: unknown[];
  stdout: string;
  exits: Record<string, number>;
  output: Record<string, string>;
  errput?: Record<string, string>;
}

export interface LaneOptions {
  /** `.tool-versions` text at the lane sha. */
  toolVersions?: string;
  /** Extra browser Dockerfile line, e.g. a COPY naming an absent file. */
  browserCopy?: string;
  /** `git config tar.umask`, which `git archive` applies to every entry. */
  tarUmask?: string;
  /** Remote toolchain entry left absent. */
  missingTool?: 'node' | 'pnpm' | 'hurl' | 'chrome';
  /** Platform layer mode for the first migration file. */
  migrationMode?: number;
  /** CHROME_VERSION at the lane sha; null removes the pin line. */
  chromePin?: string | null;
  /** DSH_TEAM_LANE_QUERY_MS for the lane child. */
  queryMs?: string;
}

export const STDOUT =
  '\u001b[32m Test Files  41 passed (41)\u001b[39m\n      Tests  377 passed (377)\n   Duration  1873.21s (transform 2.1s)\n';
const DEPLOY = ' Test Files  2 passed (2)\n      Tests  9 passed (9)\n   Duration  412.50s\n';
export const BODY =
  '## Summary\r\nShip it.\r\n\r\n## Test plan\r\n- unit\r\n\r\n## Runtime evidence\r\n\r\nPending.\r\n\r\n## Risk\r\nLow.\r\n';

const host = (): Host => ({
  daemonPid: '4242',
  docker0: { ifindex: 3, address: '02:42:ac:11:00:01', mtu: 1500 },
  containers: [
    {
      id: 'f00d',
      name: 'ragflow-rc2-ragflow-cpu-1',
      detail: 'f00dfeed|running|2026-11-01T00:00:00Z|0',
    },
  ],
  volumes: ['ragflow-rc2_esdata'],
  networks: ['bridge', 'host', 'none'],
  images: ['node:24.13.1-bookworm-slim'],
  labelledImages: [],
  activeUnits: [],
  present: [],
});

export const passed = (head: string) => ({
  head,
  state: 'passed',
  command: { exitCode: 0, signal: null, settled: true },
  interruption: 'none',
  failure: null,
  output: {
    complete: true,
    stdout: {
      bytes: Buffer.byteLength(STDOUT),
      sha256: createHash('sha256').update(STDOUT).digest('hex'),
    },
    stderr: { bytes: 0, sha256: EMPTY_SHA256 },
  },
  cleanup: { state: 'confirmed' },
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1', ...env },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function put(path: string, content: string | Buffer, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, content);
  await chmod(path, mode);
}

const digest = (bytes: Buffer | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A docker-save style OCI archive with one uncompressed layer holding `files`. */
async function ociArchive(directory: string, files: [string, number][]) {
  const layer = join(directory, 'layer');
  for (const [path, mode] of files) {
    if (path.endsWith('/')) await mkdir(join(layer, path), { recursive: true });
    else await put(join(layer, path), `${path}\n`);
    await chmod(join(layer, path), mode);
  }
  const top = [...new Set(files.map(([path]) => path.split('/')[0] ?? ''))];
  for (const name of top) await chmod(join(layer, name), 0o755);
  run('tar', ['-cf', join(directory, 'layer.tar'), '-C', layer, ...top], directory);
  const blobs = join(directory, 'oci', 'blobs', 'sha256');
  const blob = async (bytes: Buffer | string) => {
    const id = digest(bytes);
    await put(join(blobs, id.slice(7)), bytes);
    return { id, size: Buffer.byteLength(bytes) };
  };
  const layerBlob = await blob(readFileSync(join(directory, 'layer.tar')));
  const rootfs = { type: 'layers', diff_ids: [layerBlob.id] };
  const config = await blob(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs }));
  const manifest = await blob(
    JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config.id },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layerBlob.id }],
    }),
  );
  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifest.id,
        size: manifest.size,
      },
    ],
  };
  await put(join(directory, 'oci', 'index.json'), JSON.stringify(index));
  await put(join(directory, 'oci', 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  const archive = join(directory, 'image.tar');
  run(
    'tar',
    ['-cf', archive, '-C', join(directory, 'oci'), 'oci-layout', 'index.json', 'blobs'],
    directory,
  );
  return archive;
}

async function images(directory: string, migrationMode: number) {
  const layers: Record<string, [string, number][]> = {
    platform: [
      ['app/platform/dist/db/migrations/', 0o755],
      ['app/platform/dist/db/migrations/1-initial.sql', migrationMode],
      ['app/images/dsh-user/catalog.json', 0o644],
    ],
    user: [['opt/dsh-team/catalog.json', 0o444]],
    browser: [['opt/dsh-team/probe-browser-runtime.mjs', 0o644]],
  };
  const archives: Record<string, string> = {};
  for (const [role, files] of Object.entries(layers)) {
    await mkdir(join(directory, role), { recursive: true });
    archives[role] = await ociArchive(join(directory, role), files);
  }
  return archives;
}

/** The lane checkout's browser runtime script with the pin line set to `pin` (null: removed). */
function browserRuntime(pin: string | null) {
  const text = readFileSync(join(REPOSITORY, 'scripts/verify-browser-runtime.mjs'), 'utf8');
  if (!CHROME_LINE.test(text))
    throw new Error('verify-browser-runtime.mjs has no CHROME_VERSION line');
  return text.replace(CHROME_LINE, pin === null ? '' : `$1${pin}$2`);
}

async function repository(directory: string, options: LaneOptions) {
  const copy = (name: string) => `COPY --from=browser-runtime /${name} /opt/dsh-team/${name}\n`;
  const files: Record<string, string> = {
    '.tool-versions': options.toolVersions ?? `nodejs ${NODE_PIN}\npnpm ${PNPM_PIN}\n`,
    '.github/workflows/ci.yml': `env:\n  HURL_VERSION: "${HURL_PIN}"\n`,
    'images/browser-verification/Dockerfile': `FROM base\n${copy('probe-browser-runtime.mjs')}${copy('byte-listener.mjs')}${options.browserCopy ?? ''}`,
    'scripts/probe-browser-runtime.mjs': 'export {};\n',
    'scripts/byte-listener.mjs': 'export {};\n',
    'scripts/verify-browser-runtime.mjs': browserRuntime(
      options.chromePin === undefined ? CHROME_PIN : options.chromePin,
    ),
    'platform/Dockerfile': 'FROM base\n',
    'images/dsh-user/Dockerfile': 'FROM base\n',
    'plugins/alpha/index.js': 'export {};\n',
    'plugins/beta/index.js': 'export {};\n',
  };
  for (const [path, content] of Object.entries(files)) await put(join(directory, path), content);
  const git = (...args: string[]) => run('git', args, directory, { HOME: directory });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=lane', '-c', 'user.email=lane@example.invalid', 'add', '.');
  git('-c', 'user.name=lane', '-c', 'user.email=lane@example.invalid', 'commit', '-qm', 'base');
  if (options.tarUmask) git('config', 'tar.umask', options.tarUmask);
  return git('rev-parse', 'HEAD');
}

async function toolchain(home: string, options: LaneOptions, pnpmShim: string) {
  const root = join(home, TOOLCHAIN);
  const node = join(root, `node-v${NODE_PIN}-linux-x64`, 'bin');
  const pnpm = join(root, `pnpm-${PNPM_PIN}`, 'node_modules', '.bin');
  const chrome = join(root, `chrome-${CHROME_PIN}`, 'chrome-headless-shell-linux64');
  if (options.missingTool !== 'node') {
    await mkdir(node, { recursive: true });
    await symlink(process.execPath, join(node, 'node'));
  }
  if (options.missingTool !== 'pnpm') await put(join(pnpm, 'pnpm'), pnpmShim, 0o755);
  if (options.missingTool !== 'hurl')
    await mkdir(join(root, `hurl-${HURL_PIN}`, 'usr', 'bin'), { recursive: true });
  if (options.missingTool !== 'chrome') await put(join(chrome, 'chrome-headless-shell'), '', 0o755);
}

const shim = (state: string, tool: string) =>
  `#!/bin/bash\nexec "${process.execPath}" "${FAKE}" "${state}" ${tool} "$@"\n`;

/** Fast bash fakes: SSH retries spawn many of them. */
function bashFakes(state: string, bin: string, remote: string) {
  const log = `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "${state}/calls.log"`;
  const ssh = `#!/bin/bash
${log}
while [ $# -gt 0 ]; do case $1 in -o) shift 2;; -*) shift;; *) break;; esac; done
[ "$1" = giap-vps ] || exit 255
shift; cmd="$*"
if [ -f "${state}/ssh-fail" ]; then
  read -r count pattern < "${state}/ssh-fail"
  if [ "$count" -gt 0 ] && [[ "$cmd" == *"$pattern"* ]]; then
    echo "$((count - 1)) $pattern" > "${state}/ssh-fail"
    echo 'ssh: connect to host giap-vps port 22: Operation timed out' >&2; exit 255
  fi
fi
run() { cd "${remote}" && /usr/bin/env -i HOME="${remote}" PATH="${bin}:/usr/bin:/bin" LANG=C.UTF-8 /bin/bash -c "$cmd"; }
# ssh-drop: run the first matching command with no session I/O, then lose the connection.
if [ -f "${state}/ssh-drop" ] && [[ "$cmd" == *"$(cat "${state}/ssh-drop")"* ]]; then
  rm "${state}/ssh-drop"; run < /dev/null > /dev/null 2>&1
  echo 'Connection to giap-vps closed by remote host.' >&2; exit 255
fi
# ssh-delay: hold the first matching command for <seconds> before it runs.
if [ -f "${state}/ssh-delay" ]; then
  read -r seconds pattern < "${state}/ssh-delay"
  if [[ "$cmd" == *"$pattern"* ]]; then rm "${state}/ssh-delay"; sleep "$seconds"; fi
fi
cd "${remote}" && exec /usr/bin/env -i HOME="${remote}" PATH="${bin}:/usr/bin:/bin" LANG=C.UTF-8 /bin/bash -c "$cmd"
`;
  const scp = `#!/bin/bash
${log}
files=(); while [ $# -gt 0 ]; do case $1 in -o) shift 2;; -*) shift;; *) files+=("$1"); shift;; esac; done
dest=\${files[\${#files[@]}-1]}; unset 'files[\${#files[@]}-1]'
[ "\${dest%%:*}" = giap-vps ] || exit 255
cp "\${files[@]}" "\${dest#giap-vps:}" || exit 1
if [ -f "${state}/scp-tamper" ]; then printf x >> "\${dest#giap-vps:}/$(cat "${state}/scp-tamper")"; fi
`;
  const sg = `#!/bin/bash\n${log}\n[ "$1" = docker ] && [ "$2" = -c ] || exit 2\nexec /bin/bash -c "$3"\n`;
  const systemdRun = `#!/bin/bash
${log}
unit=; while [ $# -gt 0 ]; do case $1 in --unit) unit=$2; shift 2;; -p) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done
mkdir -p "${state}/units"; echo running > "${state}/units/$unit"
( "$@"; echo dead > "${state}/units/$unit" ) < /dev/null > /dev/null 2>&1 &
`;
  return { ssh, scp, sg, 'systemd-run': systemdRun };
}

export interface Lane {
  repo: string;
  sha: string;
  remote: string;
  state: string;
  runDir: (label: string) => string;
  scenario: (change: (scenario: Scenario) => void) => Promise<void>;
  gh: (change: (state: GhState) => void) => Promise<void>;
  ghState: () => GhState;
  calls: () => { tool: string; args: string[] }[];
  lane: (script: 'lane:vps' | 'lane:vps:post', args: string[]) => Promise<LaneResult>;
  secret: string;
  local: string;
  cleanup: () => Promise<void>;
}

interface LaneResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function laneArgv(script: string) {
  const pkg = JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const [command, entry, ...rest] = (pkg.scripts[script] ?? '').split(' ');
  if (command !== 'node' || entry === undefined) throw new Error(`${script} is not a node script`);
  return [join(REPOSITORY, entry), ...rest];
}

async function settleUnits(state: string) {
  const units = join(state, 'units');
  // Bounded wait for background fake units so cleanup never races a running child.
  for (let waited = 0; waited < UNIT_SETTLE_MS && existsSync(units); waited += 20) {
    const running = readdirSync(units).some(
      (name) => readFileSync(join(units, name), 'utf8').trim() === 'running',
    );
    if (!running) return;
    await delay(20);
  }
}

async function setUpLane(root: string, options: LaneOptions): Promise<Lane> {
  const [local, remote, fake] = ['local', 'remote', 'fake'].map((name) => join(root, name)) as [
    string,
    string,
    string,
  ];
  const [repo, home, bin, state] = [
    join(local, 'repo'),
    join(local, 'home'),
    join(fake, 'bin'),
    join(fake, 'state'),
  ];
  for (const directory of [repo, home, bin, state, remote])
    await mkdir(directory, { recursive: true });
  const sha = await repository(repo, options);
  const secret = `CANARY${randomUUID().replaceAll('-', '')}`;
  await put(
    join(remote, '.config/dsh-team/docker-proxy.json'),
    JSON.stringify({ HTTP_PROXY: `http://lane:${secret}@127.0.0.1:9/`, NO_PROXY: 'localhost' }),
    0o600,
  );
  await chmod(join(remote, '.config/dsh-team'), 0o700);
  await toolchain(remote, options, shim(state, 'pnpm'));
  for (const tool of ['docker', 'gh', 'systemctl', 'ip'])
    await put(join(bin, tool), shim(state, tool), 0o755);
  for (const [tool, body] of Object.entries(bashFakes(state, bin, remote)))
    await put(join(bin, tool), body, 0o755);
  const scenario: Scenario = {
    oci: await images(join(fake, 'oci'), options.migrationMode ?? 0o644),
    hostBefore: host(),
    hostAfter: host(),
    targets: [
      { kind: 'container', name: 'dsh-team-case-1' },
      { kind: 'network', name: 'dsh-team-net-1' },
    ],
    deployTargets: [{ kind: 'volume', name: 'dsh-team-volume-1' }],
    statuses: [{ head: sha, state: 'running' }, passed(sha)],
    stdout: STDOUT,
    exits: {},
    output: { 'test:deploy': DEPLOY },
  };
  const gh: GhState = {
    login: ACCEPTED_LOGIN,
    head: sha,
    body: BODY,
    runs: [
      { databaseId: 11, headSha: sha, conclusion: 'failure' },
      { databaseId: 12, headSha: sha, conclusion: 'success' },
      { databaseId: 13, headSha: 'f'.repeat(40), conclusion: 'failure' },
    ],
    statuses: [],
    failEdit: 0,
    failStatus: 0,
    edits: 0,
  };
  const json = (file: string, value: unknown) =>
    writeFile(join(state, file), JSON.stringify(value));
  await json('scenario.json', scenario);
  await json('gh.json', gh);
  await writeFile(join(state, 'calls.log'), '');
  const ghState = () => JSON.parse(readFileSync(join(state, 'gh.json'), 'utf8')) as GhState;
  return {
    repo,
    sha,
    remote,
    state,
    secret,
    local,
    runDir: (label) => join(repo, '.run', 'vps-lane', label),
    scenario: async (change) => {
      change(scenario);
      await json('scenario.json', scenario);
    },
    gh: async (change) => {
      const current = ghState();
      change(current);
      await json('gh.json', current);
    },
    ghState,
    calls: () =>
      readFileSync(join(state, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [tool = '', ...args] = line.split('\x1f');
          return { tool, args };
        }),
    lane: (script, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...laneArgv(script), ...args], {
          cwd: repo,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: home,
            LANG: 'C.UTF-8',
            DSH_TEAM_LANE_INTERVAL_MS: '1',
            ...(options.queryMs === undefined ? {} : { DSH_TEAM_LANE_QUERY_MS: options.queryMs }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LANE_MS,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.once('error', reject);
        child.once('close', (status) => {
          resolve({ status, stdout, stderr });
        });
      }),
    cleanup: async () => {
      await settleUnits(state);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A fresh lane world; a failed setup removes its own temporary root. */
export async function createLane(options: LaneOptions = {}): Promise<Lane> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-vps-lane-'));
  try {
    return await setUpLane(root, options);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

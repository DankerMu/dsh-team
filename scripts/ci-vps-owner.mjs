import { spawn, spawnSync } from 'node:child_process';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReceipt } from './probe-browser-receipt.mjs';

const repository = 'DankerMu/dsh-team';
const requestFile = process.argv[2];
if (!requestFile || !/\/\.run\/ci-model\/[a-f0-9-]{36}\/request\.json$/.test(requestFile))
  throw new Error('Private operator request required');
const requestInfo = await lstat(requestFile);
if (
  !requestInfo.isFile() ||
  requestInfo.uid !== process.getuid() ||
  (requestInfo.mode & 0o077) !== 0 ||
  requestInfo.size > 4096
)
  throw new Error('Untrusted operator request');
const { sha, ref, rerun, invocation, repositoryRoot } = JSON.parse(
  await readFile(requestFile, 'utf8'),
);
if (
  !/^[a-f0-9]{40}$/.test(sha) ||
  !/^[a-f0-9-]{36}$/.test(invocation) ||
  !/^refs\/heads\/(?:main|codex\/[a-zA-Z0-9/_-]+)$/.test(ref) ||
  (rerun !== undefined && !/^--rerun=[1-9][0-9]*$/.test(rerun)) ||
  repositoryRoot !== process.cwd()
)
  throw new Error('Invalid operator request');
const local = resolve(repositoryRoot, '.run/ci-model', invocation);
if (dirname(requestFile) !== local) throw new Error('Operator request identity mismatch');
const remote = `/home/ubuntu/.local/share/dsh-team/ci/${invocation}`;
const node = '/home/ubuntu/.local/share/dsh-team/toolchain/node-v24.13.1-linux-x64/bin/node';
const worker = `${remote}/trusted/platform/test/ci-vps-worker.ts`;
const secretName = `DSH_TEAM_VPS_CHANNEL_${sha.toUpperCase()}`;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
let rootAttempted = false;
let workerReady = false;
let publicationAttempted = false;
let published = false;
let hostObserver;
let phase = 'preparation';
let wholeCleanupComplete = false;
let interrupted = false;
let watch;
let actionsId;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    watch?.kill(signal);
  });
}
const cancellation = setInterval(() => {
  void lstat(join(local, 'client-cancel'))
    .then(() => {
      interrupted = true;
      watch?.kill('SIGTERM');
    })
    .catch((error) => {
      if (error.code !== 'ENOENT') {
        interrupted = true;
        watch?.kill('SIGTERM');
      }
    });
}, 250);
cancellation.unref();

function secretPresent() {
  const result = spawnSync('gh', ['api', `repos/${repository}/actions/secrets/${secretName}`], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16_384,
  });
  if (result.status === 0) return true;
  if (result.status === 1 && result.stderr.includes('(HTTP 404)')) return false;
  throw new Error('GitHub channel retirement could not be observed');
}

function observeHost() {
  return new Promise((resolveHost) => {
    const observer = spawn(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=yes',
        'giap-vps',
        `${quote(node)} ${quote(worker)} await ${quote(invocation)}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_850_000 },
    );
    let text = '';
    observer.stdout.on('data', (chunk) => {
      text += String(chunk);
      if (text.length > 16_384) observer.kill('SIGTERM');
    });
    const failed = () => {
      interrupted = true;
      watch?.kill('SIGTERM');
      resolveHost({ vpsCleanupComplete: false, exitCode: 1 });
    };
    observer.once('error', failed);
    observer.once('exit', (code) => {
      if (code !== 0) {
        failed();
        return;
      }
      try {
        const result = JSON.parse(text);
        if (result.vpsCleanupComplete !== true || result.exitCode !== 0) {
          interrupted = true;
          watch?.kill('SIGTERM');
        }
        resolveHost(result);
      } catch {
        failed();
      }
    });
  });
}
function run(binary, args, input, timeout = 60_000) {
  const result = spawnSync(binary, args, {
    input,
    encoding: input instanceof Buffer ? null : 'utf8',
    timeout,
    maxBuffer: 33_554_432,
  });
  if (result.status !== 0 || result.error) throw new Error(`CI operator ${binary} failed`);
  return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}
function ssh(command, input, timeout = 60_000) {
  return run(
    'ssh',
    ['-o', 'StrictHostKeyChecking=yes', 'giap-vps', `umask 077; ${command}`],
    input,
    timeout,
  );
}
function provision(command, expiresAt) {
  const guarded = `test ! -e ${quote(`${remote}/cancel`)} && test ! -e ${quote(`${remote}/final.json`)} && test "$(date +%s)" -lt ${expiresAt} && ${command}`;
  ssh(`flock --wait 60 ${quote(`${remote}/lifecycle.lock`)} sh -c ${quote(guarded)}`);
}
async function prepare() {
  const resolved = run('git', ['rev-parse', `${sha}^{commit}`]).trim();
  if (resolved !== sha) throw new Error('Approved source commit unavailable');
  const metadata = JSON.parse(run('gh', ['api', `repos/${repository}`]));
  if (metadata.full_name !== repository || metadata.owner.login !== 'DankerMu')
    throw new Error('Repository identity mismatch');
  const sshConfig = new Map(
    run('ssh', ['-G', 'giap-vps'])
      .split('\n')
      .map((line) => {
        const split = line.indexOf(' ');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  const hostKey = ssh('cat /etc/ssh/ssh_host_ed25519_key.pub')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
  if (!hostKey.startsWith('ssh-ed25519 ')) throw new Error('Missing trusted host key');
  const keyFile = join(local, 'identity');
  run('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    `dsh-team-ci-${invocation}`,
    '-f',
    keyFile,
  ]);
  const approved = {
    repository,
    repositoryId: String(metadata.id),
    ownerId: String(metadata.owner.id),
    actorId: String(metadata.owner.id),
    sha,
    workflowSha: sha,
    ref,
    workflowRef: `${repository}/.github/workflows/model.yml@${ref}`,
    audience: `dsh-team-vps:${invocation}`,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  await writeFile(
    join(local, 'invocation.json'),
    JSON.stringify({ invocation, sha, ref, remote, secretName, approval: approved }),
    { mode: 0o600 },
  );
  const files = [
    'platform/test/ci-vps-worker.ts',
    'platform/test/ci-vps-identity.ts',
    'platform/test/docker-cleanup.ts',
    'platform/test/docker-command.ts',
    'scripts/probe-browser-runtime.mjs',
    'scripts/probe-browser-native.mjs',
    'scripts/probe-browser-network.mjs',
    'scripts/probe-browser-receipt.mjs',
    'scripts/ci-vps-units.mjs',
  ];
  const archive = spawnSync('git', ['archive', '--format=tar', sha, ...files], {
    maxBuffer: 4_194_304,
  });
  if (archive.status !== 0) throw new Error('Trusted verifier archive failed');
  phase = 'private-installation';
  rootAttempted = true;
  ssh(
    `mkdir -p /home/ubuntu/.local/share/dsh-team/ci && mkdir -m 700 ${quote(remote)} && printf '%s' ${quote(invocation)} > ${quote(`${remote}/owner`)}`,
  );
  ssh(
    `mkdir ${quote(`${remote}/trusted`)} && tar -xf - -C ${quote(`${remote}/trusted`)}`,
    archive.stdout,
  );
  workerReady = true;
  ssh(`cat > ${quote(`${remote}/approval.json`)}`, JSON.stringify(approved));
  const expiry =
    new Date(Date.now() + 1_800_000).toISOString().split('.')[0].replaceAll(/[-:T]/g, '') + 'Z';
  const publicKey = (await readFile(`${keyFile}.pub`, 'utf8')).trim();
  const authorization = `restrict,expiry-time="${expiry}",command="${node} ${worker} serve ${invocation}" ${publicKey}`;
  ssh(`cat > ${quote(`${remote}/authorization-line`)}`, `${authorization}\n`);
  phase = 'watcher-installation';
  ssh(
    `systemd-run --user --unit=${quote(`dsh-team-ci-${invocation}-watch`)} --collect --property=RuntimeMaxSec=2100 --property=TimeoutStopSec=90 /usr/bin/sg docker -c ${quote(`${quote(node)} ${quote(worker)} watch ${quote(invocation)}`)}`,
  );
  hostObserver = observeHost();
  phase = 'exclusive-admission';
  provision(
    `ln -s ${quote(invocation)} /home/ubuntu/.local/share/dsh-team/ci/active`,
    approved.expiresAt,
  );
  phase = 'execution-unit';
  provision(
    `systemd-run --user --unit=${quote(`dsh-team-ci-${invocation}-run`)} --collect --description=${quote(`dsh-team-ci:${invocation}`)} --property=RuntimeMaxSec=1800 --property=TimeoutStopSec=30 --property=KillMode=control-group /usr/bin/sg docker -c ${quote(`${quote(node)} ${quote(worker)} execute ${quote(invocation)}`)}`,
    approved.expiresAt,
  );
  phase = 'channel-publication';
  if (interrupted || secretPresent())
    throw new Error('Invocation closed or an existing channel generation remains');
  provision(
    `printf '\\n' >> /home/ubuntu/.ssh/authorized_keys && cat ${quote(`${remote}/authorization-line`)} >> /home/ubuntu/.ssh/authorized_keys`,
    approved.expiresAt,
  );
  const channel = JSON.stringify({
    host: sshConfig.get('hostname'),
    user: sshConfig.get('user'),
    port: Number(sshConfig.get('port')),
    privateKey: await readFile(keyFile, 'utf8'),
    knownHost: `giap-vps-ci ${hostKey}`,
    audience: approved.audience,
  });
  publicationAttempted = true;
  run('gh', ['secret', 'set', secretName, '--repo', repository], channel);
  published = true;
  await rm(keyFile);
  await rm(`${keyFile}.pub`);
  process.stdout.write(`Approved invocation=${invocation} sha=${sha}\n`);
}
function selectRun(runs, branch) {
  if (!Array.isArray(runs)) throw new Error('Invalid Actions inventory');
  return runs.find(
    (candidate) =>
      candidate.head_sha === sha &&
      candidate.head_branch === branch &&
      candidate.path === '.github/workflows/model.yml' &&
      (rerun === undefined || String(candidate.id) === rerun.slice('--rerun='.length)),
  );
}

function publishRevision() {
  if (ref === 'refs/heads/main') {
    if (run('gh', ['api', `repos/${repository}/commits/main`, '--jq', '.sha']).trim() !== sha)
      throw new Error('Approved main revision is not current; never pushing main');
  } else if (rerun === undefined) run('git', ['push', 'origin', `${sha}:${ref}`]);
}

async function runActions() {
  if (interrupted) throw new Error('Operator interrupted');
  publishRevision();
  let selected;
  const until = Date.now() + 60_000;
  while (!selected && Date.now() < until) {
    const branch = ref.slice('refs/heads/'.length);
    const runs = JSON.parse(
      run('gh', [
        'api',
        `repos/${repository}/actions/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(branch)}&per_page=30`,
        '--jq',
        '.workflow_runs',
      ]),
    );
    selected = selectRun(runs, branch);
    if (!selected) await delay(1_000);
  }
  if (!selected) throw new Error('Trusted Actions run was not created');
  if (!Number.isSafeInteger(selected.id) || selected.id < 1)
    throw new Error('Invalid Actions run identity');
  actionsId = selected.id;
  await writeFile(join(local, 'actions.json'), JSON.stringify(selected), { mode: 0o600 });
  if (rerun !== undefined) {
    if (selected.status !== 'completed') throw new Error('Explicit rerun requires a completed run');
    run('gh', ['run', 'rerun', String(selected.id), '--repo', repository]);
  } else if (selected.status === 'completed') {
    throw new Error('Completed run requires explicit --rerun; no automatic model retry');
  }
  process.stdout.write(`Actions run=${selected.id}\n`);
  const code = await new Promise((resolveCode, reject) => {
    watch = spawn(
      'gh',
      [
        'run',
        'watch',
        String(selected.id),
        '--repo',
        repository,
        '--exit-status',
        '--interval',
        '60',
      ],
      { stdio: 'inherit' },
    );
    watch.once('error', reject);
    watch.once('exit', (status) => resolveCode(status ?? 1));
  });
  if (code !== 0 || interrupted) throw new Error('Trusted Actions run failed or was cancelled');
}
async function recoverVps() {
  if (!rootAttempted) return;
  const ownership = ssh(
    `if [ ! -e ${quote(remote)} ]; then printf absent; elif [ -f ${quote(`${remote}/owner`)} ] && [ "$(cat ${quote(`${remote}/owner`)})" = ${quote(invocation)} ]; then printf owned; else printf foreign; fi`,
  ).trim();
  if (ownership === 'absent') return;
  if (ownership !== 'owned') throw new Error('Private installation ownership is unconfirmed');
  if (!workerReady) {
    // No unit or SSH/GitHub capability can be issued before the worker is installed.
    ssh(
      `test "$(cat ${quote(`${remote}/owner`)})" = ${quote(invocation)} && rm -rf -- ${quote(remote)}`,
    );
    return;
  }
  ssh(`touch ${quote(`${remote}/cancel`)}`);
  const active = ssh(
    `systemctl --user is-active ${quote(`dsh-team-ci-${invocation}-watch`)} || true`,
  ).trim();
  if (!['active', 'activating'].includes(active))
    ssh(`${quote(node)} ${quote(worker)} finalize ${quote(invocation)}`, undefined, 190_000);
  const final = hostObserver
    ? await hostObserver
    : JSON.parse(
        ssh(`${quote(node)} ${quote(worker)} await ${quote(invocation)}`, undefined, 190_000),
      );
  await writeReceipt(join(local, 'vps-final.json'), final);
  if (final.vpsCleanupComplete !== true) throw new Error('Host cleanup incomplete');
}

function cancelActions() {
  if (!actionsId || (!interrupted && !process.exitCode)) return;
  const status = () =>
    run('gh', [
      'run',
      'view',
      String(actionsId),
      '--repo',
      repository,
      '--json',
      'status',
      '--jq',
      '.status',
    ]).trim();
  if (status() === 'completed') return;
  try {
    run('gh', ['run', 'cancel', String(actionsId), '--repo', repository]);
  } catch (error) {
    if (status() !== 'completed') throw error;
  }
}

async function retire() {
  const failures = [];
  try {
    cancelActions();
  } catch {
    failures.push('actions-cancellation');
  }
  if (publicationAttempted) {
    try {
      if (secretPresent()) run('gh', ['secret', 'delete', secretName, '--repo', repository]);
      if (secretPresent()) throw new Error('GitHub channel remains');
      if (!published) throw new Error('Publication outcome was ambiguous');
    } catch {
      failures.push('github-channel-retirement');
    }
  }
  try {
    await recoverVps();
  } catch {
    failures.push('vps-retirement');
  }
  if (!failures.length && rootAttempted) {
    try {
      // The symlink is an atomic lock identity. A foreign generation is never removed.
      ssh(
        `if [ -L /home/ubuntu/.local/share/dsh-team/ci/active ] && [ "$(readlink /home/ubuntu/.local/share/dsh-team/ci/active)" = ${quote(invocation)} ]; then rm /home/ubuntu/.local/share/dsh-team/ci/active; fi`,
      );
    } catch {
      failures.push('owned-lock-retirement');
    }
  }
  await rm(join(local, 'identity'), { force: true });
  await rm(join(local, 'identity.pub'), { force: true });
  wholeCleanupComplete = failures.length === 0;
  if (failures.length) throw new Error(`CI retirement failed: ${failures.join(',')}`);
}
try {
  await prepare();
  phase = 'actions-execution';
  await runActions();
} catch {
  process.stderr.write(
    `Trusted model CI failed during ${phase}; sanitized invocation metadata retained\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    await retire();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  clearInterval(cancellation);
  await writeReceipt(join(local, 'result.json'), {
    invocation,
    sha,
    phase,
    cleanupComplete: wholeCleanupComplete,
    exitCode: Number(process.exitCode ?? 0),
  });
}

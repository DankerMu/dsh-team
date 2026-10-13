import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repository = 'DankerMu/dsh-team';
const [sha, ref, rerun] = process.argv.slice(2);
if (
  !/^[a-f0-9]{40}$/.test(sha ?? '') ||
  !/^refs\/heads\/(?:main|codex\/[a-zA-Z0-9/_-]+)$/.test(ref ?? '') ||
  (rerun !== undefined && !/^--rerun=[1-9][0-9]*$/.test(rerun)) ||
  process.argv.length > 5
)
  throw new Error('Usage: pnpm ci:model <reviewed-full-sha> <full-branch-ref> [--rerun=<run-id>]');
const invocation = randomUUID();
const local = resolve('.run/ci-model', invocation);
const remote = `/home/ubuntu/.local/share/dsh-team/ci/${invocation}`;
const node = '/home/ubuntu/.local/share/dsh-team/toolchain/node-v24.13.1-linux-x64/bin/node';
const worker = `${remote}/trusted/platform/test/ci-vps-worker.ts`;
const secretName = `DSH_TEAM_VPS_CHANNEL_${sha.toUpperCase()}`;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
let installed = false;
let published = false;
let interrupted = false;
let watch;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    watch?.kill(signal);
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
  await mkdir(local, { recursive: true, mode: 0o700 });
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
  ];
  const archive = spawnSync('git', ['archive', '--format=tar', sha, ...files], {
    maxBuffer: 4_194_304,
  });
  if (archive.status !== 0) throw new Error('Trusted verifier archive failed');
  ssh(
    `umask 077; mkdir -p /home/ubuntu/.local/share/dsh-team/ci && mkdir /home/ubuntu/.local/share/dsh-team/ci/active && printf '%s' ${quote(invocation)} > /home/ubuntu/.local/share/dsh-team/ci/active/id && mkdir ${quote(remote)} && mkdir ${quote(`${remote}/trusted`)} && tar -xf - -C ${quote(`${remote}/trusted`)}`,
    archive.stdout,
  );
  installed = true;
  ssh(`cat > ${quote(`${remote}/approval.json`)}`, JSON.stringify(approved));
  const expiry =
    new Date(Date.now() + 1_800_000).toISOString().split('.')[0].replaceAll(/[-:T]/g, '') + 'Z';
  const publicKey = (await readFile(`${keyFile}.pub`, 'utf8')).trim();
  const authorization = `restrict,expiry-time="${expiry}",command="${node} ${worker} serve ${invocation}" ${publicKey}`;
  ssh(`cat > ${quote(`${remote}/authorization-line`)}`, `${authorization}\n`);
  ssh(
    `systemd-run --user --unit=${quote(`dsh-team-ci-${invocation}-run`)} --collect --description=${quote(`dsh-team-ci:${invocation}`)} --property=RuntimeMaxSec=1800 --property=TimeoutStopSec=30 --property=KillMode=control-group ${quote(node)} ${quote(worker)} execute ${quote(invocation)}`,
  );
  ssh(
    `systemd-run --user --unit=${quote(`dsh-team-ci-${invocation}-watch`)} --collect --property=RuntimeMaxSec=2100 --property=TimeoutStopSec=90 ${quote(node)} ${quote(worker)} watch ${quote(invocation)}`,
  );
  ssh(`cat ${quote(`${remote}/authorization-line`)} >> /home/ubuntu/.ssh/authorized_keys`);
  const channel = JSON.stringify({
    host: sshConfig.get('hostname'),
    user: sshConfig.get('user'),
    port: Number(sshConfig.get('port')),
    privateKey: await readFile(keyFile, 'utf8'),
    knownHost: `giap-vps-ci ${hostKey}`,
    audience: approved.audience,
  });
  run('gh', ['secret', 'set', secretName, '--repo', repository], channel);
  published = true;
  await rm(keyFile);
  await rm(`${keyFile}.pub`);
  process.stdout.write(`Approved invocation=${invocation} sha=${sha}\n`);
}
async function runActions() {
  if (interrupted) throw new Error('Operator interrupted');
  if (ref === 'refs/heads/main') {
    if (run('gh', ['api', `repos/${repository}/commits/main`, '--jq', '.sha']).trim() !== sha)
      throw new Error('Approved main revision is not current; never pushing main');
  } else if (rerun === undefined) run('git', ['push', 'origin', `${sha}:${ref}`]);
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
    if (!Array.isArray(runs)) throw new Error('Invalid Actions inventory');
    selected = runs.find(
      (candidate) =>
        candidate.head_sha === sha &&
        candidate.head_branch === branch &&
        candidate.path === '.github/workflows/model.yml' &&
        (rerun === undefined || String(candidate.id) === rerun.slice('--rerun='.length)),
    );
    if (!selected) await delay(1_000);
  }
  if (!selected) throw new Error('Trusted Actions run was not created');
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
async function retire() {
  const failures = [];
  if (published) {
    try {
      run('gh', ['secret', 'delete', secretName, '--repo', repository]);
    } catch {
      failures.push('github-channel-retirement');
    }
  }
  if (installed) {
    try {
      ssh(`touch ${quote(`${remote}/cancel`)}`);
      const result = ssh(
        `${quote(node)} ${quote(worker)} await ${quote(invocation)}`,
        undefined,
        190_000,
      );
      await writeFile(join(local, 'final.json'), result, { mode: 0o600 });
      const final = JSON.parse(result);
      if (final.cleanupComplete !== true) throw new Error('Host cleanup incomplete');
      // Unlock only the exact invocation; a foreign or changed lock is never removed.
      ssh(
        `test "$(cat /home/ubuntu/.local/share/dsh-team/ci/active/id)" = ${quote(invocation)} && rm /home/ubuntu/.local/share/dsh-team/ci/active/id && rmdir /home/ubuntu/.local/share/dsh-team/ci/active`,
      );
    } catch {
      failures.push('vps-retirement');
    }
  }
  await rm(join(local, 'identity'), { force: true });
  await rm(join(local, 'identity.pub'), { force: true });
  if (failures.length) throw new Error(`CI retirement failed: ${failures.join(',')}`);
}
try {
  await prepare();
  await runActions();
} catch {
  process.stderr.write('Trusted model CI failed; sanitized invocation metadata retained\n');
  process.exitCode = 1;
} finally {
  try {
    await retire();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

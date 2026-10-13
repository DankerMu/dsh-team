import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [sha, ref, rerun] = process.argv.slice(2);
if (
  !/^[a-f0-9]{40}$/.test(sha ?? '') ||
  !/^refs\/heads\/(?:main|codex\/[a-zA-Z0-9/_-]+)$/.test(ref ?? '') ||
  (rerun !== undefined && !/^--rerun=[1-9][0-9]*$/.test(rerun)) ||
  process.argv.length > 6
)
  throw new Error('Usage: pnpm ci:model <reviewed-full-sha> <full-branch-ref> [--rerun=<run-id>]');
const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const source = spawnSync('git', ['show', `${sha}:scripts/ci-vps-owner.mjs`], {
  encoding: 'utf8',
  maxBuffer: 1_048_576,
});
if (rootResult.status !== 0 || source.status !== 0)
  throw new Error('Reviewed operator source unavailable');
const repositoryRoot = rootResult.stdout.trim();
const invocation = randomUUID();
const local = resolve(repositoryRoot, '.run/ci-model', invocation);
await mkdir(local, { recursive: true, mode: 0o700 });
const request = { invocation, sha, ref, rerun, repositoryRoot };
const requestFile = join(local, 'request.json');
const ownerFile = join(local, 'owner.mjs');
await writeFile(requestFile, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
await writeFile(ownerFile, source.stdout, { mode: 0o600, flag: 'wx' });
const receiptSource = spawnSync('git', ['show', `${sha}:scripts/probe-browser-receipt.mjs`], {
  encoding: 'utf8',
  maxBuffer: 65_536,
});
if (receiptSource.status !== 0) throw new Error('Reviewed receipt writer unavailable');
await writeFile(join(local, 'probe-browser-receipt.mjs'), receiptSource.stdout, {
  mode: 0o600,
  flag: 'wx',
});
const log = await open(join(local, 'operator.log'), 'wx+', 0o600);
const env = {};
for (const name of [
  'PATH',
  'HOME',
  'USER',
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
])
  if (process.env[name] !== undefined) env[name] = process.env[name];
env.GIT_TERMINAL_PROMPT = '0';
env.GH_PROMPT_DISABLED = '1';
// The owner is a separate session from the foreground client, before any remote mutation.
// All credential publication and retirement happen in that owner, not in this process.
const owner = spawn(process.execPath, [ownerFile, requestFile], {
  cwd: repositoryRoot,
  env,
  detached: true,
  stdio: ['ignore', log.fd, log.fd],
});
let ended = false;
let spawnError = false;
owner.once('exit', () => {
  ended = true;
});
owner.once('error', () => {
  spawnError = true;
  ended = true;
});
owner.unref();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // Request cancellation without killing the independent authority-retirement owner.
    void writeFile(join(local, 'client-cancel'), signal, { mode: 0o600 }).catch(() => {
      process.stderr.write('CI cancellation request could not be recorded\n');
    });
  });
}
process.stdout.write(`CI invocation=${invocation}; durable owner and evidence=${local}\n`);
const buffer = Buffer.alloc(16_384);
let offset = 0;
try {
  for (;;) {
    const { bytesRead } = await log.read(buffer, 0, buffer.length, offset);
    if (bytesRead) {
      process.stdout.write(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (ended && !bytesRead) break;
    await delay(200);
  }
  if (spawnError) throw new Error('Independent CI owner failed to start');
  const result = JSON.parse(await readFile(join(local, 'result.json'), 'utf8'));
  if (result.invocation !== invocation || result.sha !== sha)
    throw new Error('CI owner result identity mismatch');
  process.exitCode = result.exitCode === 0 && result.cleanupComplete === true ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await log.close();
  // A client receipt is not authority; the independent owner's result remains canonical.
  await writeFile(
    join(local, 'client-result.pending'),
    JSON.stringify({ exitCode: process.exitCode ?? 1 }),
    { mode: 0o600 },
  );
  await rename(join(local, 'client-result.pending'), join(local, 'client-result.json'));
}

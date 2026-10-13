import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory;
let child;
let interrupted = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
}
try {
  const channel = JSON.parse(process.env.DSH_TEAM_VPS_CHANNEL ?? '{}');
  for (const key of ['host', 'user', 'privateKey', 'knownHost', 'audience']) {
    if (typeof channel[key] !== 'string' || !channel[key]) throw new Error('Invalid channel');
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(channel.host) || !/^[a-z_][a-z0-9_-]*$/.test(channel.user))
    throw new Error('Invalid SSH destination');
  if (!Number.isInteger(channel.port) || channel.port < 1 || channel.port > 65535)
    throw new Error('Invalid SSH port');
  if (!channel.knownHost.startsWith('giap-vps-ci ssh-ed25519 '))
    throw new Error('Missing pretrusted host identity');
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', channel.audience);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('OIDC unavailable');
  const identity = await response.json();
  if (typeof identity.value !== 'string' || identity.value.length > 16_384)
    throw new Error('Invalid OIDC identity');
  directory = await mkdtemp(join(tmpdir(), 'dsh-team-ci-channel-'));
  const keyFile = join(directory, 'identity');
  const hostsFile = join(directory, 'known_hosts');
  await writeFile(keyFile, channel.privateKey, { mode: 0o600 });
  await writeFile(hostsFile, `${channel.knownHost.trim()}\n`, { mode: 0o600 });
  if (interrupted) throw new Error('Invocation interrupted');
  const args = [
    '-F',
    '/dev/null',
    '-T',
    '-p',
    String(channel.port),
    '-i',
    keyFile,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${hostsFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'HostKeyAlias=giap-vps-ci',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    `${channel.user}@${channel.host}`,
    'verify',
  ];
  child = spawn('ssh', args, {
    env: { PATH: process.env.PATH, HOME: directory },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  // SSH authenticates the pinned host before forwarding stdin. The bearer never enters argv.
  child.stdin.on('error', () => {
    /* SSH exit supplies the failure, including host-key rejection. */
  });
  child.stdin.end(`${identity.value}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exitCode = interrupted ? 1 : code;
} catch {
  process.stderr.write(
    'Trusted VPS model invocation failed; inspect sanitized admission evidence\n',
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}

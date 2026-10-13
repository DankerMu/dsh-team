/** Native ownership is the issued ChildProcess capability, not a mutable ps command. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

const owners = new Map();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error('browser process identity unavailable', { cause: error });
  }
};

export async function processBirth(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('browser process identity invalid');
  if (platform() === 'linux') {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const ticks = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
    if (!/^[0-9]+$/.test(ticks ?? ''))
      throw new Error('browser process birth identity unavailable');
    return `linux:${pid}:${ticks}`;
  }
  if (platform() === 'darwin') {
    const result = spawnSync(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65536,
      },
    );
    if (result.status !== 0 || result.error || !result.stdout.trim())
      throw new Error('browser process identity unavailable');
    return `darwin:${pid}:${createHash('sha256').update(result.stdout.trim()).digest('hex')}`;
  }
  throw new Error('browser process identity unsupported');
}

export function registerNativeChild(receipt, child, birth) {
  receipt.native = { pid: child.pid, birth };
  const owner = {
    child,
    native: { ...receipt.native },
    driver: { ...receipt.driver },
    profile: receipt.profile,
  };
  owners.set(receipt.nonce, owner);
  if (child.exitCode !== null || child.signalCode) owner.child = null;
  else
    child.once('exit', () => {
      owner.child = null;
    });
}

export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  const { promise, resolve, reject } = Promise.withResolvers();
  child.once('exit', resolve);
  const terminate = setTimeout(() => child.kill('SIGKILL'), 8000);
  const deadline = setTimeout(() => reject(new Error('chrome-kill-incomplete')), 11000);
  child.kill('SIGTERM');
  try {
    await promise;
  } finally {
    clearTimeout(terminate);
    clearTimeout(deadline);
  }
}

async function retireOwnedNative(receipt) {
  const owner = owners.get(receipt.nonce);
  const native = receipt.native ?? {};
  const driver = receipt.driver ?? {};
  if (
    !owner ||
    owner.native.pid !== native.pid ||
    owner.native.birth !== native.birth ||
    owner.driver.pid !== driver.pid ||
    owner.driver.birth !== driver.birth ||
    owner.profile !== receipt.profile
  ) {
    throw new Error('browser native process identity mismatch; refusing cleanup');
  }
  await stopChild(owner.child);
}

async function externalSignal(child, signal) {
  if ((await processBirth(child.pid)) !== child.birth)
    throw new Error('browser native process identity mismatch; refusing cleanup');
  process.kill(child.pid, signal);
}

async function waitGone(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await pause(20);
  return !alive(pid);
}

export async function retireNative(receipt) {
  if (receipt.containerId !== null || receipt.containerName || receipt.socketDirectory)
    throw new Error('browser native receipt identity mismatch');
  const child = receipt.native;
  if (!child) return;
  if (receipt.driver?.pid === process.pid) {
    await retireOwnedNative(receipt);
    return;
  }
  if (!alive(child.pid)) return;
  if (platform() !== 'linux')
    throw new Error('external native process identity unsupported; refusing cleanup');
  await externalSignal(child, 'SIGTERM');
  if (await waitGone(child.pid, 8000)) return;
  await externalSignal(child, 'SIGKILL');
  if (!(await waitGone(child.pid, 3000))) throw new Error('browser native process remains');
}

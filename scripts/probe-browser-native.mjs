/** Native ownership is the issued ChildProcess capability, not a mutable ps command. */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

export function processIdentity(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.birth !== 'string'
  )
    throw new Error('Invalid trusted Docker process identity');
  if (
    !/^(?:linux:[1-9][0-9]*:[0-9]+|darwin:[1-9][0-9]*:[1-9][0-9]*:(?:0|[1-9][0-9]{0,5}))$/.test(
      value.birth,
    ) ||
    value.birth.split(':', 2)[1] !== String(value.pid)
  )
    throw new Error('Invalid trusted Docker process birth');
  return { pid: value.pid, birth: value.birth };
}

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

function darwinObservation(pid) {
  // SDK proc_bsdinfo: preserve the complete declared layout, not ps display or command text.
  const program = `
import ctypes, errno, sys
class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
        "ruid", "rgid", "svuid", "svgid", "reserved"
    )] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")
    ] + [("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64), ("microseconds", ctypes.c_uint64)]
assert ctypes.sizeof(BsdInfo) == 136
library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
library.proc_pidinfo.restype = ctypes.c_int
pid = int(sys.argv[1])
info = BsdInfo()
count = library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
if count == 0 and ctypes.get_errno() == errno.ESRCH:
    print("gone")
elif count == ctypes.sizeof(info) and info.pid == pid:
    print("ok", info.status, info.seconds, info.microseconds)
else:
    sys.exit(1)
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', program, String(pid)], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 2000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
  });
  if (result.error || result.status !== 0)
    throw new Error('browser process birth identity unavailable');
  if (result.stdout === 'gone\n')
    throw Object.assign(new Error('browser process absent'), { code: 'ESRCH' });
  const match = /^ok ([1-5]) ([1-9][0-9]*) (0|[1-9][0-9]*)\n$/.exec(result.stdout);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[3]) > 999999)
    throw new Error('browser process birth identity unavailable');
  return {
    birth: `darwin:${pid}:${match[2]}:${match[3]}`,
    state: ['I', 'R', 'S', 'T', 'Z'][Number(match[1]) - 1],
  };
}

async function processObservation(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('browser process identity invalid');
  if (platform() === 'linux') {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const ticks = fields[19];
    if (!/^[0-9]+$/.test(ticks ?? ''))
      throw new Error('browser process birth identity unavailable');
    return { birth: `linux:${pid}:${ticks}`, state: fields[0] };
  }
  if (platform() === 'darwin') return darwinObservation(pid);
  throw new Error('browser process identity unsupported');
}

export async function processBirth(pid) {
  return (await processObservation(pid)).birth;
}

/** A reaped or zombie driver cannot still own sockets; its birth identity remains independently usable. */
export async function liveProcessBirth(pid) {
  try {
    const observed = await processObservation(pid);
    if (['Z', 'X', 'x'].includes(observed.state)) return null;
    if (
      observed.state !== null &&
      !['R', 'S', 'D', 'T', 't', 'K', 'W', 'P', 'I'].includes(observed.state)
    )
      throw new Error('browser process state unavailable');
    return observed.birth;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
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

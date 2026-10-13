import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { processBirth } from './probe-browser-native.mjs';

const identity = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const unitName = (invocation, nonce) => {
  if (!identity(invocation) || !identity(nonce))
    throw new Error('Invalid acquisition scope identity');
  return `dsh-team-ci-${invocation}-acquire-${nonce}.scope`;
};
const environment = () => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
});
function systemctl(args, timeout = 15_000) {
  const result = spawnSync('systemctl', ['--user', ...args], {
    env: environment(),
    encoding: 'utf8',
    timeout,
    maxBuffer: 16_384,
  });
  if (result.error || result.status !== 0) throw new Error('Acquisition scope operation failed');
  return result.stdout.trim();
}

/** Move only the still-live issued producer before it receives authority to create anything. */
export async function retainAcquisition(producer, nonce, invocation) {
  const unit = unitName(invocation, nonce);
  if ((await processBirth(producer.pid)) !== producer.birth)
    throw new Error('Acquisition producer changed');
  const result = spawnSync(
    'busctl',
    [
      '--user',
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'StartTransientUnit',
      'ssa(sv)a(sa(sv))',
      unit,
      'fail',
      '4',
      'PIDs',
      'au',
      '1',
      String(producer.pid),
      'RuntimeMaxUSec',
      't',
      '60000000',
      'Description',
      's',
      `dsh-team-ci-acquisition:${invocation}:${nonce}`,
      'CollectMode',
      's',
      'inactive-or-failed',
      '0',
    ],
    { env: environment(), encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384 },
  );
  if (result.error || result.status !== 0) throw new Error('Acquisition scope transfer failed');
  // StartTransientUnit returns a queued job, not proof that the PID has moved.
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if ((await processBirth(producer.pid)) !== producer.birth)
      throw new Error('Acquisition producer changed');
    const group = systemctl(['show', unit, '--property=ControlGroup', '--value']);
    const actual = (await readFile(`/proc/${producer.pid}/cgroup`, 'utf8')).trim();
    if (group && actual === `0::${group}`) return;
    await delay(50);
  }
  throw new Error('Acquisition scope transfer was not observed');
}

/** Called only after the ordinary receipt owner has proved acquisition settlement and rescue. */
export function retireAcquisition(invocation, nonce) {
  stopOwnedUnit(unitName(invocation, nonce), `dsh-team-ci-acquisition:${invocation}:${nonce}`);
}

export function stopOwnedUnit(unit, description) {
  if (!/^dsh-team-ci-[a-f0-9-]{36}-(?:run(?:\.service)?|acquire-[a-f0-9-]{36}\.scope)$/.test(unit))
    throw new Error('Invalid owned unit name');
  const state = systemctl(['show', unit, '--property=LoadState,Description']).split('\n');
  if (state.includes('LoadState=not-found')) return;
  if (!state.includes(`Description=${description}`)) throw new Error('Owned unit identity changed');
  try {
    systemctl(['stop', unit], 60_000);
  } catch (error) {
    // --collect may retire this exact unit between the identity check and stop.
    if (systemctl(['show', unit, '--property=LoadState', '--value']) !== 'not-found') throw error;
  }
}

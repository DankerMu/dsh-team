// Owner-only custody preload: docker and flock processes become the owned fake daemon, and the
// host-wide deployment lock path can never be unlinked from the owner. Every child_process
// launch named docker or flock is either routed or refused, and counted in preload.jsonl, so
// no such call can reach a real binary unaccounted.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const daemon = fileURLToPath(new URL('./trusted-docker-fake-daemon.mjs', import.meta.url));
const calls = new URL('../../.run/fake-daemon/calls.jsonl', import.meta.url);
const ledger = new URL('../../.run/fake-daemon/preload.jsonl', import.meta.url);
const lock = '/tmp/dsh-team-deployment.lock';
const original = { ...childProcess };

function intercepted(command) {
  // Shell-form commands are scanned word by word; any docker/flock word is intercepted.
  const names = String(command)
    .split(/[\s;&|()`]+/)
    .map((word) => basename(word));
  return names.find((name) => name === 'docker' || name === 'flock');
}

// A ledger write failure fails the launch closed rather than leaving an uncounted call.
function account(outcome, name) {
  fs.appendFileSync(ledger, `${JSON.stringify([outcome, name])}\n`);
}

function refuse(name) {
  account('refused', name);
  throw new Error(`Fixture refuses unrouted ${name}`);
}

function launcher(launch) {
  return (command, ...rest) => {
    if (command === process.execPath && Array.isArray(rest[0]) && rest[0][1] === 'own')
      return launch(command, ['--import', import.meta.url, ...rest[0]], ...rest.slice(1));
    const name = intercepted(command);
    if (name === undefined) return launch(command, ...rest);
    const [args, options] = Array.isArray(rest[0]) ? rest : [[], rest[0]];
    if (basename(String(command)) !== name || options?.shell) return refuse(name);
    account('routed', name);
    return launch(process.execPath, [daemon, name, ...args], options);
  };
}

function refusing(run) {
  const wrapped = (command, ...rest) => {
    const name = intercepted(command);
    return name === undefined ? run(command, ...rest) : refuse(name);
  };
  const custom = run[promisify.custom];
  if (custom !== undefined) wrapped[promisify.custom] = refusing(custom);
  return wrapped;
}

childProcess.spawn = launcher(original.spawn);
childProcess.spawnSync = launcher(original.spawnSync);
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync'])
  childProcess[name] = refusing(original[name]);

function guard(remove) {
  return (path, ...rest) => {
    if (String(path) === lock) {
      fs.appendFileSync(calls, `${JSON.stringify(['unlink', lock])}\n`);
      throw new Error('Fixture forbids deployment lock removal');
    }
    return remove(path, ...rest);
  };
}
fs.unlinkSync = guard(fs.unlinkSync);
fs.rmSync = guard(fs.rmSync);
fsPromises.unlink = guard(fsPromises.unlink);
fsPromises.rm = guard(fsPromises.rm);
syncBuiltinESMExports();

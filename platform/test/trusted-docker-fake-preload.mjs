// Owner-only custody preload: docker and flock processes become the owned fake daemon, and the
// host-wide deployment lock path can never be unlinked from the owner.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemon = fileURLToPath(new URL('./trusted-docker-fake-daemon.mjs', import.meta.url));
const calls = new URL('../../.run/fake-daemon/calls.jsonl', import.meta.url);
const lock = '/tmp/dsh-team-deployment.lock';
const { spawn, spawnSync } = childProcess;

function route(command, args) {
  if (!Array.isArray(args)) return [command, args];
  if (command === process.execPath && args[1] === 'own')
    return [command, ['--import', import.meta.url, ...args]];
  const name = basename(String(command));
  if (name === 'docker' || name === 'flock') return [process.execPath, [daemon, name, ...args]];
  return [command, args];
}
childProcess.spawn = (command, args, options) => spawn(...route(command, args), options);
childProcess.spawnSync = (command, args, options) => spawnSync(...route(command, args), options);

function guard(original) {
  return (path, ...rest) => {
    if (String(path) === lock) {
      fs.appendFileSync(calls, `${JSON.stringify(['unlink', lock])}\n`);
      throw new Error('Fixture forbids deployment lock removal');
    }
    return original(path, ...rest);
  };
}
fs.unlinkSync = guard(fs.unlinkSync);
fs.rmSync = guard(fs.rmSync);
fsPromises.unlink = guard(fsPromises.unlink);
fsPromises.rm = guard(fsPromises.rm);
syncBuiltinESMExports();

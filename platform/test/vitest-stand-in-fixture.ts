import { fileURLToPath } from 'node:url';

const vitestEntry = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));

/**
 * CommonJS text of a stand-in vitest main process. Its signal handlers are installed before the
 * `started.json` marker ({ pid, args }); a signal publishes `signal.json` then `exit.json` and
 * exits zero. Without `hold` it exits zero right after `started.json`. With `release`, the first
 * signal publishes `signal.json` and the stand-in exits zero only after the `release` file
 * exists; every later signal publishes `repeat.json` instead.
 */
export function vitestStandIn(markers: string, hold: boolean, release?: string): string {
  return `const fs = require('node:fs');
const markers = ${JSON.stringify(markers)};
function publish(name, value) {
  const path = markers + '/' + name;
  fs.writeFileSync(path + '.pending', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(path + '.pending', path);
}
${release === undefined ? exitOnSignal : holdUntilRelease(release)}
publish('started.json', { pid: process.pid, args: process.argv.slice(2) });
if (${JSON.stringify(hold)}) setInterval(() => {}, 60000);
`;
}

const exitOnSignal = `for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    publish('signal.json', { signal, pid: process.pid });
    publish('exit.json', { pid: process.pid });
    process.exit(0);
  });
}`;

function holdUntilRelease(release: string): string {
  return `let signaled = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (signaled) return publish('repeat.json', { signal, pid: process.pid });
    signaled = true;
    publish('signal.json', { signal, pid: process.pid });
    setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      publish('exit.json', { pid: process.pid });
      process.exit(0);
    }, 20);
  });
}`;
}

/**
 * Preload statements that record every `child_process.spawn` call as a `{ file, args }` JSON line
 * and run `standIn` in place of the repository vitest entry under this Node; other calls pass
 * through unchanged. The host preload must call `syncBuiltinESMExports()` afterwards.
 */
export function vitestSpawnInterception(standIn: string, log: string): string {
  return `{
  const childProcess = process.getBuiltinModule('node:child_process');
  const { appendFileSync } = process.getBuiltinModule('node:fs');
  const spawn = childProcess.spawn;
  childProcess.spawn = (file, args, ...rest) => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ file, args }) + '\\n', { mode: 0o600 });
    if (file !== process.execPath || !Array.isArray(args) || args[0] !== ${JSON.stringify(vitestEntry)})
      return spawn(file, args, ...rest);
    return spawn(file, [${JSON.stringify(standIn)}, ...args.slice(1)], ...rest);
  };
}
`;
}

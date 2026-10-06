import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startChrome } from '../../scripts/probe-dsh-api-cdp.mjs';

const SECRET = 'sk-chrome-discovery-secret';

function fakeChrome(script: string): { bin: string; work: string } {
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-chrome-start-'));
  const bin = join(work, 'chrome');
  writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return { bin, work };
}

it('stops the spawned child when PID file writing fails after start', async () => {
  const { bin, work } = fakeChrome(`
require('node:http').createServer().listen(0, '127.0.0.1');
process.stderr.write(${JSON.stringify(SECRET)});
`);
  const profile = join(work, 'profile');
  mkdirSync(profile);
  const pidFile = join(work, 'missing', 'chrome.pid');
  try {
    await startChrome(bin, profile, pidFile);
    throw new Error('must reject PID write failure');
  } catch (error) {
    expect(String(error)).toMatch(/^Error: chrome-start /);
    expect(String(error)).not.toContain(SECRET);
    expect(error).not.toHaveProperty('cause');
  }
});

it('stops the spawned child when debugger discovery returns invalid JSON', async () => {
  const { bin, work } = fakeChrome(`
const net = require('node:net');
const portFlag = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = Number(portFlag.slice('--remote-debugging-port='.length));
const server = net.createServer((socket) => {
  socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\nnot-json ${SECRET}');
});
server.listen(port, '127.0.0.1');
process.stderr.write(${JSON.stringify(SECRET)});
`);
  const profile = join(work, 'profile');
  mkdirSync(profile);
  const pidFile = join(work, 'chrome.pid');
  try {
    await startChrome(bin, profile, pidFile);
    throw new Error('must reject debugger JSON failure');
  } catch (error) {
    expect(String(error)).toMatch(/^Error: chrome-start /);
    expect(String(error)).not.toContain(SECRET);
    expect(error).not.toHaveProperty('cause');
  }
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startChrome } from '../../scripts/probe-dsh-api-cdp.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';

it('refuses a stale native process receipt and retires only the matching browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-identity-'));
  const bin = join(root, 'chrome');
  const receiptFile = join(root, 'receipt.json');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const http = require('node:http');
if (['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'].some(key=>process.env[key]!==undefined))process.exit(23);
const port = Number(process.argv.find(x => x.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((req, res) => res.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/browser/owned'}))).listen(port,'127.0.0.1',()=>{process.title='owned-native-process-after-listen';});
`,
    { mode: 0o755 },
  );
  let chrome;
  try {
    vi.stubEnv('HTTP_PROXY', 'http://browser-must-not-inherit.invalid:80');
    vi.stubEnv('HTTPS_PROXY', 'http://browser-must-not-inherit.invalid:443');
    vi.stubEnv('NO_PROXY', '*');
    chrome = await startChrome({
      runtime: { kind: 'native', bin },
      origin: 'http://127.0.0.1:12345',
      profile: join(root, 'profile'),
      receiptFile,
    });
    const original = await readFile(receiptFile, 'utf8');
    const receipt = JSON.parse(original) as { native: { pid: number; birth: string } };
    const pid = receipt.native.pid;
    const port = Number(new URL(chrome.browserWs).port);
    await writeFile(
      receiptFile,
      JSON.stringify({
        ...receipt,
        native: { ...receipt.native, birth: 'stale-process-identity' },
      }),
    );
    await expect(rescueChrome(receiptFile)).rejects.toThrow('identity');
    expect(process.kill(pid, 0)).toBe(true);
    await writeFile(receiptFile, original);
    await rescueChrome(receiptFile);
    expect(() => process.kill(pid, 0)).toThrow();
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('browser listener survived rescue'));
    });
    socket.once('error', () => {
      resolve(undefined);
    });
    await promise;
  } finally {
    await chrome?.stop();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

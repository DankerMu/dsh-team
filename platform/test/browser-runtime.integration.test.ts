import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
  let original: string | undefined;
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
    original = await readFile(receiptFile, 'utf8');
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
    await expect(rescueChrome(receiptFile)).rejects.toThrow();
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
    const obsolete = JSON.stringify({
      ...receipt,
      native: { ...receipt.native, birth: `darwin:${String(pid)}:${'a'.repeat(64)}` },
    });
    await writeFile(receiptFile, obsolete);
    await expect(rescueChrome(receiptFile)).rejects.toThrow();
    expect(await readFile(receiptFile, 'utf8')).toBe(obsolete);
  } finally {
    if (original !== undefined) await writeFile(receiptFile, original);
    await chrome?.stop();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

function observeNativeBirth(pid: number, locale: string, timezone: string): unknown {
  const module = new URL('../../scripts/probe-browser-native.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {processBirth} from ${JSON.stringify(module)};process.stdout.write(JSON.stringify(await processBirth(Number(process.argv[1]))));`,
      String(pid),
    ],
    {
      env: { PATH: process.env.PATH, LANG: locale, LC_ALL: locale, TZ: timezone },
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4096,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const value: unknown = JSON.parse(result.stdout);
  expect(typeof value).toBe('string');
  return value;
}

it('keeps the same process birth across an acknowledged exec and different observer locales', async () => {
  const child = spawn(
    'python3',
    [
      '-I',
      '-c',
      'import os,sys\nprint(os.getpid(),flush=True)\nsys.stdin.readline()\nos.execv(sys.argv[1],[sys.argv[1],"-e","process.stdout.write(String(process.pid));setInterval(()=>{},1000)"])',
      process.execPath,
    ],
    { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const closed = once(child, 'close');
  try {
    const beforeReady: unknown = (await once(child.stdout, 'data'))[0];
    if (child.pid === undefined) throw new Error('Owned exec process missing');
    expect(String(beforeReady).trim()).toBe(String(child.pid));
    const before = observeNativeBirth(child.pid, 'C', 'UTC');
    const independent = observeNativeBirth(process.pid, 'C', 'UTC');
    expect(before).not.toBe(independent);

    const afterReady = once(child.stdout, 'data');
    child.stdin.end('exec\n');
    const after: unknown = (await afterReady)[0];

    expect(String(after)).toBe(String(child.pid));
    expect(observeNativeBirth(child.pid, 'C', 'UTC')).toBe(before);
    expect(observeNativeBirth(child.pid, 'zh_CN.UTF-8', 'Asia/Shanghai')).toBe(before);
    expect(observeNativeBirth(child.pid, 'en_US.UTF-8', 'America/Los_Angeles')).toBe(before);
    expect(process.kill(child.pid, 0)).toBe(true);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});

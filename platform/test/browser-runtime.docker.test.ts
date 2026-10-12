import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { connectPage, observeNetwork, startChrome } from '../../scripts/probe-dsh-api-cdp.mjs';
import { navigateReady } from '../../scripts/probe-mapped-host.mjs';
import { record } from './container-start-docker-fixture.ts';
import {
  browserPressureClient,
  execBrowser,
  OwnedBrowserChurn,
  withIsolatedBrowser,
} from './browser-runtime-fixture.ts';
import {
  browserDocker,
  chromeDigest,
  isolatedBrowserRuntime,
  rescueChrome,
} from '../../scripts/probe-browser-runtime.mjs';
import { retainPageRequestFailure } from '../../scripts/probe-browser-evidence.mjs';

const networkMethods = {
  request: 'Network.requestWillBeSent',
  priority: 'Network.resourceChangedPriority',
  response: 'Network.responseReceived',
  failed: 'Network.loadingFailed',
  finished: 'Network.loadingFinished',
} as const;
const acquisitionFence = vi.hoisted(() => ({
  path: '',
  observed: undefined as (() => undefined) | undefined,
  release: Promise.resolve(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const value = await actual.readFile(...args);
      if (typeof args[0] === 'string' && args[0] === acquisitionFence.path) {
        acquisitionFence.observed?.();
        await acquisitionFence.release;
      }
      return value;
    },
  };
});
afterEach(() => {
  acquisitionFence.path = '';
  acquisitionFence.observed = undefined;
  acquisitionFence.release = Promise.resolve();
});

async function awaitFile(path: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  // Real filesystem/process completion is bounded; this signal is not a guessed sleep.
  const signal = AbortSignal.timeout(15000);
  const aborted = () => {
    reject(new Error('Owned creation fixture completion missing'));
  };
  signal.addEventListener('abort', aborted, { once: true });
  const watcher = watch(dirname(path), { signal }, (_event, name) => {
    if (name === basename(path)) resolve(undefined);
  });
  watcher.once('error', reject);
  try {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await promise;
    await lstat(path);
  } finally {
    watcher.close();
    signal.removeEventListener('abort', aborted);
  }
}

const waitUntil = async (ready: () => boolean, until: number) => {
  while (!ready()) {
    if (Date.now() >= until) throw new Error('Browser regression completion barrier failed');
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setImmediate(() => {
      resolve(undefined);
    });
    await promise;
  }
};

it('preserves large duplex bytes and server replies after the client half-closes', async () => {
  const payloadBytes = 32 * 1024 * 1024;
  const producerHighWaterMark = 8 * 1024 * 1024;
  const receivedHash = createHash('sha256');
  let receivedBytes = 0;
  let identicalBytes = true;
  let clientFinObserved = false;
  let pressureReleased = false;
  let receiver: Socket | undefined;
  let receiverError: Error | undefined;
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    receiver = socket;
    socket.once('error', (error) => {
      receiverError = error;
    });
    // Acknowledging the paused real destination gates production across the actual relay.
    socket.pause();
    socket.on('data', (chunk: Buffer) => {
      // The wire contract is consecutive uint32 LE words, beginning at zero.
      // Validate every byte independently of the producer's word-writing implementation.
      for (let index = 0; index < chunk.length; index++) {
        const offset = receivedBytes + index;
        const expected = (Math.floor(offset / 4) >>> ((offset % 4) * 8)) & 255;
        if (chunk[index] !== expected) identicalBytes = false;
      }
      receivedBytes += chunk.length;
      receivedHash.update(chunk);
    });
    socket.once('end', () => {
      clientFinObserved = true;
      socket.end('server-response-after-client-fin');
    });
    socket.write('receiver-paused\n');
  });
  await withIsolatedBrowser(server, async (_browser, origin, receipt) => {
    const port = new URL(origin).port;
    const proof = record(
      JSON.parse(
        await execBrowser(
          receipt.containerId,
          browserPressureClient(Number(port), payloadBytes, producerHighWaterMark),
          (line) => {
            expect(line).toBe('pressure');
            expect(pressureReleased).toBe(false);
            expect(receiver?.isPaused()).toBe(true);
            expect(receivedBytes).toBe(0);
            pressureReleased = true;
            // Docker stdout is the independent release barrier, never blocked payload bytes.
            receiver?.resume();
          },
        ),
      ),
    );

    expect(proof.pressureSentBytes).toBeGreaterThanOrEqual(producerHighWaterMark);
    expect(proof.pressureSentBytes).toBeLessThanOrEqual(payloadBytes);
    expect(proof.pressurePendingBytes).toBeGreaterThanOrEqual(producerHighWaterMark);
    expect(proof.pressurePendingBytes).toBeLessThan(producerHighWaterMark + 65536);
    expect(proof).toMatchObject({
      backpressure: true,
      sentBytes: payloadBytes,
      sha256: receivedHash.digest('hex'),
      reply: 'server-response-after-client-fin',
    });
    expect(pressureReleased).toBe(true);
    expect(clientFinObserved).toBe(true);
    expect(receivedBytes).toBe(payloadBytes);
    expect(receiverError).toBeUndefined();
    expect(identicalBytes).toBe(true);
  });
});

it('keeps original authority, Strict cookie and real WebSocket upgrade through navigation and reload', async () => {
  const requests: {
    host: string | undefined;
    cookie: string | undefined;
    origin?: string | undefined;
  }[] = [];
  const frames: string[] = [];
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(204).end();
      return;
    }
    requests.push({ host: request.headers.host, cookie: request.headers.cookie });
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(
      '<!doctype html><html><body><script>const ws=new WebSocket("ws://"+location.host+"/wire");ws.onopen=()=>ws.send("owned-browser-client");ws.onmessage=e=>window.__wire=e.data;</script></body></html>',
    );
  });
  server.on('upgrade', (request, socket) => {
    requests.push({
      host: request.headers.host,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
    });
    const accept = createHash('sha1')
      .update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      if (pending.length < 6) return;
      const length = pending.readUInt8(1) & 127;
      if (length >= 126 || pending.length < 6 + length || (pending.readUInt8(0) & 15) !== 1) return;
      const payload = Buffer.from(pending.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i++)
        payload.writeUInt8(payload.readUInt8(i) ^ pending.readUInt8(2 + (i % 4)), i);
      frames.push(payload.toString());
      pending = pending.subarray(6 + length);
      const reply = Buffer.from('owned-server-reply');
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  await withIsolatedBrowser(server, async (browser, origin) => {
    for (const reload of [false, true]) {
      if (reload) await browser.page.send('Page.reload', { ignoreCache: true });
      else await browser.page.send('Page.navigate', { url: `${origin}/` });
      const until = Date.now() + 30000;
      await waitUntil(() => frames.length === (reload ? 2 : 1), until);
      let reply: unknown;
      while (reply !== 'owned-server-reply') {
        const result = record(
          await browser.page.send('Runtime.evaluate', {
            expression: 'window.__wire',
            returnByValue: true,
          }),
        );
        reply = record(result.result).value;
        if (Date.now() >= until) throw new Error('Real WebSocket browser response missing');
      }
    }
    const authority = new URL(origin).host;
    expect(frames).toEqual(['owned-browser-client', 'owned-browser-client']);
    expect(requests).toEqual([
      { host: authority, cookie: 'owned=private-fixture-cookie' },
      { host: authority, cookie: 'owned=private-fixture-cookie', origin },
      { host: authority, cookie: 'owned=private-fixture-cookie' },
      { host: authority, cookie: 'owned=private-fixture-cookie', origin },
    ]);
    expect(browser.errors).toEqual([]);
  });
});

it('completes the observed High-priority queued request under an owned host bridge transition without relaxing readiness', async () => {
  const churn = new OwnedBrowserChurn();
  const artifactRoot = join(process.cwd(), '.run', 'issue179');
  await mkdir(artifactRoot, { recursive: true });
  const evidence = await mkdtemp(join(artifactRoot, 'browser-network-'));
  const phases: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    scope:
      'controlled queued-request regression; real platform authentication remains separate full-suite acceptance',
    node: process.version,
    originalBrowserMs: 30000,
    phases,
    cleanup: 'not-yet-observed',
  };
  let failure: { error: unknown } | undefined;
  try {
    await churn.prepare();
    for (const arm of ['no-churn', 'transition']) {
      const phase: Record<string, unknown> = { arm, status: 'running' };
      phases.push(phase);
      const holds = new Map<number, { response: ServerResponse; socket: Socket }>();
      let targetReceived = false;
      const server = createServer((request, response) => {
        if (request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          response.end(
            '<!doctype html><html><body><script>for(let i=0;i<6;i++)fetch("/hold/"+i).catch(()=>{});</script></body></html>',
          );
        } else if (/^\/hold\/[0-5]$/.test(request.url ?? '')) {
          const ordinal = Number(request.url?.at(-1));
          if (request.httpVersion !== '1.1' || holds.has(ordinal)) {
            response.writeHead(409).end();
            return;
          }
          holds.set(ordinal, { response, socket: request.socket });
        } else if (request.url === '/assets/queued.js') {
          targetReceived = true;
          response.writeHead(200, {
            'content-type': 'application/javascript',
            'cache-control': 'no-store',
          });
          response.end(
            'const b=document.createElement("button");b.setAttribute("aria-label","New session");b.textContent="New session";document.body.appendChild(b);',
          );
        } else {
          response.writeHead(204).end();
        }
      });
      await withIsolatedBrowser(server, async (browser, origin, _receipt, namespace) => {
        phase.namespace = namespace;
        let targetId = '',
          priority: unknown = null,
          terminal = false,
          targetStatus: unknown = null;
        const stop = observeNetwork(browser.page, {
          [networkMethods.request]: (event: {
            requestId: string;
            request: { url: string; initialPriority?: string };
          }) => {
            if (new URL(event.request.url).pathname === '/assets/queued.js') {
              targetId = event.requestId;
              priority = event.request.initialPriority ?? null;
            }
          },
          [networkMethods.priority]: (event: { requestId: string; newPriority?: string }) => {
            if (event.requestId === targetId) priority = event.newPriority ?? null;
          },
          [networkMethods.response]: (event: {
            requestId: string;
            response: { status: number };
          }) => {
            if (event.requestId === targetId) {
              terminal = true;
              targetStatus = event.response.status;
            }
          },
          [networkMethods.failed]: (event: { requestId: string }) => {
            if (event.requestId === targetId) terminal = true;
          },
          [networkMethods.finished]: (event: { requestId: string }) => {
            if (event.requestId === targetId) terminal = true;
          },
        });
        const until = Date.now() + 30000;
        const navigation = navigateReady(browser.page, origin, 30000);
        void navigation.catch(() => undefined);
        try {
          await waitUntil(() => holds.size === 6, until);
          expect(new Set([...holds.values()].map(({ socket }) => socket)).size).toBe(6);
          await browser.page.send('Runtime.evaluate', {
            expression:
              '(()=>{const s=document.createElement("script");s.fetchPriority="high";s.src="/assets/queued.js";document.head.appendChild(s);return true})()',
            returnByValue: true,
          });
          await waitUntil(() => targetId !== '' && priority === 'High', until);
          expect(targetReceived).toBe(false);
          expect(terminal).toBe(false);
          expect(
            [...holds.values()].filter(
              ({ response }) => !response.destroyed && !response.writableEnded,
            ),
          ).toHaveLength(6);
          phase.queueBarrier = {
            occupied: 6,
            distinct: 6,
            targetServerReceived: false,
            latestPriority: priority,
            observedMs: performance.now(),
            clock: 'host-node-performance-ms',
          };
          if (arm === 'transition') {
            const witness = await churn.transition();
            expect(witness.ownedBridge).toBe(true);
            expect(witness.ipv4AddressObserved).toBe(true);
            expect(witness.primaryMembershipPreserved).toBe(true);
            phase.hostTransition = witness;
          }
          expect(targetReceived).toBe(false);
          expect(priority).toBe('High');
          expect(terminal).toBe(false);
          expect(
            [...holds.values()].filter(
              ({ response }) => !response.destroyed && !response.writableEnded,
            ),
          ).toHaveLength(6);
          expect(new Set([...holds.values()].map(({ socket }) => socket)).size).toBe(6);
          const first = holds.values().next().value;
          if (!first) throw new Error('Occupied connection disappeared');
          first.response.end('released');
          await navigation;
          expect(targetReceived).toBe(true);
          expect(targetStatus).toBe(200);
          expect(browser.errors).toEqual([]);
          Object.assign(phase, {
            status: 'completed',
            target200: true,
            navigationReady: true,
            consoleErrorCount: 0,
            observedCompletionMs: performance.now(),
          });
        } catch (error) {
          Object.assign(phase, {
            status: 'failed',
            targetServerReceived: targetReceived,
            targetStatus: typeof targetStatus === 'number' ? targetStatus : null,
            consoleErrorCount: browser.errors.length,
          });
          await retainPageRequestFailure(browser.page, join(evidence, `${arm}.png`));
          throw error;
        } finally {
          stop();
          for (const { response } of holds.values()) response.end('done');
          await navigation.catch(() => undefined);
        }
      });
    }
    report.outcome = 'completed-controls';
  } catch (error) {
    failure = { error };
    report.outcome = 'failed';
  }
  let cleanup: { error: unknown } | undefined;
  report.ownedResources = {
    runId: churn.runId,
    networks: churn.networks,
    helper: churn.helper ?? null,
  };
  try {
    churn.cleanup();
    report.cleanup = 'verified-empty-owned-inventory';
  } catch (error) {
    cleanup = { error };
    report.cleanup = 'incomplete';
  }
  try {
    await writeFile(join(evidence, 'controls.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  } catch {
    if (!failure && !cleanup) throw new Error('Controlled runtime evidence retention failed');
  }
  process.stdout.write(`Browser network regression evidence=${evidence}\n`);
  if (cleanup) {
    const errors = failure ? [failure.error, cleanup.error] : [cleanup.error];
    throw new AggregateError(errors, 'Controlled browser cleanup incomplete', {
      cause: errors[0],
    });
  }
  if (failure) throw failure.error;
});

it('refuses changed or contradictory ownership without retiring the matching browser', async () => {
  const server = createServer((_request, response) => response.end('owned'));
  await withIsolatedBrowser(server, async (browser, _origin, receipt) => {
    const receiptFile = join(dirname(receipt.profile), 'chrome.receipt.json');
    const original = await readFile(receiptFile, 'utf8');
    const fields = [
      { containerName: 'dsh-team-browser-00000000-0000-0000-0000-000000000000' },
      { nonce: '00000000-0000-0000-0000-000000000000' },
      { imageId: `sha256:${'0'.repeat(64)}` },
      { containerId: '0'.repeat(64) },
      { networkName: 'dsh-team-browser-net-00000000-0000-0000-0000-000000000000' },
      { networkId: '0'.repeat(64) },
      { networkId: undefined },
      { networkConfig: { ...receipt.networkConfig, internal: false } },
      { acquisition: { state: 'not-started' } },
    ];
    try {
      for (const changed of fields) {
        await writeFile(receiptFile, JSON.stringify({ ...receipt, ...changed }), { mode: 0o600 });
        await expect(rescueChrome(receiptFile)).rejects.toThrow();
        expect(
          browserDocker([
            'container',
            'inspect',
            '--format',
            '{{.State.Running}}',
            receipt.containerId,
          ]),
        ).toBe('true');
        const response = record(
          await browser.page.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }),
        );
        expect(record(response.result).value).toBe(2);
      }
    } finally {
      await writeFile(receiptFile, original);
    }
  });
});

it('adopts only an explicitly pending identity and settles active application and CDP streams', async () => {
  const server = createTcpServer({ allowHalfOpen: true });
  const accepted = once(server, 'connection');
  await withIsolatedBrowser(server, async (browser, origin, receipt) => {
    const client = execBrowser(
      receipt.containerId,
      `const s=require('node:net').connect({host:'127.0.0.1',port:${new URL(origin).port}});s.on('error',()=>{});`,
    );
    void client.catch(() => undefined);
    const [socket] = (await accepted) as [Socket];
    const finished = once(socket, 'end');
    const receiptFile = join(dirname(receipt.profile), 'chrome.receipt.json');
    const original: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
    await writeFile(
      receiptFile,
      JSON.stringify({
        ...record(original),
        containerId: null,
        networkId: null,
        state: 'pending-identity',
      }),
    );
    await rescueChrome(receiptFile);
    await finished;
    await client.catch(() => undefined);
    const retired = record(JSON.parse(await readFile(receiptFile, 'utf8')));
    expect(retired.containerId).toBe(receipt.containerId);
    expect(retired.networkId).toBe(receipt.networkId);
    expect(retired.state).toBe('stopped');
    await expect(lstat(receipt.socketDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    const cdp = createConnection({ host: '127.0.0.1', port: receipt.debugPort });
    cdp.once('connect', () => {
      cdp.destroy();
      reject(new Error('Owned CDP listener survived rescue'));
    });
    cdp.once('error', () => {
      resolve(undefined);
    });
    await promise;
    expect(
      browserDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
    expect(
      browserDocker([
        'network',
        'ls',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
    await expect(
      execBrowser(receipt.containerId, 'process.stdout.write("unexpected-live-browser")'),
    ).rejects.toThrow();
    await browser.chrome.stop();
  });
});

it.each(['network-before-id', 'network-after-id-before-container', 'container-before-id'])(
  'settles the still-live producer after driver death at %s before publishing complete cleanup',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-partial-create-'));
    const receiptFile = join(root, 'chrome.receipt.json');
    const marker = join(root, 'created');
    const released = join(root, 'release');
    const returned = join(root, 'returned');
    const realDocker = execFileSync('which', ['docker'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    }).trim();
    const originalPath = process.env.PATH;
    const runtimeModule = fileURLToPath(
      new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url),
    );
    const launcherModule = fileURLToPath(
      new URL('../../scripts/probe-dsh-api-cdp.mjs', import.meta.url),
    );
    const shim = join(root, 'docker');
    await writeFile(
      shim,
      `#!/usr/bin/env node
const fs=require('node:fs');const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
const phase=${JSON.stringify(phase)};
const matches=phase==='network-before-id'?args[0]==='network'&&args[1]==='create':args[0]==='create';
async function hold(id){
    const {promise,resolve}=Promise.withResolvers();
    const watcher=fs.watch(${JSON.stringify(root)},(_event,name)=>{if(name==='release')resolve();});
    fs.writeFileSync(${JSON.stringify(marker + '.tmp')},id,{mode:0o600});
    fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});
    if(!fs.existsSync(${JSON.stringify(released)}))await promise;
    watcher.close();
}
async function run(){
  if(matches&&phase==='network-after-id-before-container')await hold('');
  const result=spawnSync(${JSON.stringify(realDocker)},args,{encoding:'utf8',env:{PATH:${JSON.stringify(originalPath)},DOCKER_CONFIG:process.env.DOCKER_CONFIG},timeout:30000});
  if(matches&&result.status===0){
    if(phase!=='network-after-id-before-container')await hold(result.stdout);
    fs.writeFileSync(${JSON.stringify(returned + '.tmp')},result.stdout,{mode:0o600});
    fs.renameSync(${JSON.stringify(returned + '.tmp')},${JSON.stringify(returned)});
  }
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status===0?0:1;
}
run().catch(()=>{process.exitCode=1;});
`,
      { mode: 0o755 },
    );
    const driver = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {startChrome} from ${JSON.stringify(launcherModule)};import {isolatedBrowserRuntime} from ${JSON.stringify(runtimeModule)};const chrome=await startChrome({runtime:isolatedBrowserRuntime(),origin:'http://127.0.0.1:12345',profile:${JSON.stringify(join(root, 'profile'))},receiptFile:${JSON.stringify(receiptFile)}});await chrome.stop();`,
      ],
      { env: { ...process.env, PATH: `${root}:${originalPath ?? ''}` }, stdio: 'ignore' },
    );
    const exited = once(driver, 'exit');
    let pending: Promise<void> | undefined;
    const birthObserved = Promise.withResolvers<undefined>();
    const birthReleased = Promise.withResolvers<undefined>();
    try {
      await awaitFile(marker);
      const id = (await readFile(marker, 'utf8')).trim();
      const before = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      const producer = record(record(before.acquisition).producer);
      if (typeof producer.pid !== 'number')
        throw new Error('Partial-creation producer identity missing');
      expect(before.containerId).toBeNull();
      if (phase === 'network-before-id') expect(before.networkId).toBeNull();
      else expect(before.networkId).toMatch(/^[a-f0-9]{64}$/);
      expect(before.state).toBe('pending-identity');
      expect(driver.kill('SIGKILL')).toBe(true);
      await exited;
      process.env.PATH = `${root}:${originalPath ?? ''}`;
      acquisitionFence.path = `/proc/${String(producer.pid)}/stat`;
      acquisitionFence.observed = () => {
        birthObserved.resolve(undefined);
        return undefined;
      };
      acquisitionFence.release = birthReleased.promise;
      pending = rescueChrome(receiptFile);
      void pending.catch(() => undefined);
      const deadline = AbortSignal.timeout(15000);
      await Promise.race([
        birthObserved.promise,
        once(deadline, 'abort').then(() => {
          throw new Error('Acquisition was not fenced by live producer identity');
        }),
      ]);
      const during = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      expect(during.containerId).toBeNull();
      expect(record(during.acquisition).state).toBe('creating');
      await writeFile(released, 'release');
      await awaitFile(returned);
      const returnedId = (await readFile(returned, 'utf8')).trim();
      birthReleased.resolve(undefined);
      await pending;
      const after = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      expect(after.state).toBe('stopped');
      if (phase === 'network-before-id') expect(after.networkId).toBe(id);
      else expect(after.containerId).toBe(returnedId);
      expect(after.networkId).toMatch(/^[a-f0-9]{64}$/);
      expect(after.containerId).toMatch(/^[a-f0-9]{64}$/);
      expect(record(after.acquisition).state).toBe('settled');
      expect(
        browserDocker([
          'container',
          'ls',
          '--all',
          '--filter',
          `label=dsh-team.browser-nonce=${String(after.nonce)}`,
          '--quiet',
          '--no-trunc',
        ]),
      ).toBe('');
      expect(
        browserDocker([
          'network',
          'ls',
          '--filter',
          `label=dsh-team.browser-nonce=${String(after.nonce)}`,
          '--quiet',
          '--no-trunc',
        ]),
      ).toBe('');
    } finally {
      try {
        birthReleased.resolve(undefined);
        await writeFile(released, 'release');
        if (driver.exitCode === null && !driver.signalCode) {
          driver.kill('SIGKILL');
          await exited;
        }
        await pending?.catch(() => undefined);
        await rescueChrome(receiptFile);
        await rm(root, { recursive: true, force: true });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    }
  },
);

it('retains a nonsecret failed-discovery receipt and retires its browser, relays and socket files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-discovery-'));
  const directory = join(root, 'chrome-headless-shell-linux64');
  const receiptFile = join(root, 'chrome.receipt.json');
  await mkdir(directory);
  const bin = join(directory, 'chrome-headless-shell');
  const secret = 'short-cookie-poison';
  await writeFile(
    bin,
    `#!/usr/bin/env node
const http=require('node:http');
const port=Number(process.argv.find(x=>x.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((req,res)=>res.end(${JSON.stringify('not-json ' + secret)})).listen(port,'127.0.0.1');
`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, 'deb.deps'), 'deliberately broken external browser fixture\\n');
  let failure: unknown;
  try {
    try {
      await startChrome({
        runtime: {
          ...isolatedBrowserRuntime(),
          chromeDirectory: directory,
          chromeSha256: await chromeDigest(bin),
        },
        origin: 'http://127.0.0.1:12345',
        profile: join(root, 'profile'),
        receiptFile,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secret);
    const receipt = record(JSON.parse(await readFile(receiptFile, 'utf8')));
    expect(receipt.state).toBe('stopped');
    if (typeof receipt.socketDirectory !== 'string' || typeof receipt.nonce !== 'string')
      throw new Error('Failed discovery ownership receipt missing');
    await expect(lstat(receipt.socketDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      browserDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
  } finally {
    await rescueChrome(receiptFile);
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses handle cleanup with changed ownership without closing the matching browser connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-handle-identity-'));
  const receiptFile = join(root, 'chrome.receipt.json');
  const chrome = await startChrome({
    runtime: isolatedBrowserRuntime(),
    origin: 'http://127.0.0.1:12345',
    profile: join(root, 'profile'),
    receiptFile,
  });
  const page = await connectPage(chrome.browserWs);
  const original = await readFile(receiptFile, 'utf8');
  try {
    const receipt = record(JSON.parse(original));
    await writeFile(
      receiptFile,
      JSON.stringify({ ...receipt, imageId: `sha256:${'0'.repeat(64)}` }),
    );
    await expect(chrome.stop()).rejects.toThrow();
    const response = record(
      await page.send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }),
    );
    expect(record(response.result).value).toBe(42);
  } finally {
    await writeFile(receiptFile, original);
    page.close();
    await rescueChrome(receiptFile);
    await rm(root, { recursive: true, force: true });
  }
});

it('repeatedly verifies stopped absence after a definite image rejection without adopting a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-rejected-image-'));
  const receiptFile = join(root, 'chrome.receipt.json');
  try {
    await expect(
      startChrome({
        runtime: { ...isolatedBrowserRuntime(), imageId: `sha256:${'0'.repeat(64)}` },
        origin: 'http://127.0.0.1:12345',
        profile: join(root, 'profile'),
        receiptFile,
      }),
    ).rejects.toThrow();
    await rescueChrome(receiptFile);
    await rescueChrome(receiptFile);
    const receipt = record(JSON.parse(await readFile(receiptFile, 'utf8')));
    expect(receipt).toMatchObject({
      state: 'stopped',
      containerId: null,
      acquisition: { state: 'settled' },
    });
    if (typeof receipt.nonce !== 'string') throw new Error('Rejected launch receipt missing');
    expect(
      browserDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `label=dsh-team.browser-nonce=${receipt.nonce}`,
        '--quiet',
        '--no-trunc',
      ]),
    ).toBe('');
  } finally {
    await rescueChrome(receiptFile);
    await rm(root, { recursive: true, force: true });
  }
});

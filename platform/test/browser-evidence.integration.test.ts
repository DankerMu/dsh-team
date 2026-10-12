import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectPage, observeNetwork } from '../../scripts/probe-dsh-api-cdp.mjs';
import {
  collectRequestEvidence,
  retainRequestFailure,
} from '../../scripts/probe-browser-evidence.mjs';
import type { RequestFailureEvidence } from '../../scripts/probe-browser-evidence.mjs';
import { acceptObservation } from '../../scripts/probe-mapped-host.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';

interface ProtocolListener {
  handler: (event: { data?: string }) => void;
  once: boolean;
}
const loadingFailed = 'Network.loadingFailed';
class ProtocolSocket {
  static current: ProtocolSocket;
  readyState = 1;
  readonly listeners = new Map<string, Set<ProtocolListener>>();
  constructor() {
    ProtocolSocket.current = this;
    queueMicrotask(() => {
      this.dispatch('open', {});
    });
  }
  addEventListener(
    name: string,
    handler: ProtocolListener['handler'],
    options?: { once?: boolean },
  ): void {
    let listeners = this.listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(name, listeners);
    }
    listeners.add({ handler, once: options?.once === true });
  }
  dispatch(name: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(name) ?? []) {
      if (listener.once) this.listeners.get(name)?.delete(listener);
      listener.handler(event);
    }
  }
  frame(value: unknown): void {
    this.dispatch('message', { data: JSON.stringify(value) });
  }
  event(method: string, params: unknown): void {
    this.frame({ sessionId: 'session-owned', method, params });
  }
  send(data: string): void {
    const command = JSON.parse(data) as { id: number; method: string };
    this.frame({
      id: command.id,
      result:
        command.method === 'Target.createTarget'
          ? { targetId: 'target-owned' }
          : command.method === 'Target.attachToTarget'
            ? { sessionId: 'session-owned' }
            : {},
    });
  }
  close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }
}
afterEach(() => vi.unstubAllGlobals());

it('retains successful document and latest redirected script failure without stealing scenario events or secrets', async () => {
  vi.stubGlobal('WebSocket', ProtocolSocket);
  const page = await connectPage('ws://127.0.0.1:12345/devtools/browser/owned');
  const collector = collectRequestEvidence(page);
  const admissions: string[] = [];
  const stop = observeNetwork(page, {
    [loadingFailed]: (event: { requestId: string }) => {
      admissions.push(event.requestId);
    },
  });
  const emit = (event: string, params: unknown) => {
    ProtocolSocket.current.event(`Network.${event}`, params);
  };
  emit('requestWillBeSent', {
    requestId: 'document',
    type: 'Document',
    timestamp: 1,
    request: {
      url: 'http://user:password@owned.invalid/?token=poison',
      headers: { cookie: 'poison' },
    },
  });
  emit('responseReceived', {
    requestId: 'document',
    type: 'Document',
    timestamp: 2,
    response: { status: 200, headers: { 'set-cookie': 'poison' } },
  });
  emit('requestWillBeSent', {
    requestId: 'script',
    type: 'Script',
    timestamp: 3,
    request: { url: 'http://owned.invalid/private-poison?key=poison', postData: 'poison' },
  });
  emit('requestWillBeSent', {
    requestId: 'script',
    type: 'Script',
    timestamp: 4,
    redirectResponse: { status: 302, url: 'http://owned.invalid/private-poison' },
    request: { url: 'http://owned.invalid/assets/queued.js?secret=poison' },
  });
  emit('loadingFailed', {
    requestId: 'script',
    type: 'Script',
    timestamp: 5,
    errorText: 'net::ERR_NETWORK_CHANGED',
    canceled: false,
    poison: 'poison',
  });
  emit('loadingFailed', {
    requestId: 'unknown',
    timestamp: 6,
    errorText: 'private-poison',
    canceled: true,
  });
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-evidence-'));
  try {
    expect(await retainRequestFailure(collector, join(root, 'entry.png'))).toBe(true);
    const raw = await readFile(join(root, 'entry-network-failure.json'), 'utf8');
    const evidence = JSON.parse(raw) as RequestFailureEvidence;
    expect(raw).not.toMatch(/poison|password|cookie|headers|postData|owned\.invalid/);
    expect(evidence.rows[1]).toMatchObject({ path: '/', resourceType: 'Document', status: 200 });
    expect(evidence.rows[4]).toMatchObject({
      requestTag: 'request-2',
      hop: 1,
      path: '/assets/queued.js',
      error: 'net::ERR_NETWORK_CHANGED',
      canceled: false,
      relativeMs: 4000,
    });
    expect(evidence.rows[5]).toMatchObject({
      requestTag: null,
      hop: null,
      path: '[unknown-path]',
      error: '[unclassified-error]',
      canceled: true,
    });
    expect(admissions).toEqual(['script', 'unknown']);
    expect(await retainRequestFailure(collector, join(root, 'absent', 'entry.png'))).toBe(false);
    collector.dispose();
    const before = collector.snapshot();
    emit('loadingFinished', { requestId: 'script', timestamp: 7 });
    expect(collector.snapshot()).toEqual(before);
  } finally {
    stop();
    collector.dispose();
    page.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports bounded row and correlation loss rather than inventing an evicted request identity', async () => {
  vi.stubGlobal('WebSocket', ProtocolSocket);
  const page = await connectPage('ws://127.0.0.1:12345/devtools/browser/owned');
  const collector = collectRequestEvidence(page);
  try {
    for (let i = 0; i < 257; i++)
      ProtocolSocket.current.event('Network.requestWillBeSent', {
        requestId: String(i),
        type: 'Script',
        timestamp: i,
        request: { url: 'http://owned.invalid/assets/queued.js' },
      });
    ProtocolSocket.current.event('Network.loadingFailed', {
      requestId: '0',
      timestamp: 258,
      errorText: 'net::ERR_NETWORK_CHANGED',
      canceled: false,
    });
    for (let i = 257; i < 801; i++)
      ProtocolSocket.current.event('Network.requestWillBeSent', {
        requestId: String(i),
        type: 'Script',
        timestamp: i + 2,
        request: { url: 'http://owned.invalid/assets/queued.js' },
      });
    const snapshot = collector.snapshot();
    expect(snapshot.rows).toHaveLength(800);
    expect(snapshot.loss).toEqual({
      droppedRows: 2,
      correlationEvictions: 545,
      unmatchedEvents: 1,
      invalidEvents: 0,
      collectorFailures: 0,
    });
    expect(snapshot.rows[257]).toMatchObject({
      requestTag: null,
      hop: null,
      path: '[unknown-path]',
      error: 'net::ERR_NETWORK_CHANGED',
    });
    expect(snapshot.complete).toBe(false);
  } finally {
    collector.dispose();
    page.close();
  }
});

it('preserves the original navigation error when failure evidence cannot be written', async () => {
  class FailedNavigationSocket extends ProtocolSocket {
    override send(data: string): void {
      const command = JSON.parse(data) as { id: number; method: string };
      if (command.method !== 'Page.navigate') {
        super.send(data);
        return;
      }
      this.event('Network.requestWillBeSent', {
        requestId: 'document',
        type: 'Document',
        timestamp: 1,
        request: { url: 'http://owned.invalid/' },
      });
      this.event('Network.responseReceived', {
        requestId: 'document',
        type: 'Document',
        timestamp: 2,
        response: { status: 200 },
      });
      this.event('Network.requestWillBeSent', {
        requestId: 'script',
        type: 'Script',
        timestamp: 3,
        request: { url: 'http://owned.invalid/assets/queued.js' },
      });
      this.event('Network.loadingFailed', {
        requestId: 'script',
        timestamp: 4,
        errorText: 'net::ERR_NETWORK_CHANGED',
        canceled: false,
      });
      this.frame({ id: command.id, error: { message: 'primary-navigation-failure' } });
    }
  }
  vi.stubGlobal('WebSocket', FailedNavigationSocket);
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-primary-error-'));
  const bin = join(root, 'chrome');
  const receiptFile = join(root, 'chrome.receipt.json');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const http=require('node:http');
const port=Number(process.argv.find(x=>x.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((req,res)=>res.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/browser/owned'}))).listen(port,'127.0.0.1');
`,
    { mode: 0o755 },
  );
  try {
    await expect(
      acceptObservation({
        origin: 'http://owned.invalid',
        cookie: 'owned=private',
        runtime: { kind: 'native', bin },
        extraFlags: [],
        profile: join(root, 'profile'),
        receiptFile,
        composition: true,
        expectedRoster: ['fixture-roster'],
        browserMs: 1000,
        screenshot: join(root, 'absent', 'entry.png'),
      }),
    ).rejects.toThrow('primary-navigation-failure');
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as {
      native: { pid: number };
      state: string;
    };
    expect(receipt.state).toBe('stopped');
    expect(() => process.kill(receipt.native.pid, 0)).toThrow();
  } finally {
    await rescueChrome(receiptFile);
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps failed-exchange metadata and the original exception when a scenario subscriber throws', async () => {
  vi.stubGlobal('WebSocket', ProtocolSocket);
  const page = await connectPage('ws://127.0.0.1:12345/devtools/browser/owned');
  const primary = new Error('scenario-observer-failure');
  const stop = observeNetwork(page, {
    [loadingFailed]: () => {
      throw primary;
    },
  });
  const collector = collectRequestEvidence(page);
  try {
    ProtocolSocket.current.event('Network.requestWillBeSent', {
      requestId: 'script',
      type: 'Script',
      request: { url: 'http://owned.invalid/assets/queued.js' },
    });
    let failure: unknown;
    try {
      ProtocolSocket.current.event('Network.loadingFailed', {
        requestId: 'script',
        errorText: 'net::ERR_NETWORK_CHANGED',
        canceled: false,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(primary);
    expect(collector.snapshot().rows[1]).toMatchObject({
      path: '/assets/queued.js',
      error: 'net::ERR_NETWORK_CHANGED',
      canceled: false,
    });
  } finally {
    stop();
    collector.dispose();
    page.close();
  }
});

it('keeps an evicted redirect hop unknown and does not reuse the identity of a completed exchange', async () => {
  vi.stubGlobal('WebSocket', ProtocolSocket);
  const page = await connectPage('ws://127.0.0.1:12345/devtools/browser/owned');
  const collector = collectRequestEvidence(page);
  try {
    for (let i = 0; i < 257; i++)
      ProtocolSocket.current.event('Network.requestWillBeSent', {
        requestId: String(i),
        type: 'Script',
        request: { url: 'http://owned.invalid/assets/queued.js' },
      });
    ProtocolSocket.current.event('Network.requestWillBeSent', {
      requestId: '0',
      type: 'Script',
      redirectResponse: { status: 302, url: 'http://owned.invalid/?token=poison' },
      request: { url: 'http://owned.invalid/assets/queued.js' },
    });
    const redirect = collector.snapshot().rows[257];
    expect(redirect).toMatchObject({
      requestTag: 'request-258',
      hop: null,
      redirectFrom: { hop: null, path: '/', status: 302 },
    });
    ProtocolSocket.current.event('Network.loadingFinished', { requestId: '0' });
    ProtocolSocket.current.event('Network.requestWillBeSent', {
      requestId: '0',
      type: 'Document',
      request: { url: 'http://owned.invalid/' },
    });
    expect(collector.snapshot().rows[259]).toMatchObject({
      requestTag: 'request-259',
      hop: 0,
      path: '/',
    });
    expect(JSON.stringify(collector.snapshot())).not.toContain('poison');
  } finally {
    collector.dispose();
    page.close();
  }
});

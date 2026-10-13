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
import {
  qualificationDiagnostic,
  qualificationError,
} from '../../scripts/probe-browser-qualification.mjs';

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

it('excludes private ordinary and aggregate error data while retaining classified qualification facts', () => {
  const poison = 'private-custody-poison';
  const ordinary = Object.assign(new Error(`cookie=${poison}`), {
    stack: `request-body=${poison}`,
    code: `E_${poison}`,
    qualificationPhase: `phase-${poison}`,
    qualificationInvariants: ['eth0IPv6Disabled', poison],
    qualificationOutcome: `outcome-${poison}`,
    response: { headers: { cookie: poison }, body: poison },
  });
  const unsupported = qualificationError(poison, poison, ['noIPv4DefaultRoute', poison]);
  unsupported.message = poison;
  unsupported.stack = poison;
  unsupported.qualificationOutcome = poison;
  const classified = qualificationError('EADDRNOTAVAIL', 'host-ipv6-control', [
    'onlyLoopbackIPv6',
    poison,
    'eth0IPv6Disabled',
  ]);
  classified.message = poison;
  classified.qualificationOutcome = 'nonzero-exit';
  const aggregate = Object.assign(
    new AggregateError([ordinary, unsupported, classified], poison, { cause: ordinary }),
    { code: poison, stack: poison, qualificationPhase: poison },
  );
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('page-attach');
  diagnostic.fail(ordinary);

  expect(() => {
    diagnostic.enter(poison);
  }).toThrow();
  expect(() => {
    diagnostic.cleanup(ordinary, poison);
  }).toThrow();
  const report = diagnostic.snapshot(aggregate);

  expect(JSON.stringify(report)).not.toContain(poison);
  expect(report.phases).toEqual(['page-attach']);
  expect(report.cleanup).toEqual([]);
  expect(report.primary?.root).toMatchObject({
    kind: 'Error',
    code: 'UNKNOWN',
    phase: 'page-attach',
    invariants: ['eth0IPv6Disabled'],
  });
  expect(
    report.error.root.children?.map((node) => ({
      code: node.code,
      phase: node.phase,
      invariants: node.invariants,
      outcome: node.processOutcome,
    })),
  ).toEqual([
    { code: 'UNKNOWN', phase: 'page-attach', invariants: ['eth0IPv6Disabled'], outcome: undefined },
    {
      code: 'UNKNOWN',
      phase: 'page-attach',
      invariants: ['noIPv4DefaultRoute'],
      outcome: undefined,
    },
    {
      code: 'EADDRNOTAVAIL',
      phase: 'host-ipv6-control',
      invariants: ['onlyLoopbackIPv6', 'eth0IPv6Disabled'],
      outcome: 'nonzero-exit',
    },
  ]);
});

it('keeps the first qualification phase and ordered cleanup causes with cyclic error identity references', () => {
  const primary = Object.assign(new Error('private primary detail'), { code: 'EADDRNOTAVAIL' });
  primary.cause = primary;
  const cleanup = Object.assign(new Error('private cleanup detail', { cause: primary }), {
    code: 'EPIPE',
  });
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('host-ipv6-control');
  diagnostic.fail(primary);
  diagnostic.enter('control-cleanup');
  diagnostic.cleanup(cleanup, 'control-cleanup');
  diagnostic.enter('chrome-cleanup');
  const aggregate = new AggregateError([primary, cleanup], 'private wrapper detail', {
    cause: primary,
  });

  diagnostic.fail(aggregate);
  const report = diagnostic.snapshot(aggregate);

  const projectedPrimary = report.primary;
  const children = report.error.root.children;
  const first = children?.[0];
  const second = children?.[1];
  if (!projectedPrimary || !children || !first || !second)
    throw new Error('Qualification cause relationships missing');
  expect(report.failureDomain).toBe('qualification');
  expect(projectedPrimary.root).toMatchObject({
    code: 'EADDRNOTAVAIL',
    phase: 'host-ipv6-control',
  });
  expect(projectedPrimary.root.id).toEqual(expect.any(Number));
  expect(projectedPrimary.root.cause).toEqual({ reference: projectedPrimary.root.id });
  expect(report.cleanup[0]?.root).toMatchObject({ code: 'EPIPE', phase: 'control-cleanup' });
  expect(children.map((node) => ({ code: node.code, phase: node.phase }))).toEqual([
    { code: 'EADDRNOTAVAIL', phase: 'host-ipv6-control' },
    { code: 'EPIPE', phase: 'control-cleanup' },
  ]);
  expect(first.id).toEqual(expect.any(Number));
  expect(first.cause).toEqual({ reference: first.id });
  expect(second.cause).toEqual({ reference: first.id });
  expect(report.error.root.cause).toEqual({ reference: first.id });
  expect(report.error.nodes).toBe(3);
  expect(report.error.dropped).toBe(0);
});

it('retains the first eight aggregate failures in order and reports the two discarded children', () => {
  const errors = [
    'EACCES',
    'ENOENT',
    'EINVAL',
    'ENETUNREACH',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EADDRNOTAVAIL',
    'IPV6_DAD_FAILED',
    'BRIDGE_IDENTITY_CHANGED',
  ].map((code) => Object.assign(new Error('private aggregate detail'), { code }));
  const failure = new AggregateError(errors, 'private aggregate wrapper');
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('private-probe-execution');

  diagnostic.fail(failure);
  const report = diagnostic.snapshot(failure);

  expect(report.error.root.children?.map((node) => node.code)).toEqual([
    'EACCES',
    'ENOENT',
    'EINVAL',
    'ENETUNREACH',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EADDRNOTAVAIL',
  ]);
  expect(report.error.nodes).toBe(9);
  expect(report.error.dropped).toBe(2);
});

it('bounds a five-error cause chain and marks its omitted terminal cause', () => {
  let cause = Object.assign(new Error('private cause detail'), { code: 'EPIPE' });
  for (const code of ['EINVAL', 'ENOENT', 'EPERM', 'EACCES'])
    cause = Object.assign(new Error('private cause detail', { cause }), { code });
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('private-probe-execution');

  const projection = diagnostic.snapshot(cause).error;

  expect([
    projection.root.code,
    projection.root.cause?.code,
    projection.root.cause?.cause?.code,
    projection.root.cause?.cause?.cause?.code,
  ]).toEqual(['EACCES', 'EPERM', 'ENOENT', 'EINVAL']);
  expect(projection.root.cause?.cause?.cause?.cause).toEqual({ truncated: true });
  expect(projection.nodes).toBe(4);
  expect(projection.dropped).toBe(1);
});

it('stops a branching aggregate at the node budget without inventing omitted nodes', () => {
  const branches = [
    'EACCES',
    'EPERM',
    'EINVAL',
    'ENOENT',
    'ENODEV',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNRESET',
  ].map((code) =>
    Object.assign(
      new AggregateError(
        Array.from({ length: 8 }, () =>
          Object.assign(new Error('private leaf'), { code: 'EPIPE' }),
        ),
        'private branch',
      ),
      { code },
    ),
  );
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('private-probe-execution');

  const projection = diagnostic.snapshot(new AggregateError(branches, 'private graph')).error;

  expect(projection.nodes).toBe(32);
  // Three complete branches, then three leaves of branch four exhaust the node budget.
  expect(projection.root.children?.slice(0, 4).map((node) => node.code)).toEqual([
    'EACCES',
    'EPERM',
    'EINVAL',
    'ENOENT',
  ]);
  expect(
    projection.root.children?.[3]?.children?.map((node) => node.code ?? node.truncated),
  ).toEqual(['EPIPE', 'EPIPE', 'EPIPE', true, true, true, true, true]);
  expect(projection.root.children?.slice(4)).toEqual([
    { truncated: true },
    { truncated: true },
    { truncated: true },
    { truncated: true },
  ]);
  expect(projection.dropped).toBe(9);
});

it('reports bounded phase and cleanup loss while still attributing a failure after the trace fills', () => {
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  for (let index = 0; index < 35; index++)
    diagnostic.enter(index % 2 === 0 ? 'page-attach' : 'online-evaluate');
  const primary = Object.assign(new Error('private primary'), { code: 'EADDRNOTAVAIL' });
  diagnostic.fail(primary);

  for (let index = 0; index < 10; index++)
    diagnostic.cleanup(
      Object.assign(new Error('private cleanup'), { code: 'EPIPE' }),
      'control-cleanup',
    );
  const report = diagnostic.snapshot(primary);

  expect(report.phases).toHaveLength(32);
  expect(report.phases.at(-1)).toBe('online-evaluate');
  expect(report.droppedPhases).toBe(3);
  expect(report.primary?.root.phase).toBe('page-attach');
  expect(report.cleanup).toHaveLength(8);
  expect(report.cleanup.every((projection) => projection.root.phase === 'control-cleanup')).toBe(
    true,
  );
  expect(report.droppedCleanup).toBe(2);
});

it('classifies cleanup-only failure separately and preserves its first phase through wrapper cleanup', () => {
  const cleanup = Object.assign(new Error('private close detail'), { code: 'EPIPE' });
  const failure = new AggregateError([cleanup], 'private cleanup wrapper');
  const diagnostic = qualificationDiagnostic('00000000-0000-0000-0000-000000000179');
  diagnostic.enter('control-cleanup');
  diagnostic.cleanup(cleanup, 'control-cleanup');
  diagnostic.fail(failure);

  diagnostic.enter('page-cleanup');
  diagnostic.enter('chrome-cleanup');
  diagnostic.fail(failure);
  const report = diagnostic.snapshot(failure);

  expect(report.failureDomain).toBe('cleanup');
  expect(report.primary?.root.phase).toBe('control-cleanup');
  expect(report.error.root.phase).toBe('control-cleanup');
  expect(
    report.error.root.children?.map((node) => ({
      code: node.code,
      phase: node.phase,
    })),
  ).toEqual([{ code: 'EPIPE', phase: 'control-cleanup' }]);
});

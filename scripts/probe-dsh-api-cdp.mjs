/** CDP session, chrome launch, mux $events listener. */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { registerNativeChild, stopChild } from './probe-browser-native.mjs';
import {
  chromeFlags,
  processBirth,
  rescueChrome,
  registerChrome,
  startIsolated,
  writeReceipt,
} from './probe-browser-runtime.mjs';

const HTTP_MS = 15_000;
const WS_MS = 15_000;
const CDP_MS = 15_000;
const PORT_MS = 15_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitPort = async (host, port, ms, died) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (died?.()) throw new Error('chrome-exited');
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`wait ${host}:${port}`);
};

export const httpRequest = (options, body, ms = HTTP_MS) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      req?.destroy();
      finish(reject, new Error('http-timeout'));
    }, ms);
    try {
      req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('aborted', () => finish(reject, new Error('http-timeout')));
        res.on('error', (error) => finish(reject, error));
        res.on('close', () => {
          if (!settled) finish(reject, new Error('http-timeout'));
        });
      });
      req.on('error', (error) => finish(reject, error));
      req.on('close', () => {
        if (!settled) finish(reject, new Error('http-timeout'));
      });
      if (body) req.write(body);
      req.end();
    } catch (error) {
      finish(reject, error);
    }
  });

const drain = (pending, reason) => {
  for (const [, waiter] of pending) waiter.reject(new Error(reason));
  pending.clear();
};

class Cdp {
  constructor(ws, timeoutMs = CDP_MS) {
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.timeoutMs = timeoutMs;
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? 'cdp'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const sessionKey = msg.sessionId ?? '';
        this.handlers.get(`${sessionKey}\0${msg.method}`)?.(msg.params ?? {});
      }
    });
    ws.addEventListener('close', () => drain(this.pending, 'cdp-closed'), { once: true });
    ws.addEventListener('error', () => drain(this.pending, 'cdp-error'), { once: true });
  }
  on(method, handler, sessionId = '') {
    this.handlers.set(`${sessionId}\0${method}`, handler);
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 1) {
        reject(new Error('cdp-closed'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('cdp-timeout'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify(envelope));
    });
  }
}

const openWs = (url, extra, ms = WS_MS) =>
  new Promise((resolve, reject) => {
    const ws = extra ? new WebSocket(url, extra) : new WebSocket(url);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      ws.close();
      finish(reject, new Error('ws-timeout'));
    }, ms);
    ws.addEventListener('open', () => finish(resolve, ws), { once: true });
    ws.addEventListener('error', () => finish(reject, new Error('ws-error')), { once: true });
    ws.addEventListener('close', () => finish(reject, new Error('ws-closed')), { once: true });
  });

export const connectPage = async (browserWs) => {
  const browser = await openWs(browserWs);
  const root = new Cdp(browser);
  const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    send: (method, params = {}) => root.send(method, params, sessionId),
    on: (method, handler) => root.on(method, handler, sessionId),
    close: () => browser.close(),
  };
};

const networkOwners = new WeakMap();
const networkEvents = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.resourceChangedPriority',
];

/** One Network owner per page; global Cdp.on still replaces its single handler. */
export const observeNetwork = (page, handlers) => {
  if (Object.keys(handlers).some((method) => !networkEvents.includes(method))) {
    throw new Error('unsupported browser Network observer');
  }
  let observers = networkOwners.get(page);
  if (!observers) {
    observers = new Set();
    networkOwners.set(page, observers);
    for (const method of networkEvents) {
      page.on(method, (params) => {
        let failed = false,
          firstError;
        for (const observer of observers) {
          try {
            observer[method]?.(params);
          } catch (error) {
            if (!failed) {
              failed = true;
              firstError = error;
            }
          }
        }
        if (failed) throw firstError;
      });
    }
  }
  observers.add(handlers);
  return () => observers.delete(handlers);
};

const redactChrome = (text) =>
  String(text ?? '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\/[^\s:]+\//g, '[path]/')
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, '[id]')
    .slice(0, 240);

// This boundary intentionally returns no raw cause: stderr/CDP data may contain credentials.
const launchFailure = (error, hint = '', cleanupFailed = false) =>
  new Error(
    `chrome-start ${hint || redactChrome(error?.message ?? error)}${cleanupFailed ? ' cleanup-incomplete' : ''}`,
  );

export const exchangeLaunchToken = async ({ host, port, token, cookieHost }) => {
  const authority = `${cookieHost ?? host}:${port}`;
  const res = await httpRequest({
    host,
    port,
    path: `/?token=${encodeURIComponent(token)}`,
    method: 'GET',
    headers: { host: authority },
  });
  const set = res.headers['set-cookie']?.[0];
  if (res.status !== 303 || !set) throw new Error(`token exchange status=${res.status}`);
  return set.split(';', 1)[0] ?? '';
};

export const rpcCall = async (origin, cookie, method, payload, connectHost) => {
  const url = new URL(origin);
  const res = await httpRequest(
    {
      host: connectHost ?? url.hostname,
      port: Number(url.port || 80),
      path: `/api/${method}`,
      method: 'POST',
      headers: { cookie, host: url.host, origin, 'content-type': 'application/json' },
    },
    JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args: payload },
    }),
  );
  if (res.status !== 200) {
    return { ok: false, error: `http-${res.status}`, status: res.status };
  }
  try {
    const parsed = JSON.parse(res.body);
    return parsed?.type === 'server-response'
      ? { ...parsed.result, status: res.status }
      : { ok: false, error: 'envelope', status: res.status };
  } catch {
    return { ok: false, error: 'json', status: res.status };
  }
};

const validateLaunch = (input) => {
  const url = new URL(input.origin);
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password) {
    throw new Error('chrome-start requires original HTTP origin');
  }
  if (!['native', 'docker-isolated-network'].includes(input.runtime?.kind)) {
    throw new Error('chrome-start requires explicit runtime');
  }
};

const nativeDebugPort = async () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
  return await promise;
};

const startNative = async (input, receipt) => {
  const debugPort = await nativeDebugPort();
  let child,
    stderr = '',
    exitHint = '';
  try {
    child = spawn(input.runtime.bin, chromeFlags(input.profile, debugPort, input.extraFlags), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += String(chunk).slice(0, 4_000 - stderr.length);
    });
    child.once('exit', (code, signal) => {
      exitHint = signal ? `signal-${signal}` : `exit-${code ?? 'none'}`;
    });
    const { promise, resolve, reject } = Promise.withResolvers();
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('spawn-failed')));
    await promise;
    const birth =
      platform() === 'linux' ? await processBirth(child.pid) : `creator:${randomUUID()}`;
    registerNativeChild(receipt, child, birth);
    receipt.state = 'running';
    await writeReceipt(input.receiptFile, receipt);
    return {
      debugPort,
      died: () => Boolean(exitHint),
      hint: () => redactChrome(stderr).trim() || exitHint,
      stop: () => rescueChrome(input.receiptFile, receipt.nonce),
    };
  } catch (error) {
    let cleanupFailed = false;
    try {
      await stopChild(child);
    } catch {
      cleanupFailed = true;
    }
    throw launchFailure(error, redactChrome(stderr).trim() || exitHint, cleanupFailed);
  }
};

const parseDebugger = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('debugger-json-invalid');
  }
};

const requireDebugger = (info, runtime) => {
  if (
    runtime.kind === 'docker-isolated-network' &&
    !/^(?:HeadlessChrome|Chrome)\/140\.0\.7339\.82$/.test(info.Browser ?? '')
  ) {
    throw new Error('isolated browser version differs from pinned CfT');
  }
  if (typeof info?.webSocketDebuggerUrl !== 'string' || info.webSocketDebuggerUrl === '') {
    throw new Error('no debugger websocket');
  }
};

export const startChrome = async (input) => {
  validateLaunch(input);
  await mkdir(input.profile, { recursive: true, mode: 0o700 });
  let owner;
  try {
    const receipt = await registerChrome(input);
    owner =
      input.runtime.kind === 'docker-isolated-network'
        ? await startIsolated(input, receipt)
        : await startNative(input, receipt);
    const debugPort = owner.debugPort;
    await waitPort('127.0.0.1', debugPort, PORT_MS, owner.died);
    const info = parseDebugger(
      (await httpRequest({ host: '127.0.0.1', port: debugPort, path: '/json/version' })).body,
    );
    requireDebugger(info, input.runtime);
    let stopped;
    return { browserWs: info.webSocketDebuggerUrl, stop: () => (stopped ??= owner.stop()) };
  } catch (error) {
    let cleanupFailed = false;
    try {
      await owner?.stop();
    } catch {
      cleanupFailed = true;
    }
    const reason = owner?.hint?.() || redactChrome(error?.message ?? error);
    throw launchFailure(error, reason, cleanupFailed);
  }
};

export const muxListen = async (origin, cookie, store) => {
  store.ready = false;
  store.closed = false;
  store.reason = null;
  store.events = [];
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('mux requires a loopback HTTP origin');
  }
  const ws = await openWs(`ws://127.0.0.1:${url.port || '80'}/api/remote.mux`, {
    headers: { cookie, host: url.host, origin },
  });
  const streamId = randomUUID();
  const fail = (reason) => {
    store.ready = false;
    store.closed = true;
    store.reason = reason;
    store.events = [];
  };
  ws.addEventListener('close', () => fail('disconnected'), { once: true });
  ws.addEventListener('error', () => fail('disconnected'), { once: true });
  ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
  ws.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const value = frame?.type === 'item' && frame.streamId === streamId ? frame.value : null;
    if (!value) return;
    if (value.type === 'ready') store.ready = true;
    if (
      value.type === 'emit' &&
      value.event === 'api-session/status' &&
      typeof value.args?.[0] === 'string' &&
      typeof value.args?.[1] === 'boolean'
    ) {
      store.events.push({ sessionId: value.args[0], running: value.args[1], t: Date.now() });
    }
  });
  return {
    store,
    close: () => {
      try {
        ws.send(JSON.stringify({ type: 'cancel', streamId }));
      } catch {
        /* closed */
      }
      ws.close();
    },
  };
};

const WELCOME_CONTROLLER_DECL = 'const welcomeController = new WelcomeNoticeStore';
const READ_WELCOME_SNAPSHOT =
  'function(){const s=this.store.getSnapshot();return {status:s.status,acknowledged:s.acknowledged};}';

const ignoreCdp = async (promise) => {
  try {
    await promise;
  } catch {
    /* closed */
  }
};

const lineAfterNeedle = (source, needle) => {
  const pos = source.indexOf(needle);
  if (pos === -1) return -1;
  return source.slice(0, pos).split('\n').length;
};

const createWelcomeObserver = (page) => {
  const state = {
    controllerId: undefined,
    instrumentation: undefined,
    targetBreakpoint: undefined,
    failure: undefined,
    paused: false,
  };
  const removeBreakpoints = async () => {
    const target = state.targetBreakpoint;
    const instrumentation = state.instrumentation;
    state.targetBreakpoint = undefined;
    state.instrumentation = undefined;
    if (target) await ignoreCdp(page.send('Debugger.removeBreakpoint', { breakpointId: target }));
    if (instrumentation) {
      await ignoreCdp(page.send('Debugger.removeBreakpoint', { breakpointId: instrumentation }));
    }
  };
  const resumeIfPaused = async () => {
    if (!state.paused) return;
    state.paused = false;
    await ignoreCdp(page.send('Debugger.resume'));
  };
  const captureController = async (event) => {
    const frameId = event.callFrames?.[0]?.callFrameId;
    if (!frameId) {
      state.failure = 'controller-unavailable';
      return;
    }
    const found = await page.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frameId,
      expression: 'welcomeController',
      returnByValue: false,
    });
    if (found.exceptionDetails || !found.result?.objectId) {
      state.failure = 'controller-unavailable';
      return;
    }
    state.controllerId = found.result.objectId;
    await removeBreakpoints();
  };
  const armScriptBreakpoint = async (event) => {
    if (state.targetBreakpoint || state.controllerId) return;
    const scriptId = event.callFrames?.[0]?.location?.scriptId;
    if (!scriptId) return;
    const { scriptSource } = await page.send('Debugger.getScriptSource', { scriptId });
    const lineNumber = lineAfterNeedle(scriptSource, WELCOME_CONTROLLER_DECL);
    if (lineNumber < 0) return;
    const set = await page.send('Debugger.setBreakpoint', {
      location: { scriptId, lineNumber },
    });
    state.targetBreakpoint = set.breakpointId;
  };
  const onPaused = async (event) => {
    state.paused = true;
    try {
      if (state.failure) return;
      if (state.targetBreakpoint && event.hitBreakpoints?.includes(state.targetBreakpoint)) {
        await captureController(event);
        return;
      }
      await armScriptBreakpoint(event);
    } catch {
      state.failure = 'debugger-observation-failed';
    } finally {
      await resumeIfPaused();
    }
  };
  return {
    state,
    onPaused,
    removeBreakpoints,
    resumeIfPaused,
    cleanup: async () => {
      await removeBreakpoints();
      await resumeIfPaused();
      await ignoreCdp(page.send('Debugger.disable'));
    },
  };
};

export const armWelcomeStoreObserver = async (page) => {
  const observer = createWelcomeObserver(page);
  page.on('Debugger.paused', observer.onPaused);
  await page.send('Debugger.enable');
  const set = await page.send('Debugger.setInstrumentationBreakpoint', {
    instrumentation: 'beforeScriptExecution',
  });
  observer.state.instrumentation = set.breakpointId;
  return observer;
};

const readWelcomeSnapshot = async (page, objectId) => {
  const result = await page.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: READ_WELCOME_SNAPSHOT,
    returnByValue: true,
    throwOnSideEffect: true,
  });
  if (result.exceptionDetails) throw new Error('readonly-store-observation-failed');
  return result.result?.value;
};

export const waitWelcomeStoreReady = async (page, observer, ms) => {
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      if (observer.state.failure) throw new Error(observer.state.failure);
      if (observer.state.controllerId) {
        const snapshot = await readWelcomeSnapshot(page, observer.state.controllerId);
        if (snapshot?.status === 'ready') return snapshot;
      }
      await sleep(100);
    }
    throw new Error('initialization-unobserved');
  } finally {
    await observer.cleanup();
  }
};

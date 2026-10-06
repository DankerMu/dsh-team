/** CDP session, chrome launch, mux $events listener. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const HTTP_MS = 15_000;
const WS_MS = 15_000;
const CDP_MS = 15_000;
const PORT_MS = 15_000;
const CHILD_MS = 8_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withDeadline = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

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

const redactChrome = (text) =>
  String(text ?? '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\/[^\s:]+\//g, '[path]/')
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, '[id]')
    .slice(0, 240);

const stopChild = async (child) => {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  const ended = new Promise((resolve) => child.once('exit', resolve));
  try {
    await withDeadline(ended, CHILD_MS, 'chrome-stop');
  } catch {
    child.kill('SIGKILL');
    try {
      await withDeadline(
        new Promise((resolve) => child.once('exit', resolve)),
        3_000,
        'chrome-kill',
      );
    } catch {
      /* already gone */
    }
  }
};

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
  if (res.status !== 200) return { ok: false, error: `http-${res.status}` };
  try {
    const parsed = JSON.parse(res.body);
    return parsed?.type === 'server-response' ? parsed.result : { ok: false, error: 'envelope' };
  } catch {
    return { ok: false, error: 'json' };
  }
};

export const startChrome = async (bin, profile, pidFile, extraFlags = []) => {
  await mkdir(profile, { recursive: true });
  const debugPort = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  // --no-sandbox: Ubuntu AppArmor can reject Chrome userns ("No usable sandbox").
  // Verification-only ephemeral profile, loopback DSH origin. Does not change
  // host sysctl/AppArmor or the DSH container seccomp/privilege boundary.
  const flags = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    ...extraFlags,
    'about:blank',
  ];
  let child;
  try {
    child = spawn(bin, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    throw new Error('chrome-start spawn-failed');
  }
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 4_000) stderr += String(chunk);
  });
  let exitHint = '';
  child.once('exit', (code, signal) => {
    exitHint = signal ? `signal-${signal}` : `exit-${code ?? 'none'}`;
  });
  const failStart = async (error) => {
    const reason = redactChrome(stderr).trim() || exitHint || redactChrome(error?.message ?? error);
    await stopChild(child);
    throw new Error(`chrome-start ${reason}`);
  };
  try {
    await writeFile(pidFile, String(child.pid ?? ''));
    await waitPort('127.0.0.1', debugPort, PORT_MS, () => Boolean(exitHint));
    const info = JSON.parse(
      (await httpRequest({ host: '127.0.0.1', port: debugPort, path: '/json/version' })).body,
    );
    if (typeof info?.webSocketDebuggerUrl !== 'string' || info.webSocketDebuggerUrl === '') {
      throw new Error('no debugger websocket');
    }
    return { child, browserWs: info.webSocketDebuggerUrl, stop: () => stopChild(child) };
  } catch (error) {
    return await failStart(error);
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

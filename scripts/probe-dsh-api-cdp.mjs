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

export const startChrome = async (bin, profile, pidFile) => {
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
    'about:blank',
  ];
  const child = spawn(bin, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  await writeFile(pidFile, String(child.pid ?? ''));
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 4_000) stderr += String(chunk);
  });
  let exitHint = '';
  child.once('exit', (code, signal) => {
    exitHint = signal ? `signal-${signal}` : `exit-${code ?? 'none'}`;
  });
  try {
    await waitPort('127.0.0.1', debugPort, PORT_MS, () => Boolean(exitHint));
  } catch (error) {
    const reason = redactChrome(stderr).trim() || exitHint || String(error?.message ?? error);
    await stopChild(child);
    throw new Error(`chrome-start ${reason}`, { cause: error });
  }
  const info = JSON.parse(
    (await httpRequest({ host: '127.0.0.1', port: debugPort, path: '/json/version' })).body,
  );
  if (!info.webSocketDebuggerUrl) throw new Error('no debugger websocket');
  return { child, browserWs: info.webSocketDebuggerUrl, stop: () => stopChild(child) };
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

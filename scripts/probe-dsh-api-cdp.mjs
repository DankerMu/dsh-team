/** CDP session, chrome launch, mux $events listener. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const waitPort = async (host, port, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`wait ${host}:${port}`);
};
export const httpRequest = (options, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
class Cdp {
  constructor(ws) {
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? 'cdp'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.handlers.get(msg.method)?.(msg.params ?? {});
    });
    this.ws = ws;
  }
  on(method, handler) {
    this.handlers.set(method, handler);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const openWs = (url, extra) =>
  new Promise((resolve, reject) => {
    const ws = extra ? new WebSocket(url, extra) : new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`ws ${url}`)), { once: true });
  });
export const connectPage = async (browserWs) => {
  const browser = await openWs(browserWs);
  const root = new Cdp(browser);
  const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    send: (method, params = {}) => root.send(method, { ...params, sessionId }),
    on: (method, handler) => root.on(method, handler),
    close: () => browser.close(),
  };
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
  const flags = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    'about:blank',
  ];
  const child = spawn(bin, flags, { stdio: 'ignore' });
  await writeFile(pidFile, String(child.pid ?? ''));
  await waitPort('127.0.0.1', debugPort, 15_000);
  const info = JSON.parse(
    (await httpRequest({ host: '127.0.0.1', port: debugPort, path: '/json/version' })).body,
  );
  if (!info.webSocketDebuggerUrl) throw new Error('no debugger websocket');
  return { child, browserWs: info.webSocketDebuggerUrl };
};
export const muxListen = async (origin, cookie, store) => {
  const url = new URL(origin);
  const ws = await openWs(`ws://${url.host}/api/remote.mux`, {
    headers: { cookie, host: url.host, origin },
  });
  const streamId = randomUUID();
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
      typeof value.args?.[1] === 'boolean'
    ) {
      store.last = value.args[1];
      store.history.push(value.args[1]);
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

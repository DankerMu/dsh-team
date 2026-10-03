#!/usr/bin/env node
/** Host token exchange, CDP UI drive, path inventory, idle samples. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connectPage, httpRequest, muxListen, sleep, startChrome } from './probe-dsh-api-cdp.mjs';

const PHASES = ['homepage', 'new-session', 'message', 'running', 'complete'];
const SECRET = /^(token|access_token|api[_-]?key|authorization|cookie)$/i;
const MSG = /^(text|content|message|prompt|body)$/i;
const PROMPT =
  'Reply with exactly OK then run bash: sleep 8; echo dsh-team-probe-ok. Do not skip the sleep.';
const NEW_BTN = 'button[aria-label="New session"],button[aria-label="新建会话"]';
const SEND_BTN = 'button[aria-label="Send message"],button[aria-label="发送消息"]';
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`probe-dsh-api: ${message}\n`);
  process.exit(code);
};
const env = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is missing`, 2);
  return value;
};
const readSecret = async (name) => {
  const path = env(name);
  return (await readFile(path, 'utf8')).trim();
};
const redactUrl = (raw) => {
  try {
    const url = new URL(raw, 'http://127.0.0.1');
    for (const key of [...url.searchParams.keys()])
      if (SECRET.test(key)) url.searchParams.delete(key);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '[unparseable-url]';
  }
};
const redact = (value, key = '') => {
  if (typeof value === 'string') {
    if (SECRET.test(key) || MSG.test(key)) return '[redacted]';
    return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
};
const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const exchange = async () => {
  const host = env('PROBE_HOST');
  const port = Number(env('PROBE_PORT'));
  const token = await readSecret('PROBE_TOKEN_FILE');
  const res = await httpRequest({
    host,
    port,
    path: `/?token=${encodeURIComponent(token)}`,
    method: 'GET',
    headers: { host: `${host}:${port}` },
  });
  const set = res.headers['set-cookie']?.[0];
  if (res.status !== 303 || !set) fail(`token exchange status=${res.status}`);
  process.stdout.write(set.split(';', 1)[0] ?? '');
};
const rpcCall = async (origin, cookie, method, payload) => {
  const url = new URL(origin);
  const res = await httpRequest(
    {
      host: url.hostname,
      port: Number(url.port || 80),
      path: `/api/${method}`,
      method: 'POST',
      headers: { cookie, host: url.host, origin, 'content-type': 'application/json' },
    },
    JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  );
  if (res.status !== 200) return { ok: false, error: `http-${res.status}` };
  try {
    const parsed = JSON.parse(res.body);
    return parsed?.type === 'server-response' ? parsed.result : { ok: false, error: 'envelope' };
  } catch {
    return { ok: false, error: 'json' };
  }
};
const listRunning = (result) => {
  if (!result?.ok || !Array.isArray(result.value?.items)) return { ok: false, error: 'list' };
  const items = result.value.items.map((item) => ({
    running: item?.running === true,
    agentAvailable: item?.agentAvailable === true,
  }));
  return { ok: true, anyRunning: items.some((item) => item.running), items };
};
const evalJson = async (page, expression) => {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate');
  return result.result?.value;
};
const clickSelector = async (page, selector) => {
  const ok = await evalJson(
    page,
    `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`,
  );
  if (!ok) throw new Error(`missing ${selector}`);
};
const scanState = async (home) => {
  const names = [];
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      names.push(`${dir}/${entry.name}`.slice(home.length + 1));
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, depth + 1);
    }
  };
  await walk(home, 0);
  return {
    available: true,
    entryCount: names.length,
    digest: createHash('sha256').update(names.sort().join('\n')).digest('hex').slice(0, 16),
  };
};
const snapshot = (bucket, phase) => {
  const httpPaths = [...bucket.http].sort();
  const wsUrls = [...bucket.ws].sort();
  out(`phase ${phase} http=${httpPaths.join(',') || '(none)'} ws=${wsUrls.join(',') || '(none)'}`);
  return { phase, http: httpPaths, ws: wsUrls };
};
const sample = async (origin, cookie, home, mux, label) => {
  const httpSample = listRunning(await rpcCall(origin, cookie, 'session/list', {}));
  const wsSample = mux.store.ready
    ? { available: true, last: mux.store.last, observed: mux.store.history.slice(-3) }
    : { available: false, reason: 'mux-not-ready' };
  let files;
  try {
    files = await scanState(home);
  } catch (error) {
    files = { available: false, reason: String(error) };
  }
  out(
    `sample ${label} http=${JSON.stringify(redact(httpSample))} ws=${JSON.stringify(redact(wsSample))} files=${JSON.stringify(redact(files))}`,
  );
  return { http: httpSample, ws: wsSample, files };
};
const waitComposer = (page, ms) =>
  waitFor(
    () =>
      evalJson(
        page,
        `(function(){return Boolean(document.querySelector('[contenteditable="true"]'));})()`,
      ),
    ms,
    'composer',
  );
const typeComposer = async (page, text) => {
  const focused = await evalJson(
    page,
    `(function(){const el=document.querySelector('[contenteditable="true"]');if(!el)return false;el.focus();return true;})()`,
  );
  if (!focused) throw new Error('composer missing');
  await page.send('Input.insertText', { text });
};
const waitList = (page, origin, cookie, running, ms, label) =>
  waitFor(
    async () => {
      await evalJson(
        page,
        `(function(){const el=document.querySelector('button[aria-label="Allow once"],button[aria-label="允许一次"]');if(el)el.click();return true;})()`,
      );
      const listed = listRunning(await rpcCall(origin, cookie, 'session/list', {}));
      return listed.ok && listed.anyRunning === running ? listed : null;
    },
    ms,
    label,
  );
const report = (httpOk, wsOk, filesOk, inventory) => {
  out('path-inventory');
  const last = new Map(inventory.map((row) => [row.phase, row]));
  for (const phase of PHASES) {
    const row = last.get(phase);
    if (row)
      out(
        `  ${row.phase}: HTTP ${row.http.join(' ') || '(none)'}; WS ${row.ws.join(' ') || '(none)'}`,
      );
  }
  if (httpOk) {
    out('signal http session/list items[].running true-while-running false-while-idle x3');
    out('adopted-candidate http:session/list.items.running');
  } else out('signal http unavailable-or-not-distinct');
  if (wsOk) {
    out('signal ws api-session/status running true-then-false x3');
    out('adopted-candidate ws:api-session/status.running');
  } else out('signal ws unavailable-or-not-distinct');
  if (filesOk) out('signal files digest-differs x3');
  else out('signal files unavailable-or-not-distinct');
  if (!httpOk && !wsOk && !filesOk) {
    out('未找到可靠信号');
    process.exit(1);
  }
};
const drive = async () => {
  const origin = env('PROBE_ORIGIN');
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const home = env('PROBE_HOME');
  const screenshot = env('PROBE_SCREENSHOT');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const taskMs = Number(env('PROBE_TASK_SECONDS')) * 1000;
  const buckets = Object.fromEntries(
    PHASES.map((phase) => [phase, { http: new Set(), ws: new Set() }]),
  );
  const current = { value: 'homepage' };
  const errors = [];
  const chrome = await startChrome(env('CHROME_BIN'), env('PROBE_PROFILE'), env('PROBE_PID_FILE'));
  const page = await connectPage(chrome.browserWs);
  for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
  page.on('Network.requestWillBeSent', (p) => {
    if (p.request?.url) buckets[current.value].http.add(redactUrl(p.request.url));
  });
  page.on('Network.webSocketCreated', (p) => {
    if (p.url) buckets[current.value].ws.add(redactUrl(p.url));
  });
  page.on('Runtime.exceptionThrown', (p) =>
    errors.push(String(p.exceptionDetails?.text ?? 'exception')),
  );
  page.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') errors.push(String(p.entry.text ?? ''));
  });
  const mux = await muxListen(origin, cookie, { ready: false, last: null, history: [] });
  await page.send('Network.setCookie', {
    name: cookie.split('=', 1)[0],
    value: cookie.slice(cookie.indexOf('=') + 1),
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  await page.send('Page.navigate', { url: `${origin}/` });
  await waitFor(() => evalJson(page, 'document.readyState==="complete"'), browserMs, 'homepage');
  await waitComposer(page, browserMs);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
  out(`screenshot ${screenshot} bytes=${(await stat(screenshot)).size}`);
  const inventory = [snapshot(buckets.homepage, 'homepage')];
  const openSession = async () => {
    current.value = 'new-session';
    await clickSelector(page, NEW_BTN);
    await waitComposer(page, browserMs);
    inventory.push(snapshot(buckets['new-session'], 'new-session'));
  };
  await openSession();
  const cycles = [];
  for (let index = 1; index <= 3; index += 1) {
    if (index > 1) await openSession();
    current.value = 'message';
    await typeComposer(page, PROMPT);
    await clickSelector(page, SEND_BTN);
    inventory.push(snapshot(buckets.message, 'message'));
    current.value = 'running';
    await waitList(page, origin, cookie, true, taskMs, `cycle-${index}-running`);
    const running = await sample(origin, cookie, home, mux, `cycle-${index}-running`);
    inventory.push(snapshot(buckets.running, 'running'));
    current.value = 'complete';
    await waitList(page, origin, cookie, false, taskMs, `cycle-${index}-idle`);
    const idle = await sample(origin, cookie, home, mux, `cycle-${index}-idle`);
    inventory.push(snapshot(buckets.complete, 'complete'));
    cycles.push({ running, idle });
  }
  mux.close();
  page.close();
  chrome.child.kill('SIGTERM');
  const leftover = errors.filter((text) => !/favicon|sourcemap/i.test(text));
  if (leftover.length) fail(`unhandled console errors: ${leftover.join('; ')}`);
  report(
    cycles.every(
      (c) =>
        c.running.http.ok && c.running.http.anyRunning && c.idle.http.ok && !c.idle.http.anyRunning,
    ),
    cycles.every(
      (c) =>
        c.running.ws.available &&
        c.idle.ws.available &&
        c.running.ws.last === true &&
        c.idle.ws.last === false,
    ),
    cycles.every(
      (c) =>
        c.running.files.available &&
        c.idle.files.available &&
        c.running.files.digest !== c.idle.files.digest,
    ),
    inventory,
  );
};
const command = process.argv[2];
if (command === 'exchange') exchange().catch((error) => fail(String(error)));
else if (command === 'drive') drive().catch((error) => fail(String(error)));
else fail('usage: probe-dsh-api-browser.mjs exchange|drive', 2);

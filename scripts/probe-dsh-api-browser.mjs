#!/usr/bin/env node
/** Host token exchange, CDP UI drive, path inventory, idle samples. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectPage, httpRequest, muxListen, sleep, startChrome } from './probe-dsh-api-cdp.mjs';

const PHASES = ['homepage', 'new-session', 'message', 'running', 'complete'];
const SECRET = /^(token|access_token|api[_-]?key|authorization|cookie)$/i;
const MSG = /^(text|content|message|prompt|body)$/i;
const NEW_BTN = 'button[aria-label="New session"],button[aria-label="新建会话"]';
const SEND_BTN = 'button[aria-label="Send message"],button[aria-label="发送消息"]';
const MARKER = 'dsh-team-probe';
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`probe-dsh-api: ${message}\n`);
  process.exitCode = code;
  throw Object.assign(new Error(message), { code, probeFail: true });
};
const env = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is missing`, 2);
  return value;
};
const readSecret = async (name) => (await readFile(env(name), 'utf8')).trim();
const redactUrl = (raw) => {
  try {
    return new URL(raw, 'http://127.0.0.1').pathname || '[unparseable-url]';
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
const errorCode = (text) => {
  const raw = String(text ?? 'error');
  const match = raw.match(/\b(?:[A-Z][A-Za-z]+Error|HTTP[/_-]?\d{3}|E[A-Z0-9_]+|net::[A-Z_]+)\b/);
  return match?.[0] ?? 'error';
};
const tally = (codes) => {
  const counts = {};
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  return (
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => `${code}:${count}`)
      .join(',') || '(none)'
  );
};
const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* retry until deadline */
    }
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
const listRunning = (result) => {
  if (!result?.ok || !Array.isArray(result.value?.items)) {
    return { available: false, reason: result?.error ?? 'list', items: [] };
  }
  const items = [];
  for (const item of result.value.items) {
    if (typeof item?.running !== 'boolean') {
      return { available: false, reason: 'unknown-running', items: [] };
    }
    items.push({
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      running: item.running,
    });
  }
  return {
    available: true,
    anyRunning: items.some((item) => item.running),
    items,
  };
};
const evalJson = async (page, expression) => {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(errorCode(result.exceptionDetails.text));
  return result.result?.value;
};
const clickSelector = async (page, selector) => {
  const ok = await evalJson(
    page,
    `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return false;el.click();return true;})()`,
  );
  if (!ok) throw new Error(`missing ${selector}`);
};
const scanState = async (home) => {
  const names = [];
  let scanError = null;
  const walk = async (dir, depth) => {
    if (depth > 4 || scanError) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      scanError = errorCode(error);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      names.push(`${dir}/${entry.name}`.slice(home.length + 1));
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, depth + 1);
    }
  };
  await walk(home, 0);
  if (scanError) return { available: false, reason: scanError };
  return {
    available: true,
    predicate: 'unavailable',
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
const sampleHttp = async (origin, cookie) => {
  try {
    return listRunning(await rpcCall(origin, cookie, 'session/list', { _request: {} }));
  } catch (error) {
    return { available: false, reason: errorCode(error) };
  }
};
const sampleWs = (mux, sessionId, from, until) => {
  if (mux.store.closed) return { available: false, reason: mux.store.reason ?? 'disconnected' };
  if (!mux.store.ready) return { available: false, reason: 'mux-not-ready' };
  const events = mux.store.events.filter(
    (event) => event.sessionId === sessionId && event.t >= from && event.t <= until,
  );
  if (!events.length) return { available: true, last: 'unknown', observed: [] };
  return {
    available: true,
    last: events.at(-1).running,
    observed: events.slice(-3).map((e) => e.running),
  };
};
const sampleFiles = async (home) => {
  try {
    return await scanState(home);
  } catch (error) {
    return { available: false, reason: errorCode(error) };
  }
};
const sample = async (origin, cookie, home, mux, sessionId, from, until, label) => {
  const [httpSample, files] = await Promise.all([sampleHttp(origin, cookie), sampleFiles(home)]);
  const wsSample = sampleWs(mux, sessionId, from, until);
  const httpOut = httpSample.available
    ? {
        available: true,
        anyRunning: httpSample.anyRunning,
        items: httpSample.items.map((item) => ({ running: item.running })),
      }
    : httpSample;
  out(
    `sample ${label} http=${JSON.stringify(redact(httpOut))} ws=${JSON.stringify(redact(wsSample))} files=${JSON.stringify(redact(files))}`,
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
const clickAllowOnce = async (page, marker) => {
  const script = `(function(){
    const marker=${JSON.stringify(marker)};
    const labels=new Set(["Allow once","允许一次"]);
    for (const root of document.querySelectorAll("[data-approval-key]")) {
      if (!root.innerText.includes(marker)) continue;
      const buttons=[...root.querySelectorAll("button")];
      const allow=buttons.find((el)=>labels.has((el.textContent||"").trim()) && !el.disabled);
      if (!allow) return "disabled";
      allow.click();
      return "clicked";
    }
    return "absent";
  })()`;
  return evalJson(page, script);
};
const waitQuiet = async (pending, ms) => {
  const deadline = Date.now() + ms;
  let last = pending.count;
  let idleAt = Date.now();
  while (Date.now() < deadline) {
    if (pending.count !== last) {
      last = pending.count;
      idleAt = Date.now();
    } else if (Date.now() - idleAt >= 400) return;
    await sleep(50);
  }
};
const waitPhaseEvent = async (bucket, kind, test, ms, label) => {
  const prev = new Set(bucket[kind]);
  await waitFor(
    () => {
      for (const value of bucket[kind]) {
        if (!prev.has(value) && test(value)) return true;
      }
      return false;
    },
    ms,
    label,
  );
};
const markerExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
const waitOracle = async (startPath, completePath, wantComplete, ms, label) => {
  let sawStart = await markerExists(startPath);
  try {
    await waitFor(
      async () => {
        const started = await markerExists(startPath);
        const done = await markerExists(completePath);
        if (started) sawStart = true;
        if (wantComplete) return sawStart && done;
        return started && !done;
      },
      ms,
      label,
    );
  } catch (error) {
    const started = await markerExists(startPath);
    const done = await markerExists(completePath);
    if (started && done && !wantComplete)
      throw new Error(`oracle-invalid-${label}`, { cause: error });
    throw error;
  }
  const started = await markerExists(startPath);
  const done = await markerExists(completePath);
  if (!started || (wantComplete && !done) || (!wantComplete && done)) {
    throw new Error(`oracle-invalid-${label}`);
  }
};
const report = (httpOk, wsOk, inventory) => {
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
  out('signal files metadata-only not-a-running-idle-predicate');
  if (!httpOk && !wsOk) {
    out('未找到可靠信号');
    process.exitCode = 1;
  }
};
const runCycle = async (ctx, index) => {
  const {
    page,
    origin,
    cookie,
    home,
    work,
    mux,
    buckets,
    current,
    pending,
    inventory,
    browserMs,
    taskMs,
  } = ctx;
  const tag = `${MARKER}-${index}-${randomUUID().slice(0, 8)}`;
  const startPath = join(work, `${tag}.start`);
  const completePath = join(work, `${tag}.complete`);
  const prompt =
    `Reply with exactly OK then run bash: ` +
    `touch /data/work/${tag}.start; sleep 8; touch /data/work/${tag}.complete. ` +
    `Do not skip the sleep or the marker files.`;
  current.value = 'message';
  await typeComposer(page, prompt);
  await clickSelector(page, SEND_BTN);
  await waitPhaseEvent(
    buckets.message,
    'http',
    (path) => path.includes('/api/session/'),
    8_000,
    'message-http',
  );
  await waitQuiet(pending, 2_000);
  inventory.push(snapshot(buckets.message, 'message'));
  current.value = 'running';
  const runFrom = Date.now();
  await waitFor(
    async () => {
      const state = await clickAllowOnce(page, tag);
      return state === 'clicked' || (await markerExists(startPath));
    },
    taskMs,
    `cycle-${index}-approve`,
  );
  await waitOracle(startPath, completePath, false, taskMs, `cycle-${index}-running`);
  const listed = await sampleHttp(origin, cookie);
  let sessionId = listed.items?.find((item) => item.running)?.sessionId ?? '';
  if (!sessionId) {
    const hit = [...mux.store.events]
      .reverse()
      .find((event) => event.t >= runFrom && event.running);
    sessionId = hit?.sessionId ?? '';
  }
  const running = await sample(
    origin,
    cookie,
    home,
    mux,
    sessionId,
    runFrom,
    Date.now(),
    `cycle-${index}-running`,
  );
  await waitQuiet(pending, 1_000);
  inventory.push(snapshot(buckets.running, 'running'));
  current.value = 'complete';
  const idleFrom = Date.now();
  await waitOracle(startPath, completePath, true, taskMs, `cycle-${index}-complete`);
  await waitComposer(page, browserMs);
  const idle = await sample(
    origin,
    cookie,
    home,
    mux,
    sessionId,
    idleFrom,
    Date.now(),
    `cycle-${index}-idle`,
  );
  await waitQuiet(pending, 1_000);
  inventory.push(snapshot(buckets.complete, 'complete'));
  return { running, idle };
};
const attachPage = (page, buckets, current, pending, errors) => {
  page.on('Network.requestWillBeSent', (p) => {
    pending.count += 1;
    if (p.request?.url) buckets[current.value].http.add(redactUrl(p.request.url));
  });
  page.on('Network.webSocketCreated', (p) => {
    pending.count += 1;
    if (p.url) buckets[current.value].ws.add(redactUrl(p.url));
  });
  page.on('Runtime.exceptionThrown', (p) => errors.push(errorCode(p.exceptionDetails?.text)));
  page.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') errors.push(errorCode(p.entry.text));
  });
};
const drive = async () => {
  const origin = env('PROBE_ORIGIN');
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const home = env('PROBE_HOME');
  const work = env('PROBE_WORK');
  const screenshot = env('PROBE_SCREENSHOT');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const taskMs = Number(env('PROBE_TASK_SECONDS')) * 1000;
  const buckets = Object.fromEntries(
    PHASES.map((phase) => [phase, { http: new Set(), ws: new Set() }]),
  );
  const current = { value: 'homepage' };
  const errors = [];
  const pending = { count: 0 };
  let chrome;
  let page;
  let mux;
  try {
    chrome = await startChrome(env('CHROME_BIN'), env('PROBE_PROFILE'), env('PROBE_PID_FILE'));
    page = await connectPage(chrome.browserWs);
    for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
    attachPage(page, buckets, current, pending, errors);
    mux = await muxListen(origin, cookie, { ready: false, events: [] });
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
    await waitQuiet(pending, 2_000);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(dirname(screenshot), { recursive: true });
    await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
    out(`screenshot ${screenshot} bytes=${(await stat(screenshot)).size}`);
    const inventory = [snapshot(buckets.homepage, 'homepage')];
    const baseline = errors.slice();
    out(`console baseline ${tally(baseline)}`);
    const ctx = {
      page,
      origin,
      cookie,
      home,
      work,
      mux,
      buckets,
      current,
      pending,
      inventory,
      browserMs,
      taskMs,
    };
    const openSession = async () => {
      current.value = 'new-session';
      await clickSelector(page, NEW_BTN);
      await waitComposer(page, browserMs);
      await waitPhaseEvent(
        buckets['new-session'],
        'http',
        (path) => path.includes('/api/'),
        8_000,
        'new-session-http',
      );
      await waitQuiet(pending, 2_000);
      inventory.push(snapshot(buckets['new-session'], 'new-session'));
    };
    await openSession();
    const cycles = [await runCycle(ctx, 1)];
    await openSession();
    cycles.push(await runCycle(ctx, 2));
    await openSession();
    cycles.push(await runCycle(ctx, 3));
    out(`console new ${tally(errors.slice(baseline.length))}`);
    report(
      cycles.every(
        (c) =>
          c.running.http.available &&
          c.running.http.anyRunning === true &&
          c.idle.http.available &&
          c.idle.http.anyRunning === false,
      ),
      cycles.every(
        (c) =>
          c.running.ws.available &&
          c.idle.ws.available &&
          c.running.ws.last === true &&
          c.idle.ws.last === false,
      ),
      inventory,
    );
  } finally {
    try {
      mux?.close();
    } catch {
      /* closed */
    }
    try {
      page?.close();
    } catch {
      /* closed */
    }
    await chrome?.stop?.();
  }
};
const command = process.argv[2];
const run = async () => {
  if (command === 'exchange') await exchange();
  else if (command === 'drive') await drive();
  else fail('usage: probe-dsh-api-browser.mjs exchange|drive', 2);
};
run().catch((error) => {
  if (!error?.probeFail) {
    const text = String(error?.message ?? error);
    process.stderr.write(
      `probe-dsh-api: ${text.startsWith('chrome-start ') ? text : errorCode(error)}\n`,
    );
    process.exitCode ||= 1;
  }
});

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
const STOP_BTN = 'button[aria-label="Stop generating"],button[aria-label="停止生成"]';
const WORKSPACE_BTN = 'button[aria-label="Choose workspace"],button[aria-label="选择工作区"]';
const EDIT_PATH = 'input[aria-label="Edit path"],input[aria-label="编辑路径"]';
const EDIT_ZONE = 'button[aria-label="Edit path"],button[aria-label="编辑路径"]';
const MARKER = 'dsh-team-probe';
const WORKSPACE_PATH = '/data/work';
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`probe-dsh-api: ${message}\n`);
  process.exitCode = code;
  throw Object.assign(new Error(message), { code, probeFail: true });
};
const stageFail = (stage, code, cause) => {
  const error = new Error(`stage=${stage} error=${code}`);
  error.stage = stage;
  error.errorCode = code;
  if (cause !== undefined) error.cause = cause;
  throw error;
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
  const raw = String(text?.message ?? text ?? 'error');
  const staged = raw.match(/^stage=([a-z0-9-]+) error=([a-z0-9._:-]+)$/i);
  if (staged) return raw;
  if (raw.startsWith('chrome-start ')) return raw;
  if (raw.startsWith('oracle-invalid-')) return raw;
  if (raw.startsWith('timed out waiting for ')) {
    return `wait-timeout:${raw.slice('timed out waiting for '.length).replace(/\s+/g, '-')}`;
  }
  if (/^(http|ws|cdp)-(timeout|error|closed)$/.test(raw)) return raw;
  if (raw.startsWith('missing ')) return 'missing-control';
  if (raw === 'composer missing' || raw === 'missing edit-path') return raw.replace(/\s+/g, '-');
  const match = raw.match(/\b(?:[A-Z][A-Za-z]+Error|HTTP[/_-]?\d{3}|E[A-Z0-9_]+|net::[A-Z_]+)\b/);
  return match?.[0] ?? 'error';
};
const formatFailure = (error) => {
  if (error?.stage && error?.errorCode) return `stage=${error.stage} error=${error.errorCode}`;
  return errorCode(error);
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
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(errorCode(details.exception?.className ?? details.text));
  }
  return result.result?.value;
};
const clickSelector = async (page, selector) => {
  const ok = await evalJson(
    page,
    `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return false;el.click();return true;})()`,
  );
  if (!ok) throw new Error(`missing ${selector}`);
};
const clickTextButton = async (page, labels) => {
  const ok = await evalJson(
    page,
    `(function(){
      const labels=new Set(${JSON.stringify(labels)});
      const el=[...document.querySelectorAll("button")].find((node)=>{
        const text=(node.textContent||"").trim();
        return labels.has(text) && !node.disabled;
      });
      if(!el)return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`missing ${labels.join('|')}`);
};
const queryPresent = (page, selector) =>
  evalJson(
    page,
    `(function(){return Boolean(document.querySelector(${JSON.stringify(selector)}));})()`,
  );
const queryEnabled = (page, selector) =>
  evalJson(
    page,
    `(function(){const el=document.querySelector(${JSON.stringify(selector)});return Boolean(el&&!el.disabled);})()`,
  );
const buttonState = (page, labels, enabled) =>
  evalJson(
    page,
    `(function(){
      const labels=new Set(${JSON.stringify(labels)});
      const hits=[...document.querySelectorAll("button")].filter((el)=>labels.has((el.textContent||"").trim()));
      return ${JSON.stringify(enabled)} ? hits.some((el)=>!el.disabled) : hits.length > 0;
    })()`,
  );
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
  const httpPaths = [...new Set(bucket.http.map((row) => row.path))].sort();
  const wsUrls = [...new Set(bucket.ws.map((row) => row.path))].sort();
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
const composerReady = (page) =>
  evalJson(
    page,
    `(function(){const el=document.querySelector('[contenteditable="true"]');return Boolean(el&&!el.closest('[inert]'));})()`,
  );
const waitComposer = (page, ms) => waitFor(() => composerReady(page), ms, 'composer');
const typeComposer = async (page, text) => {
  const focused = await evalJson(
    page,
    `(function(){const el=document.querySelector('[contenteditable="true"]');if(!el||el.closest('[inert]'))return false;el.focus();return true;})()`,
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
const cursor = (bucket) => ({ http: bucket.seq.http, ws: bucket.seq.ws });
const eventsAfter = (rows, mark) => rows.filter((row) => row.seq > mark);
const waitRelevantHttp = async (bucket, test, mark, ms, label) => {
  const found = await waitFor(
    () => eventsAfter(bucket.http, mark).find((row) => test(row.path)),
    ms,
    label,
  );
  const requestId = found.requestId;
  if (!requestId) return found;
  await waitFor(
    () => bucket.done.has(requestId) || bucket.failed.has(requestId),
    ms,
    `${label}-response`,
  );
  return found;
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
const waitTurnIdle = (page, ms, label) =>
  waitFor(
    async () => !(await queryPresent(page, STOP_BTN)) && (await queryPresent(page, SEND_BTN)),
    ms,
    label,
  );
const waitHomepage = (page, ms) =>
  waitFor(() => evalJson(page, 'document.readyState==="complete"'), ms, 'homepage');
const clickIfPresent = async (page, selector) => {
  if (await queryEnabled(page, selector)) {
    await clickSelector(page, selector);
    return true;
  }
  return false;
};
const dismissNotice = async (page, ms) => {
  const labels = ['Continue', '继续'];
  if (!(await buttonState(page, labels, false))) return;
  await waitFor(
    async () =>
      !(await buttonState(page, labels, false)) || (await buttonState(page, labels, true)),
    ms,
    'notice',
  );
  if (!(await buttonState(page, labels, false))) return;
  await clickTextButton(page, labels);
  await waitFor(async () => !(await buttonState(page, labels, false)), ms, 'notice-closed');
};
const enterWorkspacePath = async (page) => {
  if (!(await queryPresent(page, EDIT_PATH))) {
    if (!(await clickIfPresent(page, EDIT_ZONE))) throw new Error('missing edit-path');
    await waitFor(() => queryPresent(page, EDIT_PATH), 8_000, 'edit-path');
  }
  const focused = await evalJson(
    page,
    `(function(){
      const el=document.querySelector(${JSON.stringify(EDIT_PATH)});
      if(!el||el.disabled)return false;
      el.focus();
      el.select?.();
      return true;
    })()`,
  );
  if (!focused) throw new Error('missing edit-path');
  await page.send('Input.insertText', { text: WORKSPACE_PATH });
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
  }
};
const openWorkspace = async (page, ms) => {
  const labels = ['Open', '打开'];
  await waitFor(
    async () => (await composerReady(page)) || (await buttonState(page, labels, true)),
    ms,
    'workspace-open',
  );
  if (await composerReady(page)) return;
  await clickTextButton(page, labels);
};
const setupFirstRun = async (page, ms) => {
  await dismissNotice(page, ms);
  if (await composerReady(page)) return;
  const pickerOpen = (await queryPresent(page, EDIT_PATH)) || (await queryPresent(page, EDIT_ZONE));
  if (!pickerOpen) {
    await waitFor(() => queryEnabled(page, WORKSPACE_BTN), ms, 'workspace');
    await clickSelector(page, WORKSPACE_BTN);
  }
  await waitFor(
    async () => (await queryPresent(page, EDIT_PATH)) || (await queryPresent(page, EDIT_ZONE)),
    ms,
    'workspace-picker',
  );
  await enterWorkspacePath(page);
  await openWorkspace(page, ms);
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
const emptyBucket = () => ({
  http: [],
  ws: [],
  seq: { http: 0, ws: 0 },
  done: new Set(),
  failed: new Set(),
});
const waitHttpResponse = async (bucket, requestId, ms, label) => {
  if (!requestId) return;
  await waitFor(() => bucket.done.has(requestId) || bucket.failed.has(requestId), ms, label);
};
const sampleRunning = async (ctx, from, label) => {
  const listed = await sampleHttp(ctx.origin, ctx.cookie);
  let sessionId = listed.items?.find((item) => item.running)?.sessionId ?? '';
  if (!sessionId) {
    sessionId =
      [...ctx.mux.store.events].reverse().find((event) => event.t >= from && event.running)
        ?.sessionId ?? '';
  }
  return {
    sessionId,
    observed: await sample(
      ctx.origin,
      ctx.cookie,
      ctx.home,
      ctx.mux,
      sessionId,
      from,
      Date.now(),
      label,
    ),
  };
};
const runCycle = async (ctx, index) => {
  const { page, work, buckets, current, pending, inventory, browserMs, taskMs } = ctx;
  const tag = `${MARKER}-${index}-${randomUUID().slice(0, 8)}`;
  const startPath = join(work, `${tag}.start`);
  const completePath = join(work, `${tag}.complete`);
  const prompt =
    `Reply with exactly OK then run bash: ` +
    `touch /data/work/${tag}.start; sleep 8; touch /data/work/${tag}.complete. ` +
    `Do not skip the sleep or the marker files.`;
  current.value = 'message';
  const beforeMessage = cursor(buckets.message);
  await typeComposer(page, prompt);
  await clickSelector(page, SEND_BTN);
  await waitRelevantHttp(
    buckets.message,
    (path) => path.includes('/api/session/'),
    beforeMessage.http,
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
  const { sessionId, observed: running } = await sampleRunning(
    ctx,
    runFrom,
    `cycle-${index}-running`,
  );
  const runningOpen = (await markerExists(startPath)) && !(await markerExists(completePath));
  if (!runningOpen) stageFail('oracle-idle', `cycle-${index}-running-closed`);
  await waitQuiet(pending, 1_000);
  inventory.push(snapshot(buckets.running, 'running'));
  current.value = 'complete';
  const idleFrom = Date.now();
  await waitOracle(startPath, completePath, true, taskMs, `cycle-${index}-complete`);
  await waitTurnIdle(page, browserMs, `cycle-${index}-idle`);
  const idle = await sample(
    ctx.origin,
    ctx.cookie,
    ctx.home,
    ctx.mux,
    sessionId,
    idleFrom,
    Date.now(),
    `cycle-${index}-idle`,
  );
  await waitQuiet(pending, 1_000);
  inventory.push(snapshot(buckets.complete, 'complete'));
  return { running, idle };
};
const openSession = async (ctx) => {
  const { page, buckets, current, pending, inventory, browserMs } = ctx;
  current.value = 'new-session';
  const before = cursor(buckets['new-session']);
  await clickSelector(page, NEW_BTN);
  try {
    await waitComposer(page, browserMs);
  } catch (error) {
    stageFail('new-session', errorCode(error), error);
  }
  const created = eventsAfter(buckets['new-session'].http, before.http).find((row) =>
    row.path.includes('/api/'),
  );
  if (created)
    await waitHttpResponse(
      buckets['new-session'],
      created.requestId,
      8_000,
      'new-session-http-response',
    );
  await waitQuiet(pending, 2_000);
  inventory.push(snapshot(buckets['new-session'], 'new-session'));
};
const runLabeled = async (ctx, index) => {
  try {
    return await runCycle(ctx, index);
  } catch (error) {
    if (error?.stage) throw error;
    const code = errorCode(error);
    const stage =
      code.includes('idle') || code.startsWith('oracle-invalid-') ? 'oracle-idle' : 'message';
    stageFail(stage, code, error);
  }
};
const captureHomepage = async (page, screenshot, pending, buckets, errors) => {
  await waitQuiet(pending, 2_000);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
  out(`screenshot ${screenshot} bytes=${(await stat(screenshot)).size}`);
  const inventory = [snapshot(buckets.homepage, 'homepage')];
  const baseline = errors.slice();
  out(`console baseline ${tally(baseline)}`);
  return { inventory, baseline };
};
const attachPage = (page, buckets, current, pending, errors) => {
  page.on('Network.requestWillBeSent', (p) => {
    pending.count += 1;
    const bucket = buckets[current.value];
    if (p.request?.url) {
      bucket.seq.http += 1;
      bucket.http.push({
        seq: bucket.seq.http,
        path: redactUrl(p.request.url),
        requestId: p.requestId,
      });
    }
  });
  page.on('Network.loadingFinished', (p) => {
    if (p.requestId) buckets[current.value].done.add(p.requestId);
  });
  page.on('Network.loadingFailed', (p) => {
    if (p.requestId) buckets[current.value].failed.add(p.requestId);
  });
  page.on('Network.webSocketCreated', (p) => {
    pending.count += 1;
    const bucket = buckets[current.value];
    if (p.url) {
      bucket.seq.ws += 1;
      bucket.ws.push({ seq: bucket.seq.ws, path: redactUrl(p.url), requestId: p.requestId });
    }
  });
  page.on('Runtime.exceptionThrown', (p) => errors.push(errorCode(p.exceptionDetails?.text)));
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push(errorCode(p.args?.[0]?.description ?? p.args?.[0]?.value ?? p.type));
    }
  });
  page.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') errors.push(errorCode(p.entry.text));
  });
};
const connectSession = async (origin, cookie, buckets, current, pending, errors) => {
  const chrome = await startChrome(env('CHROME_BIN'), env('PROBE_PROFILE'), env('PROBE_PID_FILE'));
  const page = await connectPage(chrome.browserWs);
  for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
  attachPage(page, buckets, current, pending, errors);
  const mux = await muxListen(origin, cookie, { ready: false, events: [] });
  await page.send('Network.setCookie', {
    name: cookie.split('=', 1)[0],
    value: cookie.slice(cookie.indexOf('=') + 1),
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  return { chrome, page, mux };
};
const reachComposer = async (page, origin, browserMs) => {
  const loaded = new Promise((resolve) => {
    page.on('Page.loadEventFired', () => resolve(true));
  });
  await page.send('Page.navigate', { url: `${origin}/` });
  await Promise.race([loaded, sleep(browserMs)]);
  try {
    await waitHomepage(page, browserMs);
  } catch (error) {
    stageFail('startup', errorCode(error), error);
  }
  try {
    await setupFirstRun(page, browserMs);
  } catch (error) {
    const code = errorCode(error);
    const stage = code.includes('notice') ? 'notice' : 'workspace';
    stageFail(stage, code, error);
  }
  try {
    await waitComposer(page, browserMs);
  } catch (error) {
    stageFail('composer', errorCode(error), error);
  }
};
const distinctHttp = (cycles) =>
  cycles.every(
    (c) =>
      c.running.http.available &&
      c.running.http.anyRunning === true &&
      c.idle.http.available &&
      c.idle.http.anyRunning === false,
  );
const distinctWs = (cycles) =>
  cycles.every(
    (c) =>
      c.running.ws.available &&
      c.idle.ws.available &&
      c.running.ws.last === true &&
      c.idle.ws.last === false,
  );
const drive = async () => {
  const origin = env('PROBE_ORIGIN');
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const home = env('PROBE_HOME');
  const work = env('PROBE_WORK');
  const screenshot = env('PROBE_SCREENSHOT');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const taskMs = Number(env('PROBE_TASK_SECONDS')) * 1000;
  const buckets = Object.fromEntries(PHASES.map((phase) => [phase, emptyBucket()]));
  const current = { value: 'homepage' };
  const errors = [];
  const pending = { count: 0 };
  let chrome;
  let page;
  let mux;
  try {
    ({ chrome, page, mux } = await connectSession(
      origin,
      cookie,
      buckets,
      current,
      pending,
      errors,
    ));
    await reachComposer(page, origin, browserMs);
    const { inventory, baseline } = await captureHomepage(
      page,
      screenshot,
      pending,
      buckets,
      errors,
    );
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
    await openSession(ctx);
    const cycles = [await runLabeled(ctx, 1)];
    await openSession(ctx);
    cycles.push(await runLabeled(ctx, 2));
    await openSession(ctx);
    cycles.push(await runLabeled(ctx, 3));
    const added = errors.slice(baseline.length);
    out(`console new ${tally(added)}`);
    if (added.length) stageFail('console', tally(added));
    report(distinctHttp(cycles), distinctWs(cycles), inventory);
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
    process.stderr.write(`probe-dsh-api: ${formatFailure(error)}\n`);
    process.exitCode ||= 1;
  }
});

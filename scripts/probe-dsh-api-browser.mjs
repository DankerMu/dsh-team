#!/usr/bin/env node
/** Host token exchange, CDP UI drive, path inventory, idle samples. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectPage, httpRequest, muxListen, sleep, startChrome } from './probe-dsh-api-cdp.mjs';
import {
  NEW_BTN,
  SEND_BTN,
  clickAllowOnce,
  clickSelector,
  errorCode,
  remainingMs,
  reportDiagnostic,
  setupFirstRun,
  typeComposer,
  waitComposer,
  waitFor,
  waitHomepage,
  waitTurnIdle,
} from './probe-dsh-api-ui.mjs';

const PHASES = ['homepage', 'new-session', 'message', 'running', 'complete'];
const SECRET = /^(token|access_token|api[_-]?key|authorization|cookie)$/i;
const MSG = /^(text|content|message|prompt|body)$/i;
const MARKER = 'dsh-team-probe';
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
    const url = new URL(raw, 'http://127.0.0.1');
    if (!/^(https?|wss?):$/.test(url.protocol)) return '[non-network-url]';
    return url.pathname || '[unparseable-url]';
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
  const until = Date.now() + browserMs;
  const loaded = new Promise((resolve) => {
    page.on('Page.loadEventFired', () => resolve(true));
  });
  await page.send('Page.navigate', { url: `${origin}/` });
  await Promise.race([loaded, sleep(remainingMs(until, 'startup'))]);
  try {
    await waitHomepage(page, remainingMs(until, 'homepage'));
  } catch (error) {
    stageFail('startup', errorCode(error), error);
  }
  try {
    await setupFirstRun(page, until);
  } catch (error) {
    const code = errorCode(error);
    const stage = code.includes('notice') ? 'notice' : 'workspace';
    stageFail(stage, code, error);
  }
  try {
    await waitComposer(page, remainingMs(until, 'composer'));
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
  } catch (error) {
    try {
      await reportDiagnostic(page, screenshot, current);
    } catch {
      /* diagnostic must not replace the original error */
    }
    throw error;
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

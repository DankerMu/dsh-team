#!/usr/bin/env node
/** First-run UI observation, discovery, and mapped-host acceptance. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  connectPage,
  exchangeLaunchToken,
  rpcCall,
  sleep,
  startChrome,
} from './probe-dsh-api-cdp.mjs';
import {
  FIRST_RUN_HOST,
  FIRST_RUN_MARKER,
  captureSettledScreenshot,
  clearComposer,
  composerText,
  errorCode,
  observeFirstRun,
  remainingMs,
  settleFirstRun,
  setupFirstRun,
  typeComposer,
  waitAppReady,
  waitFor,
  watchFirstRun,
} from './probe-dsh-api-ui.mjs';

const out = (line) => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`probe-first-run: ${message}\n`);
  process.exitCode = code;
  throw Object.assign(new Error(message), { code, probeFail: true });
};
const env = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is missing`, 2);
  return value;
};
const optionalEnv = (name) => process.env[name] ?? '';
const readSecret = async (name) => (await readFile(env(name), 'utf8')).trim();
const mappedFlags = (host) => [
  '--lang=en-US',
  `--host-resolver-rules=MAP ${host} 127.0.0.1`,
  '--no-proxy-server',
];
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
const attachErrors = (page, errors) => {
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
const requestPath = (url) => {
  try {
    const parsed = new URL(url, 'http://127.0.0.1');
    return /^(https?|wss?):$/.test(parsed.protocol) ? parsed.pathname : '[non-network-url]';
  } catch {
    return '[unparseable-url]';
  }
};

const attachNetwork = (page, requests) => {
  page.on('Network.requestWillBeSent', (p) => {
    requests.push({ method: p.request?.method ?? '', path: requestPath(p.request?.url ?? '') });
  });
};

const openMappedPage = async ({ origin, cookie, extraFlags }) => {
  const chrome = await startChrome(
    env('CHROME_BIN'),
    env('PROBE_PROFILE'),
    env('PROBE_PID_FILE'),
    extraFlags,
  );
  const page = await connectPage(chrome.browserWs);
  const errors = [];
  const requests = [];
  for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
  attachErrors(page, errors);
  attachNetwork(page, requests);
  await page.send('Network.setCookie', {
    name: cookie.split('=', 1)[0],
    value: cookie.slice(cookie.indexOf('=') + 1),
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  return { chrome, page, errors, requests };
};

const navigateReady = async (page, origin, ms) => {
  const until = Date.now() + ms;
  const loaded = new Promise((resolve) => {
    page.on('Page.loadEventFired', () => resolve(true));
  });
  await page.send('Page.navigate', { url: `${origin}/` });
  await Promise.race([loaded, sleep(remainingMs(until, 'startup'))]);
  await waitAppReady(page, remainingMs(until, 'app-ready'));
};

const assertAttribution = (state) => {
  if (state.hostname !== FIRST_RUN_HOST) {
    throw new Error(`stage=attribution error=hostname-${state.hostname || 'empty'}`);
  }
  const languages = Array.isArray(state.languages) ? state.languages : [];
  const english = languages.every((item) => String(item).toLowerCase().startsWith('en'));
  if (
    !english ||
    !String(state.navigatorLanguage ?? '')
      .toLowerCase()
      .startsWith('en')
  ) {
    throw new Error('stage=attribution error=navigator-language');
  }
};

const summarizeState = (state, extras = {}) => ({
  hostname: state.hostname,
  languages: state.languages,
  navigatorLanguage: state.navigatorLanguage,
  lang: state.lang,
  notice: state.notice,
  editable: state.editable,
  workspaceChoice: state.workspaceChoice,
  zhVisible: state.zhVisible,
  enVisible: state.enVisible,
  ...extras,
});

const settingsValues = (describe, ns, field) => {
  const row = describe?.value?.namespaces?.find((item) => item.ns === ns);
  const value = row?.value?.[field];
  return typeof value === 'string' ? { [field]: value } : null;
};

const LOOPBACK_HOST = '127.0.0.1';

const mappedRpc = async (origin, cookie, method, payload) => {
  try {
    return await rpcCall(origin, cookie, method, payload, LOOPBACK_HOST);
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
};

const sessionCwds = (result) => {
  if (!result?.ok || !Array.isArray(result.value?.items)) {
    return { available: false, reason: result?.error ?? 'rpc', cwds: [] };
  }
  return {
    available: true,
    cwds: result.value.items.map((item) => item?.cwd).filter((cwd) => typeof cwd === 'string'),
  };
};

const sampleHost = async (origin, cookie) => {
  const [settings, sessions] = await Promise.all([
    mappedRpc(origin, cookie, 'settings/describe', {}),
    mappedRpc(origin, cookie, 'session/list', { _request: {} }),
  ]);
  const sessionsView = sessionCwds(sessions);
  const workspace = JSON.parse(await readFile(env('PROBE_WORKSPACE_EVIDENCE'), 'utf8'));
  return {
    locale: settingsValues(settings, 'locale', 'preference'),
    notice: settingsValues(settings, 'ui-settings-general', 'welcomeNoticeVersion'),
    workspace,
    sessions: sessionsView,
  };
};

const collectObservation = async ({ origin, cookie, extraFlags, screenshot, browserMs }) => {
  const { chrome, page, errors } = await openMappedPage({ origin, cookie, extraFlags });
  try {
    await navigateReady(page, origin, browserMs);
    const watched = await watchFirstRun(page, Math.min(8_000, browserMs));
    const settled = await settleFirstRun(page, Math.min(4_000, browserMs));
    const last = settled.last;
    const noticeSeen = watched.noticeSeen || settled.noticeSeen || Boolean(last.notice);
    assertAttribution(last);
    const shot = await captureSettledScreenshot(page, screenshot);
    const host = await sampleHost(origin, cookie);
    return {
      ui: summarizeState(last, { noticeSeen, consoleErrors: errors.slice() }),
      host,
      screenshot: shot,
      errors: errors.slice(),
    };
  } finally {
    try {
      page?.close();
    } catch {
      /* closed */
    }
    await chrome?.stop?.();
  }
};

const proveComposer = async (page, requests) => {
  const before = requests.length;
  await typeComposer(page, FIRST_RUN_MARKER);
  const typed = await composerText(page);
  if (!typed.includes(FIRST_RUN_MARKER)) throw new Error('stage=composer error=marker-missing');
  await clearComposer(page);
  const afterClear = await composerText(page);
  if (afterClear.includes(FIRST_RUN_MARKER))
    throw new Error('stage=composer error=marker-uncleared');
  const sent = requests
    .slice(before)
    .some((row) => row.method === 'POST' && row.path.includes('/api/session/'));
  if (sent) throw new Error('stage=composer error=model-send');
  return { typed: true, cleared: true, modelSend: false };
};

const workBoundFromHost = (host) =>
  host.workspace.workBound === true && host.sessions.cwds.every((cwd) => cwd === '/data/work');

const acceptVerdict = (last, noticeSeen) => ({
  chinese: last.zhVisible.length >= 2 && last.lang.toLowerCase().startsWith('zh'),
  workspaceReady: last.editable && !last.workspaceChoice,
  noNotice: !noticeSeen,
  noticeSeen,
});

const closeMapped = async (page, chrome) => {
  try {
    page?.close();
  } catch {
    /* closed */
  }
  await chrome?.stop?.();
};

const acceptReady = async ({
  page,
  requests,
  errors,
  origin,
  cookie,
  screenshot,
  last,
  verdict,
}) => {
  const shot = await captureSettledScreenshot(page, screenshot);
  const input = await proveComposer(page, requests);
  const host = await sampleHost(origin, cookie);
  const workBound = workBoundFromHost(host);
  const added = errors.slice();
  if (added.length) throw new Error(`stage=console error=${tally(added)}`);
  return {
    accepted: Boolean(workBound),
    ui: summarizeState(last, verdict),
    host,
    input,
    screenshot: shot,
    consoleErrors: added,
    workBound,
  };
};

const acceptObservation = async ({ origin, cookie, extraFlags, screenshot, browserMs }) => {
  const { chrome, page, errors, requests } = await openMappedPage({ origin, cookie, extraFlags });
  try {
    await navigateReady(page, origin, browserMs);
    const watched = await watchFirstRun(page, Math.min(8_000, browserMs));
    const settled = await settleFirstRun(page, Math.min(4_000, browserMs));
    const last = settled.last;
    const noticeSeen = watched.noticeSeen || settled.noticeSeen || Boolean(last.notice);
    assertAttribution(last);
    const verdict = acceptVerdict(last, noticeSeen);
    if (verdict.workspaceReady && verdict.chinese && verdict.noNotice) {
      return await acceptReady({
        page,
        requests,
        errors,
        origin,
        cookie,
        screenshot,
        last,
        verdict,
      });
    }
    const shot = await captureSettledScreenshot(page, screenshot);
    const host = await sampleHost(origin, cookie);
    return {
      accepted: false,
      ui: summarizeState(last, verdict),
      host,
      input: { typed: false, cleared: false, modelSend: false },
      screenshot: shot,
      consoleErrors: errors.slice(),
      workBound: false,
    };
  } finally {
    await closeMapped(page, chrome);
  }
};

const exchange = async () => {
  const host = env('PROBE_HOST');
  const port = Number(env('PROBE_PORT'));
  const token = await readSecret('PROBE_TOKEN_FILE');
  const cookieHost = optionalEnv('PROBE_COOKIE_HOST') || host;
  try {
    process.stdout.write(await exchangeLaunchToken({ host, port, token, cookieHost }));
  } catch (error) {
    fail(error?.message ?? 'token exchange failed', 1);
  }
};

const observe = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const screenshot = env('PROBE_SCREENSHOT');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const extraFlags = mappedFlags(FIRST_RUN_HOST);
  const result = await collectObservation({
    origin,
    cookie,
    extraFlags,
    screenshot,
    browserMs,
  });
  out(JSON.stringify({ mode: 'observe', ...result }));
};

const discover = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const home = env('PROBE_HOME');
  const beforeRoot = env('PROBE_DISCOVER_BEFORE');
  const afterRoot = env('PROBE_DISCOVER_AFTER');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const extraFlags = mappedFlags(FIRST_RUN_HOST);
  const { chrome, page } = await openMappedPage({ origin, cookie, extraFlags });
  try {
    await navigateReady(page, origin, browserMs);
    await setupFirstRun(page, Date.now() + browserMs);
    await waitFor(
      async () => {
        const state = await observeFirstRun(page);
        return state.editable ? state : null;
      },
      browserMs,
      'discover-composer',
    );
  } finally {
    try {
      page?.close();
    } catch {
      /* closed */
    }
    await chrome?.stop?.();
  }
  out(
    JSON.stringify({
      mode: 'discover',
      before: relative(home, beforeRoot) || beforeRoot,
      after: relative(home, afterRoot) || afterRoot,
      hostname: FIRST_RUN_HOST,
    }),
  );
};

const accept = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const screenshot = env('PROBE_SCREENSHOT');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const extraFlags = mappedFlags(FIRST_RUN_HOST);
  const result = await acceptObservation({
    origin,
    cookie,
    extraFlags,
    screenshot,
    browserMs,
  });
  out(JSON.stringify({ mode: 'accept', ...result }));
};

const walkFiles = async (root) => {
  const files = [];
  const visit = async (dir, depth = 0) => {
    if (depth > 5 || files.length > 256) throw new Error('snapshot-discovery-bound');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(root);
  return files;
};

const copyFile = async (from, to) => {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
};

const diffHomes = async () => {
  const beforeRoot = env('PROBE_DISCOVER_BEFORE');
  const afterRoot = env('PROBE_DISCOVER_AFTER');
  const outDir = env('PROBE_DISCOVER_OUT');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const before = new Map();
  for (const file of await walkFiles(beforeRoot)) {
    before.set(relative(beforeRoot, file), await readFile(file));
  }
  const copied = [];
  for (const file of await walkFiles(afterRoot)) {
    const rel = relative(afterRoot, file);
    const previous = before.get(rel);
    const next = await readFile(file);
    if (!previous || !previous.equals(next)) {
      if (rel === 'cordis.patch.yml' || rel.startsWith('storages/')) {
        await copyFile(file, join(outDir, rel));
        copied.push(rel);
      }
    }
  }
  out(JSON.stringify({ mode: 'diff-home', copied }));
};

const workspaceStateShape = (value) =>
  typeof value?.initialized === 'boolean' && Array.isArray(value.workspaceIds);

const workspaceRecordShape = (value) =>
  typeof value?.path === 'string' &&
  typeof value?.title === 'string' &&
  Array.isArray(value?.sessionIds) &&
  typeof value?.createdAt === 'string' &&
  typeof value?.updatedAt === 'string';

const hasWorkspaceData = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (workspaceStateShape(value) || workspaceRecordShape(value)) return true;
  return Object.values(value).some(hasWorkspaceData);
};

const hasCredentialFields = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /token|cookie|password|secret|credential|api.?key/i.test(key) || hasCredentialFields(item),
  );
};

const containsWorkRecord = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (workspaceRecordShape(value)) return value.path === '/data/work';
  return Object.values(value).some(containsWorkRecord);
};

const snapshotHome = async () => {
  const root = env('PROBE_HOME');
  const target = env('PROBE_SNAPSHOT');
  const files = await walkFiles(join(root, 'storages'));
  if (files.length > 256) throw new Error('snapshot-file-bound');
  let workBound = false;
  for (const file of files) {
    const bytes = await readFile(file);
    if (bytes.length > 1_048_576) throw new Error('snapshot-byte-bound');
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (hasWorkspaceData(value) && !hasCredentialFields(value)) {
      await copyFile(file, join(target, relative(root, file)));
      if (containsWorkRecord(value)) workBound = true;
    }
  }
  await writeFile(
    join(target, 'workspace-evidence.json'),
    JSON.stringify({ available: true, workBound }),
  );
};

const command = process.argv[2];
const run = async () => {
  if (command === 'exchange') await exchange();
  else if (command === 'observe') await observe();
  else if (command === 'discover') await discover();
  else if (command === 'accept') await accept();
  else if (command === 'diff-home') await diffHomes();
  else if (command === 'snapshot-home') await snapshotHome();
  else fail('usage: probe-first-run.mjs exchange|observe|discover|accept|diff-home', 2);
};
run().catch((error) => {
  if (!error?.probeFail) {
    process.stderr.write(`probe-first-run: ${errorCode(error)}\n`);
    process.exitCode ||= 1;
  }
});

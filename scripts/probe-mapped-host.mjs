/** Import-safe mapped-host CDP/UI orchestration for first-run and managed-policy browsers. */
import {
  armWelcomeStoreObserver,
  connectPage,
  exchangeLaunchToken,
  rpcCall,
  sleep,
  startChrome,
  waitWelcomeStoreReady,
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
  reportDiagnostic,
  settleFirstRun,
  typeComposer,
  waitAppReady,
  waitFirstRunInitialized,
} from './probe-dsh-api-ui.mjs';
import {
  assertCompositionRoster,
  expectedCompositionRoster,
  waitCompositionInitialized,
} from './probe-first-run-composition.mjs';
import { verifyPreservation } from './probe-first-run-preservation.mjs';

export const mappedFlags = (host) => [
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

export const openMappedPage = async ({
  origin,
  cookie,
  extraFlags,
  composition = false,
  chromeBin,
  profile,
  pidFile,
}) => {
  const chrome = await startChrome(chromeBin, profile, pidFile, extraFlags);
  try {
    const page = await connectPage(chrome.browserWs);
    const errors = [];
    const requests = [];
    for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
    attachErrors(page, errors);
    attachNetwork(page, requests);
    const welcome = composition ? null : await armWelcomeStoreObserver(page);
    await page.send('Network.setCookie', {
      name: cookie.split('=', 1)[0],
      value: cookie.slice(cookie.indexOf('=') + 1),
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    return { chrome, page, errors, requests, welcome };
  } catch (error) {
    await chrome.stop();
    throw error;
  }
};

export const navigateReady = async (page, origin, ms, reload = false) => {
  const until = Date.now() + ms;
  const loaded = new Promise((resolve) => {
    page.on('Page.loadEventFired', () => resolve(true));
  });
  if (reload) await page.send('Page.reload', { ignoreCache: true });
  else await page.send('Page.navigate', { url: `${origin}/` });
  await Promise.race([loaded, sleep(remainingMs(until, 'startup'))]);
  await waitAppReady(page, remainingMs(until, 'app-ready'));
};

const trackNotice = async (page, notice) => {
  const state = await observeFirstRun(page);
  return { last: state, noticeSeen: notice.seen || Boolean(state.notice) };
};

export const assertAttribution = (state, expectedHost = FIRST_RUN_HOST) => {
  if (state.hostname !== expectedHost) {
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
  workspaceSelected: Boolean(state.workspaceSelected),
  workspaceLabel: state.workspaceLabel ?? '',
  pickerOpen: Boolean(state.pickerOpen),
  zhVisible: state.zhVisible,
  enVisible: state.enVisible,
  ...extras,
});

const LOOPBACK_HOST = '127.0.0.1';

const settingsValues = (describe, ns, field) => {
  const row = describe?.value?.namespaces?.find((item) => item.ns === ns);
  const value = row?.value?.[field];
  return typeof value === 'string' ? { [field]: value } : null;
};

export const mappedRpc = async (origin, cookie, method, payload) => {
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
  const cwds = result.value.items.map((item) => item?.cwd);
  return { available: true, cwds };
};

export const sampleHost = async (origin, cookie, workspace) => {
  const [settings, sessions] = await Promise.all([
    mappedRpc(origin, cookie, 'settings/describe', {}),
    mappedRpc(origin, cookie, 'session/list', { _request: {} }),
  ]);
  return {
    locale: settingsValues(settings, 'locale', 'preference'),
    notice: settingsValues(settings, 'ui-settings-general', 'welcomeNoticeVersion'),
    workspace,
    sessions: sessionCwds(sessions),
  };
};
export const workBoundFromHost = (host) => {
  if (host?.workspace?.available !== true) return { workBound: false, unknown: true };
  if (host?.sessions?.available !== true) return { workBound: false, unknown: true };
  const cwds = Array.isArray(host.sessions.cwds) ? host.sessions.cwds : [];
  if (!cwds.length) return { workBound: false, unknown: true };
  if (cwds.some((cwd) => typeof cwd !== 'string')) return { workBound: false, unknown: true };
  const bound = host.workspace.workBound === true && cwds.every((cwd) => cwd === '/data/work');
  return { workBound: bound, unknown: false };
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

const unusedInput = () => ({ typed: false, cleared: false, modelSend: false });

const maybeProveInput = async (page, requests, last) => {
  if (!last.editable || last.notice) return unusedInput();
  return proveComposer(page, requests);
};

const acceptVerdict = (last, noticeSeen, store) => {
  const acknowledged = Boolean(store?.acknowledged);
  return {
    chinese: last.zhVisible.length >= 2 && last.lang.toLowerCase().startsWith('zh'),
    workspaceSelected: Boolean(last.workspaceSelected),
    workspaceChoice: Boolean(last.workspaceChoice),
    inputUsable: Boolean(last.editable) && !last.notice,
    noNotice: acknowledged && !noticeSeen && !last.notice,
    noticeSeen,
    welcomeStatus: store?.status,
    welcomeAcknowledged: acknowledged,
  };
};

export const closeMapped = async (page, chrome, welcome) => {
  try {
    await welcome?.cleanup?.();
  } catch {
    /* welcome cleanup must not skip Chrome stop */
  }
  try {
    page?.close();
  } catch {
    /* closed */
  }
  await chrome?.stop?.();
};

const acceptedFrom = (binding, verdict, input) =>
  Boolean(
    !binding.unknown &&
    binding.workBound &&
    verdict.workspaceSelected &&
    verdict.chinese &&
    verdict.noNotice &&
    verdict.inputUsable &&
    input.typed &&
    input.cleared,
  );

const captureAcceptance = async ({
  page,
  requests,
  errors,
  welcome,
  origin,
  cookie,
  screenshot,
  until,
  expectedRoster,
  workspace,
  expectedHost,
}) => {
  const notice = { seen: (await observeFirstRun(page)).notice };
  const started = expectedRoster
    ? await waitCompositionInitialized(
        page,
        remainingMs(until, 'composition-initialized'),
        notice.seen,
        expectedRoster,
      )
    : {
        store: await waitWelcomeStoreReady(
          page,
          welcome,
          remainingMs(until, 'first-run-initialized'),
        ),
        last: (
          await waitFirstRunInitialized(
            page,
            remainingMs(until, 'first-run-initialized'),
            notice.seen,
          )
        ).last,
        noticeSeen: notice.seen,
        initialized: true,
      };
  const store = started.store;
  let last = started.last;
  let noticeSeen = started.noticeSeen || notice.seen || Boolean(last.notice);
  assertAttribution(last, expectedHost);
  if (started.initialized === false) {
    last = (await trackNotice(page, { seen: noticeSeen })).last;
    const shot = await captureSettledScreenshot(page, screenshot);
    const host = await sampleHost(origin, cookie, workspace);
    return {
      accepted: false,
      ui: summarizeState(last),
      host,
      input: unusedInput(),
      screenshot: shot,
      consoleErrors: errors.slice(),
    };
  }
  const settled = await settleFirstRun(
    page,
    Math.min(4_000, remainingMs(until, 'settle')),
    noticeSeen,
  );
  last = settled.last;
  noticeSeen ||= settled.noticeSeen || Boolean(last.notice);
  const input = await maybeProveInput(page, requests, last);
  last = (await trackNotice(page, { seen: noticeSeen })).last;
  noticeSeen ||= Boolean(last.notice);
  if (errors.length) throw new Error(`stage=console error=${tally(errors)}`);
  if (requests.some((row) => row.method === 'POST' && row.path === '/api/session/prompt')) {
    throw new Error('stage=composer error=model-send');
  }
  const shot = await captureSettledScreenshot(page, screenshot);
  const host = await sampleHost(origin, cookie, workspace);
  const binding = workBoundFromHost(host);
  const verdict = acceptVerdict(last, noticeSeen, store);
  let bootRoster;
  if (expectedRoster) {
    bootRoster = await assertCompositionRoster(page, expectedRoster);
    verdict.noNotice = !noticeSeen && !last.notice;
  }
  return {
    accepted: acceptedFrom(binding, verdict, input),
    ui: summarizeState(last, { ...verdict, initialized: true }),
    host,
    input,
    screenshot: shot,
    consoleErrors: errors.slice(),
    workBound: binding.workBound,
    workBoundUnknown: binding.unknown,
    initialized: true,
    ...(bootRoster ? { bootRoster, readiness: 'composition' } : {}),
  };
};

export const collectObservation = async ({
  origin,
  cookie,
  extraFlags,
  screenshot,
  browserMs,
  chromeBin,
  profile,
  pidFile,
  expectedHost = FIRST_RUN_HOST,
  workspace,
}) => {
  const { chrome, page, errors, requests, welcome } = await openMappedPage({
    origin,
    cookie,
    extraFlags,
    chromeBin,
    profile,
    pidFile,
  });
  try {
    const until = Date.now() + browserMs;
    await navigateReady(page, origin, remainingMs(until, 'startup'));
    return await captureAcceptance({
      page,
      requests,
      errors,
      welcome,
      origin,
      cookie,
      screenshot,
      until,
      expectedHost,
      workspace,
    });
  } finally {
    await closeMapped(page, chrome, welcome);
  }
};

const resolveCompositionRoster = async (composition, expectedRoster) => {
  if (!composition) return expectedRoster;
  const roster = Array.isArray(expectedRoster)
    ? expectedRoster
    : await expectedCompositionRoster(process.env.PROBE_BASELINE_OBSERVATION);
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error('stage=composition error=baseline-roster-unknown');
  }
  return roster;
};

const capturePreservation = async (
  page,
  preserveModels,
  browserMs,
  requests,
  expectedDefault,
  errors,
  screenshot,
  first,
  reload,
) => {
  if (!preserveModels) return undefined;
  if (!first.accepted || !reload.accepted) {
    throw new Error('stage=preservation error=first-entry-not-accepted');
  }
  try {
    const preservation = await verifyPreservation(
      page,
      preserveModels,
      browserMs,
      requests,
      expectedDefault,
    );
    if (errors.length) throw new Error(`stage=console error=${tally(errors)}`);
    preservation.screenshot = await captureSettledScreenshot(
      page,
      screenshot.replace(/\.png$/, '-preservation.png'),
    );
    return preservation;
  } catch (error) {
    await reportDiagnostic(page, screenshot.replace(/\.png$/, '-preservation-failure.png'), {
      value: 'homepage',
    });
    throw error;
  }
};

export const acceptObservation = async ({
  origin,
  cookie,
  extraFlags,
  screenshot,
  browserMs,
  composition = false,
  chromeBin,
  profile,
  pidFile,
  workspace,
  expectedHost = FIRST_RUN_HOST,
  expectedRoster,
  preserveModels,
  expectedDefault,
}) => {
  expectedRoster = await resolveCompositionRoster(composition, expectedRoster);
  const { chrome, page, errors, requests, welcome } = await openMappedPage({
    origin,
    cookie,
    extraFlags,
    composition,
    chromeBin,
    profile,
    pidFile,
  });
  try {
    const runEntry = async (shot, reload = false) => {
      const until = Date.now() + browserMs;
      await navigateReady(page, origin, remainingMs(until, 'startup'), reload);
      return await captureAcceptance({
        page,
        requests,
        errors,
        welcome,
        origin,
        cookie,
        screenshot: shot,
        until,
        expectedRoster,
        workspace,
        expectedHost,
      });
    };
    const first = await runEntry(screenshot);
    if (!composition) return first;
    const reload = await runEntry(screenshot.replace(/\.png$/, '-reload.png'), true);
    const preservation = await capturePreservation(
      page,
      preserveModels,
      browserMs,
      requests,
      expectedDefault,
      errors,
      screenshot,
      first,
      reload,
    );
    return {
      ...first,
      accepted: first.accepted && reload.accepted,
      reload,
      ...(preservation ? { preservation } : {}),
    };
  } finally {
    await closeMapped(page, chrome, welcome);
  }
};

export { exchangeLaunchToken };

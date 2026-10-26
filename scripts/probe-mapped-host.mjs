/** Import-safe mapped-host CDP/UI orchestration for first-run and managed-policy browsers. */
import {
  armWelcomeStoreObserver,
  connectPage,
  exchangeLaunchToken,
  rpcCall,
  sleep,
  observeNetwork,
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
  waitFor,
} from './probe-dsh-api-ui.mjs';
import {
  assertCompositionRoster,
  expectedCompositionRoster,
  readBootRoster,
  waitCompositionInitialized,
} from './probe-first-run-composition.mjs';
import { verifyPreservation } from './probe-first-run-preservation.mjs';
import { attachScopeObserver } from './probe-session-address.mjs';
import { verifyPlatformNav } from './probe-platform-nav.mjs';
import {
  collectRequestEvidence,
  disposeRequestEvidence,
  retainPageRequestFailure,
} from './probe-browser-evidence.mjs';

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
  observeNetwork(page, {
    'Network.requestWillBeSent': (p) => {
      requests.push({
        requestId: p.requestId,
        method: p.request?.method ?? '',
        path: requestPath(p.request?.url ?? ''),
      });
    },
  });
};

/** Passive creation receipts; no request/response bodies or cookie values enter evidence. */
const observeSessionAdmissions = (page, requests, origin, cookie) => {
  const calls = new Map();
  const completed = [];
  const createdSessionIds = [];
  let failedCreations = 0;
  observeNetwork(page, {
    'Network.responseReceived': ({ requestId, response }) => {
      const request = requests.find((row) => row.requestId === requestId);
      if (
        request?.method === 'POST' &&
        request.path === '/api/session/create' &&
        response.url === `${origin}/api/session/create`
      ) {
        calls.set(requestId, response.status);
      }
    },
    'Network.loadingFinished': ({ requestId }) => {
      if (calls.has(requestId)) completed.push(requestId);
    },
    'Network.loadingFailed': ({ requestId }) => {
      const request = requests.find((row) => row.requestId === requestId);
      if (request?.method === 'POST' && request.path === '/api/session/create') failedCreations++;
    },
  });
  const collect = async () => {
    while (completed.length) {
      const requestId = completed.shift();
      try {
        const response = await page.send('Network.getResponseBody', { requestId });
        const body = JSON.parse(
          response.base64Encoded
            ? Buffer.from(response.body, 'base64').toString('utf8')
            : response.body,
        );
        const id = body.result?.value?.sessionId;
        if (
          calls.get(requestId) !== 200 ||
          body.type !== 'server-response' ||
          body.result?.ok !== true ||
          typeof id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
        ) {
          failedCreations++;
        } else {
          createdSessionIds.push(id);
        }
      } catch {
        failedCreations++;
      }
    }
  };
  const creationCount = () =>
    requests.filter((row) => row.method === 'POST' && row.path === '/api/session/create').length;
  return async () => {
    // A receipt settling during inventory read requires a new read, not a mismatched checkpoint.
    const until = Date.now() + 5_000;
    for (;;) {
      await collect();
      const before = creationCount();
      const settledBefore = createdSessionIds.length + failedCreations;
      const result = await mappedRpc(origin, cookie, 'session/list', { _request: {} });
      const items = Array.isArray(result?.value?.items)
        ? result.value.items.map(({ sessionId, cwd }) => ({ sessionId, cwd }))
        : [];
      const sessionsAvailable =
        result?.ok === true &&
        Array.isArray(result.value?.items) &&
        items.every(
          ({ sessionId, cwd }) => typeof sessionId === 'string' && typeof cwd === 'string',
        );
      const { cookies } = await page.send('Network.getAllCookies');
      await collect();
      const creationRequests = creationCount();
      const pendingCreations = creationRequests - createdSessionIds.length - failedCreations;
      if (
        creationRequests !== before ||
        settledBefore !== createdSessionIds.length + failedCreations ||
        pendingCreations > 0
      ) {
        await sleep(Math.min(50, remainingMs(until, 'session-observation')));
        continue;
      }
      return {
        sessionsAvailable,
        items,
        cookieNames: cookies.map(({ name }) => name).sort(),
        creationRequests,
        createdSessionIds: createdSessionIds.slice(),
        failedCreations,
        pendingCreations,
        workspaceRequests: requests.filter((row) => row.path.startsWith('/api/workspace/')).length,
        promptRequests: requests.filter((row) => row.path === '/api/session/prompt').length,
      };
    }
  };
};

export const openMappedPage = async ({
  origin,
  cookie,
  extraFlags,
  composition = false,
  runtime,
  profile,
  receiptFile,
}) => {
  const chrome = await startChrome({ runtime, origin, profile, receiptFile, extraFlags });
  let page;
  try {
    page = await connectPage(chrome.browserWs);
    const errors = [];
    const requests = [];
    for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await page.send(`${domain}.enable`);
    attachErrors(page, errors);
    attachNetwork(page, requests);
    collectRequestEvidence(page);
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
    await closeMapped(page, chrome, undefined, { error });
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

export const closeMapped = async (page, chrome, welcome, failure) => {
  disposeRequestEvidence(page);
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
  let cleanupFailure;
  try {
    await chrome?.stop?.();
  } catch (cleanup) {
    cleanupFailure = { error: cleanup };
  }
  if (cleanupFailure) {
    if (failure)
      throw new AggregateError(
        [failure.error, cleanupFailure.error],
        'Browser scenario and cleanup failed',
        { cause: failure.error },
      );
    throw cleanupFailure.error;
  }
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

const initializeOrdinary = async (page, welcome, until, noticeSeen) => {
  const store = await waitWelcomeStoreReady(
    page,
    welcome,
    remainingMs(until, 'first-run-initialized'),
  );
  const initialized = await waitFirstRunInitialized(
    page,
    remainingMs(until, 'first-run-initialized'),
    noticeSeen,
    store,
  );
  return {
    store,
    last: initialized.last,
    noticeSeen: initialized.noticeSeen,
    initialized: initialized.initialized,
  };
};

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
    : await initializeOrdinary(page, welcome, until, notice.seen);
  const store = started.store;
  let last = started.last;
  let noticeSeen = started.noticeSeen || notice.seen || Boolean(last.notice);
  assertAttribution(last, expectedHost);
  if (started.initialized === false) {
    last = (await trackNotice(page, { seen: noticeSeen })).last;
    const shot = await captureSettledScreenshot(page, screenshot);
    const host = await sampleHost(origin, cookie, workspace);
    const bootRoster = expectedRoster ? undefined : await readBootRoster(page);
    return {
      accepted: false,
      ui: summarizeState(last),
      host,
      input: unusedInput(),
      screenshot: shot,
      consoleErrors: errors.slice(),
      initialized: false,
      ...(bootRoster ? { bootRoster, readiness: 'observe' } : {}),
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
  } else {
    bootRoster = await readBootRoster(page);
  }
  return {
    accepted: acceptedFrom(binding, verdict, input),
    ui: summarizeState(last, { ...verdict, initialized: started.initialized }),
    host,
    input,
    screenshot: shot,
    consoleErrors: errors.slice(),
    workBound: binding.workBound,
    workBoundUnknown: binding.unknown,
    initialized: started.initialized,
    bootRoster,
    readiness: expectedRoster ? 'composition' : 'observe',
  };
};

export const collectObservation = async ({
  origin,
  cookie,
  extraFlags,
  screenshot,
  browserMs,
  runtime,
  profile,
  receiptFile,
  expectedHost = FIRST_RUN_HOST,
  workspace,
}) => {
  const { chrome, page, errors, requests, welcome } = await openMappedPage({
    origin,
    cookie,
    extraFlags,
    runtime,
    profile,
    receiptFile,
  });
  let failure;
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
  } catch (error) {
    failure = { error };
    await retainPageRequestFailure(page, screenshot);
    throw error;
  } finally {
    await closeMapped(page, chrome, welcome, failure);
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
  preserveSessionId,
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
      preserveSessionId,
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

const assertPlatformNavMode = (platformNav, composition) => {
  if (platformNav !== undefined && !composition)
    throw new Error('stage=platform-nav error=composition-required');
};

const platformNavEvidence = async (platformNav, page, errors, screenshot, ms) =>
  platformNav
    ? {
        platformNav: await verifyPlatformNav({
          page,
          admin: platformNav === 'admin',
          errors,
          screenshot,
          ms,
        }),
      }
    : {};

export const acceptObservation = async ({
  origin,
  cookie,
  extraFlags,
  screenshot,
  browserMs,
  composition = false,
  runtime,
  profile,
  receiptFile,
  workspace,
  expectedHost = FIRST_RUN_HOST,
  expectedRoster,
  preserveModels,
  expectedDefault,
  preserveSessionId,
  observeSessions = false,
  platformNav,
}) => {
  expectedRoster = await resolveCompositionRoster(composition, expectedRoster);
  assertPlatformNavMode(platformNav, composition);
  const { chrome, page, errors, requests, welcome } = await openMappedPage({
    origin,
    cookie,
    extraFlags,
    composition,
    runtime,
    profile,
    receiptFile,
  });
  let failureShot = screenshot;
  let failure;
  try {
    const scope = { addresses: [] };
    if (preserveSessionId) {
      attachScopeObserver(page, scope);
      // Pinned DSH's native navigation preference only; no model state or Session history is seeded.
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `if(location.origin===${JSON.stringify(origin)})localStorage.setItem('dsh.sessions.current',${JSON.stringify(JSON.stringify({ sessionId: preserveSessionId }))});`,
      });
    }
    const sessionSnapshot = observeSessions
      ? observeSessionAdmissions(page, requests, origin, cookie)
      : undefined;
    const beforeSessionObservation = await sessionSnapshot?.();
    const runEntry = async (shot, reload = false) => {
      failureShot = shot;
      const until = Date.now() + browserMs;
      try {
        await navigateReady(page, origin, remainingMs(until, 'startup'), reload);
      } catch (error) {
        await retainPageRequestFailure(page, shot);
        try {
          process.stdout.write(
            `diagnostic navigation=${errorCode(error)} consoleErrors=${errors.length}\n`,
          );
          await reportDiagnostic(page, shot.replace(/\.png$/, '-navigation-failure.png'), {
            value: 'homepage',
          });
        } catch {
          /* Diagnostic failure must not replace the original navigation failure. */
        }
        throw error;
      }
      const observed = await captureAcceptance({
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
      if (!sessionSnapshot) return observed;
      const sessionObservation = await sessionSnapshot();
      return { ...observed, consoleErrors: errors.slice(), sessionObservation };
    };
    const first = await runEntry(screenshot);
    if (!composition)
      return {
        ...first,
        ...(beforeSessionObservation ? { beforeSessionObservation } : {}),
      };
    const reload = await runEntry(screenshot.replace(/\.png$/, '-reload.png'), true);
    const preservation = await capturePreservation(
      page,
      preserveModels,
      browserMs,
      requests,
      expectedDefault,
      preserveSessionId,
      errors,
      screenshot,
      first,
      reload,
    );
    if (preserveSessionId)
      await waitFor(
        () =>
          scope.addresses.some(
            (address) => address.kind === 'session' && address.sessionId === preserveSessionId,
          ),
        browserMs,
        'preservation-session-transport-address',
      );
    // Last: following the platform link leaves the DSH page.
    const navigation = await platformNavEvidence(platformNav, page, errors, screenshot, browserMs);
    return {
      ...first,
      ...(beforeSessionObservation ? { beforeSessionObservation } : {}),
      accepted: first.accepted && reload.accepted,
      reload,
      ...(preservation ? { preservation } : {}),
      ...(preserveSessionId ? { sessionAddressObserved: true } : {}),
      ...navigation,
    };
  } catch (error) {
    failure = { error };
    await retainPageRequestFailure(page, failureShot);
    throw error;
  } finally {
    await closeMapped(page, chrome, welcome, failure);
  }
};

export { exchangeLaunchToken };

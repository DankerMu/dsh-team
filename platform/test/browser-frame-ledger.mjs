/**
 * Every CDP session of one tab and what the network and console told each of them, so a frame's
 * documents and console entries are attributed to that frame whichever session reports them.
 *
 * The page session auto-attaches each new target (`waitForDebuggerOnStart`), and every attached
 * target is resumed after its domains are enabled: an iframe target first enables Network, Page,
 * Runtime and Log, so no response of its document is missed; any other target (a DSH worker)
 * enables Runtime. A sandboxed iframe may run out of process (an `iframe` target whose target id
 * is its frame id) or, as on Chromium 153, in the page's process; `owner` answers which session
 * holds it right now. Navigation requests of an out-of-process frame may be reported on the
 * parent session, so all sessions feed one ledger keyed by request id.
 *
 * Console errors belong to a frame by evidence, never by the reporting session: a Runtime event's
 * execution context (`executionContextCreated` `auxData.frameId`), a Log entry's network request
 * (`requestWillBeSent.frameId`), or else a Log entry's `url` equal to a frame's current document.
 */
import { waitFor } from '../../scripts/probe-dsh-api-ui.mjs';

const EXTRA_MS = 5_000;
const lower = (headers) =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );

/** A URL's pathname with any `/sidebar/html/<session>/…` preview path collapsed. */
export const routeOf = (url) => {
  try {
    const path = new URL(url).pathname;
    return path.startsWith('/sidebar/html/') ? '/sidebar/html' : path;
  } catch {
    return '[unparseable-url]';
  }
};

/** The redirect target's pathname, resolved against the hop it answered; null without one. */
const locationPath = (headers, url) => {
  if (headers.location === undefined) return null;
  try {
    return new URL(headers.location, url).pathname;
  } catch {
    return '[unparseable-url]';
  }
};

/** Only what evidence needs from the request headers as sent: never a cookie value. */
const sentHeaders = (headers) => {
  const sent = lower(headers);
  return { secFetchSite: sent['sec-fetch-site'] ?? null, cookie: 'cookie' in sent };
};

function createLedger() {
  return {
    /** requestId -> frameId, for every request whose frame is known. */
    frames: new Map(),
    /** requestId -> { frameId, hops: [{ url, response? }] } of Document requests only. */
    documents: new Map(),
    /** requestId -> one sentHeaders per hop, in the order Chrome reported them. */
    extras: new Map(),
    /** `${session}:${executionContextId}` -> frameId. */
    contexts: new Map(),
    /** frameId -> URL of its current document. */
    current: new Map(),
    /** Raw console errors, classified only once the probed frame is known. */
    console: [],
    failures: [],
  };
}

const response = ({ status, headers }, url) => {
  const received = lower(headers);
  return { status, headers: received, location: locationPath(received, url) };
};

/** A Document's next hop; a redirect first answers the hop before it. */
function documentHop(ledger, { requestId, frameId, request, redirectResponse }) {
  const row = ledger.documents.get(requestId) ?? { frameId, hops: [] };
  ledger.documents.set(requestId, row);
  row.frameId ??= frameId;
  const last = row.hops.at(-1);
  if (redirectResponse && last) last.response = response(redirectResponse, last.url);
  row.hops.push({ url: request?.url ?? '' });
}

/** The frame a Log entry without a request id belongs to: the one showing its URL. */
const frameShowing = (ledger, url) =>
  url ? [...ledger.current].find(([, current]) => current === url)?.[0] : undefined;

function networkListeners(ledger, session) {
  return [
    session.listen('Network.requestWillBeSent', (params) => {
      if (params.frameId) ledger.frames.set(params.requestId, params.frameId);
      if (params.type === 'Document') documentHop(ledger, params);
    }),
    session.listen('Network.requestWillBeSentExtraInfo', ({ requestId, headers }) => {
      ledger.extras.set(requestId, [...(ledger.extras.get(requestId) ?? []), sentHeaders(headers)]);
    }),
    session.listen('Network.responseReceived', (params) => {
      if (params.frameId) ledger.frames.set(params.requestId, params.frameId);
      const last = ledger.documents.get(params.requestId)?.hops.at(-1);
      if (params.type === 'Document' && last) last.response = response(params.response, last.url);
    }),
    session.listen('Page.frameNavigated', ({ frame }) => {
      ledger.current.set(frame.id, `${frame.url}${frame.urlFragment ?? ''}`);
    }),
  ];
}

/** Console listeners of one session; `key` is 'page' or the child's session id. */
function consoleListeners(ledger, session, key) {
  const frameOfContext = (id) => ledger.contexts.get(`${key}:${String(id)}`);
  return [
    session.listen('Runtime.executionContextCreated', ({ context }) => {
      const frameId = context?.auxData?.frameId;
      if (frameId) ledger.contexts.set(`${key}:${String(context.id)}`, frameId);
    }),
    session.listen('Log.entryAdded', ({ entry }) => {
      if (entry?.level !== 'error') return;
      ledger.console.push({
        key,
        kind: 'log',
        text: String(entry.text ?? ''),
        requestId: entry.networkRequestId,
        frameId: entry.networkRequestId ? undefined : frameShowing(ledger, entry.url),
      });
    }),
    session.listen('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const text = exceptionDetails?.exception?.description ?? exceptionDetails?.text;
      const frameId = frameOfContext(exceptionDetails?.executionContextId);
      ledger.console.push({ key, kind: 'exception', text: String(text ?? ''), frameId });
    }),
    session.listen('Runtime.consoleAPICalled', ({ type, args, executionContextId }) => {
      if (type !== 'error') return;
      const text = String(args?.[0]?.value ?? args?.[0]?.description ?? '');
      ledger.console.push({
        key,
        kind: 'console',
        text,
        frameId: frameOfContext(executionContextId),
      });
    }),
  ];
}

/** Every listener of one session, removed together. */
function observeSession(ledger, session, key) {
  const stops = [...networkListeners(ledger, session), ...consoleListeners(ledger, session, key)];
  return () => {
    for (const stop of stops) stop();
  };
}

/** Enable the attached target's domains, then let it run; a target that detached meanwhile is gone. */
async function resume(children, ledger, sessionId, waiting) {
  const child = children.get(sessionId);
  const domains = child.type === 'iframe' ? ['Network', 'Page', 'Runtime', 'Log'] : ['Runtime'];
  try {
    for (const domain of domains) await child.session.send(`${domain}.enable`);
    if (waiting) await child.session.send('Runtime.runIfWaitingForDebugger');
  } catch (error) {
    if (children.has(sessionId))
      ledger.failures.push({ type: child.type, error: String(error?.message ?? error) });
  }
}

/** True when every fragment of one allowed set appears in `text`. */
const allowedBy = (sets, text) =>
  sets.some((set) => set.every((fragment) => text.includes(fragment)));

/**
 * Start tracking every session of `page`. `allowed` lists fragment sets (all fragments of one set
 * must appear) of console errors tolerated only when they belong to the probed frame.
 */
export async function trackFrames(page, allowed) {
  const ledger = createLedger();
  /** sessionId -> { targetId, type, session, stop } of attached targets. */
  const children = new Map();
  const stops = [observeSession(ledger, page, 'page')];
  stops.push(
    page.listen('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }) => {
      const session = page.session(sessionId);
      const child = { targetId: targetInfo.targetId, type: targetInfo.type, session };
      child.stop = observeSession(ledger, session, sessionId);
      children.set(sessionId, child);
      void resume(children, ledger, sessionId, waitingForDebugger);
    }),
    page.listen('Target.detachedFromTarget', ({ sessionId }) => {
      children.get(sessionId)?.stop();
      children.delete(sessionId);
    }),
  );
  await page.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  /** The attached iframe target of `frameId`, else the page session (in-process frame). */
  const owner = (frameId) =>
    [...children.values()].find((child) => child.type === 'iframe' && child.targetId === frameId)
      ?.session ?? page;

  /** Request ids seen so far: a later document is one not in this set. */
  const known = () => new Set(ledger.documents.keys());

  /** Route and status of each hop of each Document of `frameId` since `before`; no URL. */
  const seen = (frameId, before) =>
    [...ledger.documents.entries()]
      .filter(([id, row]) => !before.has(id) && row.frameId === frameId)
      .map(([, row]) =>
        row.hops.map((hop) => ({ route: routeOf(hop.url), status: hop.response?.status ?? null })),
      );

  /**
   * The next Document of `frameId` not in `before` whose first URL `accept`s, once its final hop
   * answered. Each hop carries its response and, when Chrome reports them within EXTRA_MS, its
   * `sec-fetch-site` and whether a cookie was sent (both null otherwise).
   */
  async function nextDocument(frameId, before, accept, ms, label) {
    const find = () =>
      [...ledger.documents.entries()].find(
        ([id, row]) =>
          !before.has(id) &&
          row.frameId === frameId &&
          accept(row.hops[0]?.url ?? '') &&
          row.hops.at(-1)?.response !== undefined,
      );
    let found;
    try {
      found = await waitFor(find, ms, label);
    } catch (error) {
      throw new Error(`${label} documents=${JSON.stringify(seen(frameId, before))}`, {
        cause: error,
      });
    }
    const [requestId, row] = found;
    const sent = () => ledger.extras.get(requestId) ?? [];
    // Missing extra info is recorded as null and fails the caller's header expectation visibly.
    await waitFor(() => sent().length >= row.hops.length, EXTRA_MS, label).catch(() => undefined);
    return {
      requestId,
      url: row.hops[0].url,
      hops: row.hops.map((hop, index) => ({
        url: hop.url,
        ...hop.response,
        ...(sent()[index] ?? { secFetchSite: null, cookie: null }),
      })),
    };
  }

  /**
   * Console errors by frame: a request id names its frame at report time; other rows carry the
   * frame their context or URL named when they arrived. Whatever is not the probed frame's is the
   * page's or another target's. `pageEvents` counts every error event the page session reported,
   * for reconciliation with other collectors.
   */
  function consoleReport(frameId) {
    const report = { pageEvents: 0, allowed: [], probeErrors: [], otherErrors: [] };
    for (const row of ledger.console) {
      if (row.key === 'page') report.pageEvents++;
      const frame = row.requestId ? ledger.frames.get(row.requestId) : row.frameId;
      if (frame !== frameId) report.otherErrors.push(row);
      else if (row.kind === 'log' && allowedBy(allowed, row.text)) report.allowed.push(row);
      else report.probeErrors.push(row);
    }
    return report;
  }

  return {
    owner,
    known,
    nextDocument,
    consoleReport,
    failures: () => [...ledger.failures],
    /** Stop listening; the tab's browser is closed with its owner, auto-attach included. */
    dispose() {
      for (const stop of stops) stop();
      for (const child of children.values()) child.stop();
    },
  };
}

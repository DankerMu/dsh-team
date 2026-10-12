/** Passive, closed-field browser failure context; never traffic or acceptance policy. */
import { writeFile } from 'node:fs/promises';
import { observeNetwork } from './probe-dsh-api-cdp.mjs';

export const REQUEST_EVIDENCE_LIMITS = Object.freeze({ rows: 800, requests: 256, bytes: 524288 });
const resourceTypes = {
  Document: true,
  Stylesheet: true,
  Image: true,
  Media: true,
  Font: true,
  Script: true,
  TextTrack: true,
  XHR: true,
  Fetch: true,
  Prefetch: true,
  EventSource: true,
  WebSocket: true,
  Manifest: true,
  SignedExchange: true,
  Ping: true,
  CSPViolationReport: true,
  Preflight: true,
  Other: true,
};
const errors = {
  'net::ERR_NETWORK_CHANGED': true,
  'net::ERR_ABORTED': true,
  'net::ERR_CONNECTION_RESET': true,
  'net::ERR_CONNECTION_REFUSED': true,
  'net::ERR_CONNECTION_CLOSED': true,
  'net::ERR_EMPTY_RESPONSE': true,
  'net::ERR_TIMED_OUT': true,
  'net::ERR_FAILED': true,
  'net::ERR_NAME_NOT_RESOLVED': true,
  'net::ERR_INTERNET_DISCONNECTED': true,
};
const paths = {
  '/': true,
  '/favicon.ico': true,
  '/api/session/create': true,
  '/api/session/prompt': true,
  '/api/session/list': true,
  '/api/session/projections': true,
  '/api/remote.mux': true,
  '/assets/queued.js': true,
};
const methods = {
  GET: true,
  POST: true,
  HEAD: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  OPTIONS: true,
};
const collectors = new WeakMap();
function safePath(value) {
  if (typeof value !== 'string' || value.length > 8192) return '[unknown-path]';
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '[non-network-path]';
    if (Object.hasOwn(paths, url.pathname)) return url.pathname;
    if (/^\/assets\/[^/]+\.js$/.test(url.pathname)) return '[script-asset]';
    if (/^\/assets\/[^/]+\.css$/.test(url.pathname)) return '[style-asset]';
    return '[unclassified-path]';
  } catch {
    return '[unknown-path]';
  }
}

const failureFields = (event, params) => ({
  error:
    event === 'loadingFailed'
      ? Object.hasOwn(errors, params.errorText)
        ? params.errorText
        : '[unclassified-error]'
      : null,
  canceled:
    event === 'loadingFailed' && typeof params.canceled === 'boolean' ? params.canceled : null,
});

const requestFields = (params, previous, ordinal) => ({
  requestTag: previous && params.redirectResponse ? previous.requestTag : `request-${ordinal}`,
  hop: params.redirectResponse ? (Number.isInteger(previous?.hop) ? previous.hop + 1 : null) : 0,
  path: safePath(params.request?.url),
  method: Object.hasOwn(methods, params.request?.method) ? params.request.method : null,
  resourceType: Object.hasOwn(resourceTypes, params.type) ? params.type : null,
  status: null,
});

function projectRow(event, params, request, previous, relativeMs, observedMs) {
  const row = {
    event,
    ...(request ?? {
      requestTag: null,
      hop: null,
      path: '[unknown-path]',
      method: null,
      resourceType: Object.hasOwn(resourceTypes, params.type) ? params.type : null,
      status: event === 'responseReceived' ? status(params.response?.status) : null,
    }),
    relativeMs,
    observedMs,
    ...failureFields(event, params),
  };
  if (event === 'requestWillBeSent' && params.redirectResponse) {
    row.redirectFrom = {
      hop: previous?.hop ?? null,
      path: safePath(params.redirectResponse.url),
      status: status(params.redirectResponse.status),
    };
  }
  return row;
}
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const status = (value) => (Number.isInteger(value) && value >= 100 && value <= 599 ? value : null);

export function collectRequestEvidence(page) {
  if (collectors.has(page)) return collectors.get(page);
  const rows = [];
  const requests = new Map();
  const loss = {
    droppedRows: 0,
    correlationEvictions: 0,
    unmatchedEvents: 0,
    invalidEvents: 0,
    collectorFailures: 0,
  };
  let bytes = 0,
    sequence = 0,
    firstTimestamp = null,
    disposed = false;
  let endedMs = null;
  const started = performance.now();
  const context = (event, params, previous) => {
    let request = previous;
    if (event === 'requestWillBeSent') {
      if (!previous && requests.size >= REQUEST_EVIDENCE_LIMITS.requests) {
        requests.delete(requests.keys().next().value);
        loss.correlationEvictions++;
      }
      const ordinal = previous && params.redirectResponse ? sequence : ++sequence;
      request = requestFields(params, previous, ordinal);
      requests.set(params.requestId, request);
    }
    if (event === 'responseReceived' && request) {
      request.status = status(params.response?.status);
      request.resourceType = Object.hasOwn(resourceTypes, params.type)
        ? params.type
        : request.resourceType;
    }
    return request;
  };
  const record = (event, params) => {
    if (disposed) return;
    try {
      if (typeof params.requestId !== 'string' || params.requestId.length > 200) {
        loss.invalidEvents++;
        return;
      }
      const previous = requests.get(params.requestId);
      const request = context(event, params, previous);
      if (!request) loss.unmatchedEvents++;
      const timestamp = finite(params.timestamp);
      if (firstTimestamp === null && timestamp !== null) firstTimestamp = timestamp;
      const relativeMs =
        timestamp !== null && firstTimestamp !== null ? (timestamp - firstTimestamp) * 1000 : null;
      const row = projectRow(
        event,
        params,
        request,
        previous,
        relativeMs,
        performance.now() - started,
      );
      const size = Buffer.byteLength(JSON.stringify(row));
      if (
        rows.length >= REQUEST_EVIDENCE_LIMITS.rows ||
        bytes + size > REQUEST_EVIDENCE_LIMITS.bytes
      ) {
        loss.droppedRows++;
        return;
      }
      rows.push(row);
      bytes += size;
    } catch {
      loss.collectorFailures++;
    }
  };
  const unsubscribe = observeNetwork(
    page,
    Object.fromEntries(
      ['requestWillBeSent', 'responseReceived', 'loadingFinished', 'loadingFailed'].map((event) => [
        `Network.${event}`,
        (params) => record(event, params),
      ]),
    ),
  );
  const collector = {
    snapshot: () => ({
      version: 1,
      clock: 'relative-CDP-monotonic-ms+collector-performance-ms',
      endedMs,
      limits: REQUEST_EVIDENCE_LIMITS,
      rows: rows.slice(),
      loss: { ...loss },
      complete: Object.values(loss).every((count) => count === 0),
    }),
    dispose: () => {
      if (disposed) return;
      endedMs = performance.now() - started;
      disposed = true;
      unsubscribe();
      requests.clear();
    },
  };
  collectors.set(page, collector);
  return collector;
}

export async function retainRequestFailure(collector, screenshot) {
  if (!collector || !screenshot) return false;
  collector.dispose();
  try {
    await writeFile(
      screenshot.replace(/\.png$/, '') + '-network-failure.json',
      JSON.stringify(collector.snapshot(), null, 2),
      { mode: 0o600 },
    );
    return true;
  } catch {
    process.stderr.write(
      'browser failure evidence persistence failed; original failure retained\n',
    );
    return false;
  }
}

export const retainPageRequestFailure = (page, screenshot) =>
  retainRequestFailure(page && collectors.get(page), screenshot);

export function disposeRequestEvidence(page) {
  if (!page) return;
  collectors.get(page)?.dispose();
  collectors.delete(page);
}

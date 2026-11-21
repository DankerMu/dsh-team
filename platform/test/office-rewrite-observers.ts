/**
 * The in-page observers of the Office rewrite typing case (#652) and their reductions. Only event
 * names, booleans, counts and `Date.now()` times leave the page or the instance's log: never a
 * watch payload, a document key, a URL query or a log line. Each signal carries a positive control;
 * a failed control reports the signal unavailable, never as a zero count.
 */

const WATCH = '/sidebar/onlyoffice/watch';
// dsh-sidebar-onlyoffice@0.2.0's watch kinds: src/watch.ts and src/index.ts:442 (`save-error`).
const KINDS = ['change', 'removed', 'saved', 'save-error'] as const;
const STATE = 'onDocumentStateChange';
const REFRESH = 'onRequestRefreshFile';
/** At most this many transitions or times are kept; every one is still counted. */
const KEPT = 40;

// The plugin resolves `EventSource` when it constructs its watch stream (OnlyOfficeView.tsx:245),
// after this install: each later instance records its path, never its query, and each message
// only its allowlisted `kind`. `onmessage` stays the plugin's; the wrapper adds a listener.
export const WATCH_WRAPPER = `(() => {
  const record = (window.__dshTeamWatch = { instances: [], events: [] });
  const kinds = ${JSON.stringify(KINDS)};
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(url, init) {
      super(url, init);
      const instance = record.instances.push(new URL(String(url), location.href).pathname) - 1;
      this.addEventListener('message', (event) => {
        let kind = 'other';
        try {
          const parsed = JSON.parse(event.data);
          if (parsed !== null && kinds.includes(parsed.kind)) kind = parsed.kind;
        } catch {}
        record.events.push({ instance, kind, at: Date.now() });
      });
    }
  };
})()`;
export const WATCH_SEEN = 'window.__dshTeamWatch ?? null';

// Document Server 9.4 web-apps/apps/common/Gateway.js:174-178 posts each editor event to
// window.parent as a JSON string of `{ event, data, frameEditorId }` (a buffer post as the object);
// `setDocumentModified` (:294-299) and `requestRefreshFile` (:437-438) are the two kept here.
export const FRAME_LISTENER = `(() => {
  const record = (window.__dshTeamFrames = { messages: 0, parsed: 0, malformed: 0, events: [] });
  window.addEventListener('message', (event) => {
    record.messages++;
    let message = event.data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return; }
    }
    if (message === null || typeof message !== 'object' || typeof message.event !== 'string') return;
    record.parsed++;
    const at = Date.now();
    if (message.event === ${JSON.stringify(REFRESH)}) record.events.push({ event: message.event, at });
    if (message.event !== ${JSON.stringify(STATE)}) return;
    if (typeof message.data === 'boolean') record.events.push({ event: message.event, dirty: message.data, at });
    else record.malformed++;
  });
})()`;
export const FRAMES_SEEN = 'window.__dshTeamFrames ?? null';

export interface WatchRecord {
  readonly instances: readonly string[];
  readonly events: readonly { instance: number; kind: string; at: number }[];
}
export interface FrameRecord {
  readonly messages: number;
  readonly parsed: number;
  readonly malformed: number;
  readonly events: readonly { event: string; dirty?: boolean; at: number }[];
}

/** (c) The one watch stream's events by kind and its save errors' times; control: one stream, an event. */
type Signal<Control, Seen> =
  Readonly<{ available: false; control: Readonly<Control> }> | Readonly<{ available: true } & Seen>;
type WatchSignal = Signal<
  Record<'watchInstances' | 'events', number>,
  { kinds: Readonly<Record<string, number>>; saveErrors: readonly number[] }
>;
type FrameSignal = Signal<
  Record<'messages' | 'parsed' | 'malformed' | 'stateChanges', number>,
  {
    transitions: readonly (readonly [number, boolean])[];
    transitionCount: number;
    refreshRequests: Readonly<Record<'total' | 'afterSave', number>>;
  }
>;

export function watchSignal(record: WatchRecord | null, origin: number): WatchSignal {
  const watched = (record?.instances ?? []).flatMap((path, index) =>
    path === WATCH ? [index] : [],
  );
  const events = (record?.events ?? []).filter(({ instance }) => watched.includes(instance));
  if (watched.length !== 1 || events.length === 0)
    return { available: false, control: { watchInstances: watched.length, events: events.length } };
  const kinds = Object.fromEntries(
    [...KINDS, 'other'].map((kind) => [kind, events.filter((event) => event.kind === kind).length]),
  );
  const saveErrors = events
    .filter(({ kind }) => kind === 'save-error')
    .map(({ at }) => at - origin);
  return { available: true, kinds, saveErrors: saveErrors.slice(0, KEPT) };
}

const states = (record: FrameRecord) => record.events.filter(({ event }) => event === STATE);
const controlled = (record: FrameRecord, origin: number) =>
  states(record).some(({ dirty, at }) => dirty === true && at >= origin);

/** (a)(b) Dirty transitions from `origin` and refresh requests; control: dirty true after it. */
export function frameSignal(
  record: FrameRecord | null,
  origin: number,
  savedAt: number,
): FrameSignal {
  if (record === null || !controlled(record, origin)) {
    const control = {
      ...{ messages: record?.messages ?? 0, parsed: record?.parsed ?? 0 },
      ...{ malformed: record?.malformed ?? 0, stateChanges: record ? states(record).length : 0 },
    };
    return { available: false, control };
  }
  const transitions: [number, boolean][] = [];
  for (const { dirty, at } of states(record).filter((event) => event.at >= origin))
    if (transitions.at(-1)?.[1] !== dirty) transitions.push([at - origin, dirty === true]);
  const refreshes = record.events.filter(({ event }) => event === REFRESH);
  return {
    available: true,
    transitions: transitions.slice(0, KEPT),
    transitionCount: transitions.length,
    refreshRequests: {
      total: refreshes.length,
      afterSave: refreshes.filter(({ at }) => at >= savedAt).length,
    },
  };
}

/** Node's times of the case; `origin` is just before the first keystroke. */
export interface WindowMarks {
  readonly origin: number;
  readonly execStart: number;
  readonly execEnd: number;
  readonly lastKey: number;
}
/** The stale banner's first sighting and its first absence after it, as the notice latch keeps. */
export interface NoticeTimes {
  readonly shown: number | null;
  readonly cleared: number | null;
}

/** (a) The window from `origin`: the exec, the last keystroke, the stale banner, dirty false. */
export function windowFacts(marks: WindowMarks, stale: NoticeTimes, frames: FrameRecord | null) {
  const { origin } = marks;
  const since = (at: number | null) => (at === null ? null : at - origin);
  const falseAfter =
    frames !== null && controlled(frames, origin)
      ? since(
          states(frames).find(({ dirty, at }) => dirty === false && at >= marks.lastKey)?.at ??
            null,
        )
      : 'unavailable';
  return {
    execStart: marks.execStart - origin,
    execEnd: marks.execEnd - origin,
    lastKey: marks.lastKey - origin,
    staleLatched: since(stale.shown),
    staleCleared: since(stale.cleared),
    dirtyFalse: falseAfter,
  };
}

// dsh-sidebar-onlyoffice@0.2.0 src/index.ts:426 and :437: `onlyoffice save (key <K>): <reason>`.
const SAVE_LINE = 'onlyoffice save (key ';
const REFUSED = 'refusing save';
type SaveLines = Readonly<{ count: number; refused: number; at: readonly (number | null)[] }>;

/**
 * `docker logs --timestamps` output reduced to the plugin's save lines: their count, the refused
 * ones and each RFC 3339 time from `origin`; `undefined` when the read failed. No text is kept.
 */
export function saveLines(logs: string | undefined, origin: number): SaveLines | undefined {
  if (logs === undefined) return undefined;
  const lines = logs.split('\n').filter((line) => line.includes(SAVE_LINE));
  const at = lines.map((line) => {
    const time = Date.parse(line.slice(0, line.indexOf(' ')));
    return Number.isNaN(time) ? null : time - origin;
  });
  const refused = lines.filter((line) => line.includes(REFUSED)).length;
  return { count: lines.length, refused, at: at.slice(0, KEPT) };
}

/**
 * (c) The host's save lines before and after the close. Control: the earlier `unsaved` case's
 * refused save, whose page notice that case asserts, left at least one line in the same log.
 */
export function hostSignal(
  control: SaveLines | undefined,
  beforeClose: SaveLines | undefined,
  afterClose: SaveLines | undefined,
) {
  if (control === undefined) return { available: false, reason: 'read failed' } as const;
  if (control.count === 0) return { available: false, reason: 'no earlier line' } as const;
  return {
    available: true,
    control: control.count,
    beforeClose: beforeClose ?? 'read failed',
    afterClose: afterClose ?? 'read failed',
  } as const;
}

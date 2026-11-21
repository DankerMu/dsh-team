import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  FRAME_LISTENER,
  FRAMES_SEEN,
  frameSignal,
  hostSignal,
  saveLines,
  WATCH_SEEN,
  WATCH_WRAPPER,
  watchSignal,
  windowFacts,
} from './office-rewrite-observers.ts';
import type { FrameRecord, WatchRecord } from './office-rewrite-observers.ts';

const KEY = 'K1secretDocumentKey0123456789';
const WATCH = '/sidebar/onlyoffice/watch';

/** A page stand-in: a native EventSource whose instances dispatch `message`, and a window bus. */
function page() {
  const sources: { url: string; emit: (data: string) => void }[] = [];
  const windowListeners: ((event: { data: unknown }) => void)[] = [];
  class NativeEventSource {
    readonly listeners: ((event: { data: string }) => void)[] = [];
    constructor(url: string) {
      sources.push({
        url,
        emit: (data) => {
          for (const listener of this.listeners) listener({ data });
        },
      });
    }
    addEventListener(_type: string, listener: (event: { data: string }) => void) {
      this.listeners.push(listener);
    }
  }
  const window: Record<string, unknown> = {
    EventSource: NativeEventSource,
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
      windowListeners.push(listener),
  };
  const context = { window, location: { href: 'http://127.0.0.1:1/' }, URL, Date };
  const run = (script: string): unknown => runInNewContext(script, context);
  const post = (data: unknown) => {
    for (const listener of windowListeners) listener({ data });
  };
  return { window, sources, run, post };
}

it('records only the watch stream kind and a time, off an EventSource made after the install', () => {
  const { window, sources, run } = page();
  run(WATCH_WRAPPER);

  // The construction the plugin makes once the editor mounts, then an unrelated stream.
  const Wrapped = window.EventSource as new (url: string) => unknown;
  new Wrapped(`${WATCH}?sessionId=s&path=/data/work/x.docx`);
  new Wrapped('/plugins/events');
  const [watch, other] = sources;
  watch?.emit(JSON.stringify({ kind: 'change', key: KEY }));
  watch?.emit(JSON.stringify({ kind: 'save-error', message: `refusing save for key "${KEY}"` }));
  watch?.emit(JSON.stringify({ kind: 'surprise', message: KEY }));
  watch?.emit('not json');
  other?.emit(JSON.stringify({ kind: 'saved' }));
  const seen = run(WATCH_SEEN) as WatchRecord;

  expect(seen.instances).toEqual([WATCH, '/plugins/events']);
  expect(seen.events.map(({ instance, kind }) => [instance, kind])).toEqual([
    [0, 'change'],
    [0, 'save-error'],
    [0, 'other'],
    [0, 'other'],
    [1, 'saved'],
  ]);
  expect(seen.events.every(({ at }) => typeof at === 'number')).toBe(true);
  expect(JSON.stringify(seen)).not.toContain(KEY);
  expect(JSON.stringify(seen)).not.toContain('sessionId');
});

it("records the editor frame's two events by name and boolean, counting every message", () => {
  const { run, post } = page();
  run(FRAME_LISTENER);
  const frame = (msg: object) => JSON.stringify({ ...msg, frameEditorId: 'placeholder' });

  // Document Server Gateway.js posts a JSON string to window.parent; a buffer post is an object.
  post(frame({ event: 'onDocumentStateChange', data: true }));
  post(frame({ event: 'onDocumentStateChange', data: false }));
  post(frame({ event: 'onRequestRefreshFile' }));
  post({ event: 'onDocumentStateChange', data: true });
  post(frame({ event: 'onDocumentStateChange', data: 'yes' }));
  post(frame({ event: 'onError', data: { message: KEY } }));
  post('not json');
  const seen = run(FRAMES_SEEN) as FrameRecord;

  expect([seen.messages, seen.parsed, seen.malformed]).toEqual([7, 6, 1]);
  expect(seen.events.map(({ event, dirty }) => [event, dirty])).toEqual([
    ['onDocumentStateChange', true],
    ['onDocumentStateChange', false],
    ['onRequestRefreshFile', undefined],
    ['onDocumentStateChange', true],
  ]);
  expect(JSON.stringify(seen)).not.toContain(KEY);
});

const ORIGIN = 1_000_000;
const watchRecord = (instances: string[], events: [number, string, number][]): WatchRecord => ({
  instances,
  events: events.map(([instance, kind, at]) => ({ instance, kind, at })),
});

it('counts the one watch stream per kind and times its save errors from the origin', () => {
  const record = watchRecord(
    [WATCH, '/plugins/events'],
    [
      [0, 'change', ORIGIN + 900],
      [1, 'save-error', ORIGIN + 950],
      [0, 'save-error', ORIGIN + 30_000],
      [0, 'save-error', ORIGIN + 31_000],
      [0, 'other', ORIGIN + 32_000],
    ],
  );

  expect(watchSignal(record, ORIGIN)).toEqual({
    available: true,
    kinds: { change: 1, removed: 0, saved: 0, 'save-error': 2, other: 1 },
    saveErrors: [30_000, 31_000],
  });
});

it.each([
  ['no wrapper installed', null, { watchInstances: 0, events: 0 }],
  [
    'no watch stream',
    watchRecord(['/plugins/events'], [[0, 'saved', 1]]),
    { watchInstances: 0, events: 0 },
  ],
  [
    'two watch streams',
    watchRecord([WATCH, WATCH], [[0, 'change', 1]]),
    { watchInstances: 2, events: 1 },
  ],
  ['a silent watch stream', watchRecord([WATCH], []), { watchInstances: 1, events: 0 }],
])(
  'reports the watch signal unavailable, never a zero count, with %s',
  (_case, record, control) => {
    expect(watchSignal(record, ORIGIN)).toEqual({ available: false, control });
  },
);

const frames = (events: FrameRecord['events'], messages = events.length): FrameRecord => ({
  messages,
  parsed: messages,
  malformed: 0,
  events,
});
const state = (at: number, dirty: boolean) => ({
  event: 'onDocumentStateChange',
  dirty,
  at: ORIGIN + at,
});
const refresh = (at: number) => ({ event: 'onRequestRefreshFile', at: ORIGIN + at });

it('keeps the dirty transitions from the origin and counts refresh requests, all and after the save', () => {
  const record = frames([
    state(-500, false),
    state(100, true),
    state(200, true),
    state(9_000, false),
    refresh(9_500),
    state(40_000, true),
    refresh(45_000),
  ]);

  expect(frameSignal(record, ORIGIN, ORIGIN + 40_000)).toEqual({
    available: true,
    transitions: [
      [100, true],
      [9_000, false],
      [40_000, true],
    ],
    transitionCount: 3,
    refreshRequests: { total: 2, afterSave: 1 },
  });
});

it('caps the kept dirty transitions at 40 and still counts them all', () => {
  const record = frames(Array.from({ length: 50 }, (_, index) => state(index, index % 2 === 0)));

  const signal = frameSignal(record, ORIGIN, ORIGIN);

  expect(signal.available && [signal.transitions.length, signal.transitionCount]).toEqual([40, 50]);
});

it.each([
  ['no listener installed', null, { messages: 0, parsed: 0, malformed: 0, stateChanges: 0 }],
  [
    'no dirty true after the origin',
    frames([state(-10, true), state(5, false)], 9),
    { messages: 9, parsed: 9, malformed: 0, stateChanges: 2 },
  ],
])('reports the frame signal unavailable with %s', (_case, record, control) => {
  expect(frameSignal(record, ORIGIN, ORIGIN)).toEqual({ available: false, control });
});

const MARKS = {
  origin: ORIGIN,
  execStart: ORIGIN + 400,
  execEnd: ORIGIN + 2_400,
  lastKey: ORIGIN + 3_000,
};

it('times the window from the origin: keystrokes, the exec, the stale banner and dirty false', () => {
  const stale = { shown: ORIGIN + 2_900, cleared: ORIGIN + 4_000 };
  const record = frames([state(100, true), state(2_000, false), state(3_900, false)]);

  expect(windowFacts(MARKS, stale, record)).toEqual({
    execStart: 400,
    execEnd: 2_400,
    lastKey: 3_000,
    staleLatched: 2_900,
    staleCleared: 4_000,
    dirtyFalse: 3_900,
  });
});

it('leaves an unseen stale banner and dirty false null, and dirty false unavailable without its control', () => {
  const unseen = { shown: null, cleared: null };

  const seen = windowFacts(MARKS, unseen, frames([state(100, true)]));
  const uncontrolled = windowFacts(MARKS, unseen, null);

  expect([seen.staleLatched, seen.staleCleared, seen.dirtyFalse]).toEqual([null, null, null]);
  expect(uncontrolled.dirtyFalse).toBe('unavailable');
});

const line = (at: string, text: string) => `${at} ${text}`;
const LOGS = [
  line(
    '1970-01-01T00:16:40.500000000Z',
    `[E] onlyoffice save (key ${KEY}): onlyoffice: refusing save`,
  ),
  line('1970-01-01T00:16:41.000000000Z', 'dsh web: listening'),
  line(
    '1970-01-01T00:16:45.250000000Z',
    `[W] onlyoffice save (key ${KEY}): url not under the public base`,
  ),
  line('not-a-time', `onlyoffice save (key ${KEY}): refusing save`),
  '',
].join('\n');

it("reduces the instance's log to the plugin's save lines: counts and times, no line text", () => {
  const reduced = saveLines(LOGS, ORIGIN);

  expect(reduced).toEqual({ count: 3, refused: 2, at: [500, 5_250, null] });
  expect(JSON.stringify(reduced)).not.toContain(KEY);
  expect(saveLines(undefined, ORIGIN)).toBeUndefined();
});

it('reports the host signal only once the earlier refusal reached the log', () => {
  const control = { count: 2, refused: 2, at: [1, 2] };
  const closed = { count: 1, refused: 1, at: [3] };
  const none = { count: 0, refused: 0, at: [] };

  expect(hostSignal(control, none, closed)).toEqual({
    available: true,
    control: 2,
    beforeClose: none,
    afterClose: closed,
  });
  expect(hostSignal(control, undefined, closed)).toMatchObject({ beforeClose: 'read failed' });
  expect(hostSignal(none, none, none)).toEqual({ available: false, reason: 'no earlier line' });
  expect(hostSignal(undefined, none, none)).toEqual({ available: false, reason: 'read failed' });
});

import {
  NOTICE_LATCH,
  NOTICE_TIMES,
  NOTICES,
  NOTICES_SEEN,
  NOTICES_SHOWN,
} from './office-rewrite-stack-fixture.ts';
import { FRAMES_SEEN } from './office-rewrite-observers.ts';
import type { FrameRecord, NoticeTimes } from './office-rewrite-observers.ts';

// The seam's stand-in session timeout and window, and heldWithin's poll. Each scripted instant is a
// timer set no later than the seam's own delay it must precede or outlast, those the wait must see
// at most 450ms in, far inside TIMEOUT, so timer order, not load, decides each case. A past-bound
// act fires from the first read at which the stand-in's clock, never ahead of the seam's, passed
// TIMEOUT: the wait's last poll. TIMEOUT sits 100ms short of a poll, so no poll falls on the bound.
export const TIMEOUT = 1_900;
export const WINDOW_MS = 100;
export const POLL_MS = 250;
export type NoticeId = keyof typeof NOTICES;
export const flagsOf = (ids: ReadonlySet<string>) =>
  Object.fromEntries(Object.keys(NOTICES).map((id) => [id, ids.has(id)]));
const unshown = (): Record<string, NoticeTimes> =>
  Object.fromEntries(Object.keys(NOTICES).map((id) => [id, { shown: null, cleared: null }]));

/**
 * A page after the Agent turn: `show` and `hide` set what is on screen, `refresh` counts a config
 * fetch, `frames` sets what the frame listener recorded. NOTICE_LATCH restarts the latch with what
 * shows at install, its times included, as the real one's first check does, then runs the install
 * hooks; NOTICES_SEEN answers what showed since, NOTICES_SHOWN what shows now, NOTICE_TIMES each
 * notice's first sighting and first absence after it since, FRAMES_SEEN the frames set.
 */
export function standIn() {
  const showing = new Set<string>();
  let seen = new Set<string>();
  let times = unshown();
  let frames: FrameRecord | null = null;
  const installed: (() => unknown)[] = [];
  const pastBound: (() => unknown)[] = [];
  let configs = 1;
  // Started by the seam's first read, after its own clock: never ahead of the seam's elapsed time.
  let clock: number | undefined;
  const touched = () => {
    clock ??= performance.now();
    if (performance.now() - clock < TIMEOUT) return;
    // A read this late is the wait's last poll; the act lands before the seam's next timer.
    for (const act of pastBound.splice(0)) setTimeout(act, 0);
  };
  const fetched = {
    get config() {
      touched();
      return configs;
    },
  };
  const answer = (expression: string): unknown => {
    touched();
    if (expression === NOTICES_SEEN) return flagsOf(seen);
    if (expression === NOTICES_SHOWN) return flagsOf(showing);
    if (expression === NOTICE_TIMES) return { ...times };
    if (expression === FRAMES_SEEN) return frames;
    if (expression !== NOTICE_LATCH) throw new Error('unscripted page expression');
    seen = new Set(showing);
    times = unshown();
    for (const id of showing) times[id] = { shown: Date.now(), cleared: null };
    for (const hook of installed) hook();
    return undefined;
  };
  const page = {
    // The stand-in answers only these expressions, each with the shape the seam reads.
    evaluate: <R>(expression: string) => Promise.resolve().then(() => answer(expression) as R),
  };
  const show = (id: NoticeId) => {
    showing.add(id);
    const { shown, cleared } = times[id] ?? { shown: null, cleared: null };
    times[id] = { shown: shown ?? Date.now(), cleared };
    return seen.add(id);
  };
  const hide = (id: NoticeId) => {
    const { shown, cleared } = times[id] ?? { shown: null, cleared: null };
    if (shown !== null) times[id] = { shown, cleared: cleared ?? Date.now() };
    return showing.delete(id);
  };
  return {
    ...{ page, fetched, show, hide, refresh: () => configs++ },
    frames: (record: FrameRecord) => {
      frames = record;
    },
    onInstall: (hook: () => unknown) => installed.push(hook),
    /** `act` once the positive wait's bound passed, inside the negative window. */
    onPastBound: (act: () => unknown) => pastBound.push(act),
  };
}
export type StandIn = ReturnType<typeof standIn>;

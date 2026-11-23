import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
import {
  clearingForgottenOnError,
  forgottenRecord,
  OBSERVE_MS,
  registeredKey,
  settleForgotten,
} from './document-server-forgotten-fixture.ts';
import type { ForgottenKey } from './document-server-forgotten-fixture.ts';
import type { NamespaceRead } from './document-server-net-fixture.ts';
import {
  counted,
  digest,
  editorErrorsAllowed,
  editorNonce,
  editorRefused,
  holds,
  readWork,
  singleQuoted,
  typeAndSave,
} from './office-editor-stack-fixture.ts';
import type { Digest } from './office-editor-stack-fixture.ts';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  docxCommand,
  documentServerReady,
  openHinted,
  untilSeen,
} from './office-hints-stack-fixture.ts';
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
import type { FrameRecord, NoticeTimes, WatchRecord } from './office-rewrite-observers.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, scrubEach, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const PARAGRAPH = '改写探针：开头只有这一段。';
/** §60's cases in order: the second types a nonce, unsaved, before the Agent rewrites the file. */
const CASES = [
  { id: 'clean', name: '干净改写.docx', typeFirst: false },
  { id: 'unsaved', name: '未保存改写.docx', typeFirst: true },
] as const;
type CaseId = (typeof CASES)[number]['id'];
/** #652: the rewrite lands while A is still typing, before the typing reached the Document Server. */
const TYPING = { id: 'typing', name: '键入改写.docx' } as const;
/** Letters only: no space or punctuation for autocorrect to act on, nothing NONCE_PATTERN matches. */
const FILLER = 'w';
// Every notice dsh-sidebar-onlyoffice@0.2.0 shows above the editor, zh: src/client/locales.ts:25
// `staleChanged`, :27 `staleRemoved`, :28 `saveFailed`.
export const NOTICES = {
  staleChanged: '文件已被外部修改（可能是 AI）——重新加载将丢弃未保存的修改',
  staleRemoved: '文件已从磁盘删除',
  saveFailed: '保存未写回文件（文档服务会重试；请勿只关闭标签页，必要时用“下载文件”备份）',
};
const CONFIG = '/sidebar/onlyoffice/config';
// Each case waits up to a session timeout for its positives after the Agent turn, then spends three
// OBSERVE_MS windows (the negative window, the quiet window after the save's clear, and after the
// editor closes, which settles the forgotten store): 90s for both cases on top of their sessions.
/** One Agent turn: its rewrite's call and hit, and the bash, tool-result and title requests. */
const TURN = { rewriteCalls: 1, rewriteHits: 1, requests: 3 };
const SESSION_LISTS = ['pageErrors', 'failedRequests', 'externalRequests'] as const;
const NO_ENTRIES = { added: [], removed: [] };
const QUIET = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };
const UNSEEN = { before: false, window: false, atSave: false, saved: false, quiet: false };
// #650's source prediction: a session closed with its save refused leaves one forgotten copy under
// its key, listed; one closed without a change leaves none; the lane removes either.
const NO_COPY = { copies: 0, listed: false, cleared: true };
const COPY = { copies: 1, listed: true, cleared: true };
/**
 * §60's measurement (step 1, review round 1). Clean: no notice above the editor from before the
 * Agent turn until the save landed. Unsaved: the refreshed-away session's status 2 with the
 * discarded edit is refused, so 「保存未写回文件」 shows within the window and until the save
 * landed. Both: no notice shown once the save landed; one config refetch, the plugin's refreshFile;
 * the file the Agent's after the rewrite and both sides' after the save and the close; the unsaved
 * case's typed nonce gone from every read; no new or missing work entry; 18.5's allowed errors.
 * #657 A's predictions, for the exact-head stack to confirm: the unsaved case's 「保存未写回文件」
 * still shown at the instant before the save, and in both cases no notice and no refetch in the
 * quiet window after the save's clear.
 */
const CLEAN = {
  notices: { staleChanged: UNSEEN, staleRemoved: UNSEEN, saveFailed: UNSEEN },
  cleared: true,
  config: { open: 1, window: 2, saved: 2 },
  states: ['agent-only', 'both', 'both'],
  typed: [false, false, false],
  entries: { saved: NO_ENTRIES, closed: NO_ENTRIES },
  allowed: true,
  sessions: [QUIET, QUIET],
  forgotten: NO_COPY,
};
const REFUSED = { before: false, window: true, atSave: true, saved: true, quiet: false };
export const EXPECTED_REWRITE = {
  clean: CLEAN,
  unsaved: { ...CLEAN, notices: { ...CLEAN.notices, saveFailed: REFUSED }, forgotten: COPY },
};
const NONE_SHOWN = { staleChanged: false, staleRemoved: false, saveFailed: false };
const SAVE_FAILED = { ...NONE_SHOWN, saveFailed: true };
/**
 * #652's measurement with the patched lib/client.js (two runs on 6f43c7e). The stale banner latched
 * in the window; at dirty false the editor refreshed once (config 1, 2, 2, 2), clearing it, and the
 * refreshed-away session's status 2 was refused: 「保存未写回文件」 at the window's end. The next
 * save landed (one `saved`), and no notice showed after it; one `change`, one `save-error`, no
 * refresh request; the file the Agent's after the rewrite and both sides' after the save and the
 * close, the in-window typing in no read; no new or missing work entry; 18.5's allowed errors.
 */
export const EXPECTED_TYPING = {
  notices: { before: NONE_SHOWN, window: SAVE_FAILED, saved: NONE_SHOWN, end: NONE_SHOWN },
  latched: { window: { ...SAVE_FAILED, staleChanged: true } },
  cleared: true,
  config: { open: 1, window: 2, saved: 2, end: 2 },
  dirty: { available: true, cleanThenCleared: true, refreshRequests: 0 },
  watch: { available: true, kinds: { change: 1, removed: 0, saved: 1, 'save-error': 1, other: 0 } },
  states: ['agent-only', 'both', 'both'],
  typed: [false, false, false],
  entries: { saved: NO_ENTRIES, closed: NO_ENTRIES },
  allowed: true,
  forgotten: COPY,
};

// python-docx from the user image; the file and the nonce arrive as argv. No single quote (below).
export const REWRITER = `import sys
from docx import Document
path, nonce = sys.argv[1:]
document = Document(path)
document.add_paragraph(nonce)
document.save(path)
print(nonce)`;
/** The rewrite of `name` in the work directory as argv. */
export const rewriteArgv = (name: string, nonce: string) => [
  ...['python3', '-c', REWRITER],
  ...[`${WORK}/${name}`, nonce],
];
/** The Agent's bash rewrite of `name` in the work directory, each word single-quoted. */
export const rewriteCommand = (name: string, nonce: string) =>
  singleQuoted(rewriteArgv(name, nonce));

/** The provider's rewrite scripts, one per case in order; every value is a nonsecret nonce. */
export const ownedRewrites = () =>
  CASES.map(({ name }) => {
    const nonce = editorNonce();
    return { marker: `stack-rewrite-${randomUUID()}`, command: rewriteCommand(name, nonce), nonce };
  });

type OfficeRead = Awaited<ReturnType<typeof readWork>>;

/** Whether a part's text holds `nonce` once `other` is removed: a click can type it inside. */
export const heldApart = (texts: OfficeRead['texts'], nonce: string, other: string) =>
  holds(
    Object.fromEntries(
      Object.entries(texts).map(([part, text]) => [part, text.replaceAll(other, '')]),
    ),
    nonce,
  );

/**
 * Whose nonce a part's text holds: the Agent's, the employee's last saved one, both or neither. The
 * employee's nonce is removed before the Agent's is sought: a click into the refreshed document can
 * type it inside the Agent's paragraph (§60 step 1).
 */
export function rewriteState(
  texts: OfficeRead['texts'],
  agentNonce: string,
  employeeNonce: string,
) {
  const agent = heldApart(texts, agentNonce, employeeNonce);
  if (holds(texts, employeeNonce)) return agent ? 'both' : 'employee-only';
  return agent ? 'agent-only' : 'neither';
}

type Observed = Digest & { readonly state: ReturnType<typeof rewriteState>; typed?: boolean };
/** The open key's forgotten copy once the editor closed: counts and booleans, never the key. */
type ForgottenRecord = Awaited<ReturnType<typeof forgottenRecord>>;
type EntryDiff = Readonly<Record<'added' | 'removed', readonly string[]>>;
/** Every case's file and editing session: no nonce, marker or key. */
interface EditedEvidence {
  readonly file: string;
  readonly reads: Readonly<Record<'rewritten' | 'saved' | 'closed', Observed>>;
  /** `/data/work` against its listing before the rewrite. */
  readonly entries: Readonly<Record<'saved' | 'closed', EntryDiff>>;
  /** `status path` of every failed response. */
  readonly responses: readonly string[];
  /** The editing session's errors are 18.5's allowed ones (`editorErrorsAllowed`). */
  readonly allowed: boolean;
  readonly editor: StackBrowserEvidence;
  readonly forgotten: ForgottenRecord;
}
/** States, digests, entry names, `status path` lines and sessions. */
interface RewriteCaseEvidence extends EditedEvidence {
  readonly provider: Readonly<Record<string, number>>;
  /** Each notice: shown before the Agent turn, latched from then to the window's end, shown at the
   * instant before the save, latched until the save landed, latched in the quiet window after the
   * save's clear. */
  readonly notices: Readonly<Record<string, Readonly<Record<NoticeFlag, boolean>>>>;
  /** No notice shown within a session timeout once the save landed. */
  readonly cleared: boolean;
  /** The page's config fetches so far: before the Agent turn, after the window, at the end of the
   * quiet window after the save. */
  readonly config: Readonly<Record<'open' | 'window' | 'saved', number>>;
  /** Ms from the Agent turn's `rewritten` read until each awaited positive held; null when it did not
   * within a session timeout, or was not awaited. Recorded, not fixed. */
  readonly arrived: Readonly<Record<'config' | 'saveFailed', number | null>>;
  readonly agent: StackBrowserEvidence;
}
type NoticePoints<K extends string> = Readonly<Record<K, NoticeFlags>>;
/** #652's record: names, booleans, counts and times only; times in ms from the first keystroke. */
interface TypingEvidence extends EditedEvidence {
  /** The provider's counters, the same before and after the case: no Agent turn. */
  readonly provider: Readonly<Record<string, unknown>>;
  /** (a) The exec, the last keystroke, the stale banner and dirty false. */
  readonly window: ReturnType<typeof windowFacts>;
  /** Each notice shown before typing, at the window's end, after the save poll, at the end. */
  readonly notices: NoticePoints<'before' | 'window' | 'saved' | 'end'>;
  /** Each notice latched from before typing until the window's end and until the end. */
  readonly latched: NoticePoints<'window' | 'end'>;
  /** No notice shown within a session timeout after the save poll. */
  readonly cleared: boolean;
  readonly config: Readonly<Record<'open' | 'window' | 'saved' | 'end', number>>;
  /** (a)(b) The dirty transitions and refresh requests. */
  readonly dirty: ReturnType<typeof frameSignal>;
  /** (c) The page's watch events while the editor is open. */
  readonly watch: ReturnType<typeof watchSignal>;
  /** (c) The instance's save log lines before and after the close. */
  readonly host: ReturnType<typeof hostSignal>;
}
type OfficeRewriteEvidence = Readonly<Record<CaseId, RewriteCaseEvidence>> & {
  readonly typing: TypingEvidence;
};

const READS = ['rewritten', 'saved', 'closed'] as const;
const readFacts = (reads: EditedEvidence['reads']) => ({
  states: READS.map((at) => reads[at].state),
  typed: READS.map((at) => reads[at].typed ?? false),
});
/** What EXPECTED_REWRITE fixes of one case; `typed` is false where nothing was typed first. */
export function rewriteFacts(evidence: RewriteCaseEvidence) {
  const { notices, cleared, config, reads, entries, allowed, editor, agent, forgotten } = evidence;
  const sessions = [editor, agent].map((browser) =>
    Object.fromEntries(SESSION_LISTS.map((key) => [key, browser[key].length])),
  );
  return { notices, cleared, config, ...readFacts(reads), entries, allowed, sessions, forgotten };
}

type Transitions = Extract<TypingEvidence['dirty'], { available: true }>['transitions'];
type StaleSpan = Pick<TypingEvidence['window'], 'staleLatched' | 'staleCleared'>;
/** Whether a dirty true→false falls within the stale banner's span: the patched refresh clears it. */
const cleanThenCleared = ({ staleLatched, staleCleared }: StaleSpan, transitions: Transitions) =>
  staleLatched !== null &&
  staleCleared !== null &&
  transitions.some(
    ([at, dirty], index) =>
      !dirty && transitions[index - 1]?.[1] === true && staleLatched <= at && at <= staleCleared,
  );

/** What a typing case's evidence must have: the timing-variable fields only by their order. */
type TypingFactsInput = Pick<
  TypingEvidence,
  'notices' | 'latched' | 'cleared' | 'config' | 'dirty' | 'watch' | 'reads' | 'entries'
> &
  Pick<TypingEvidence, 'allowed' | 'forgotten'> & { readonly window: StaleSpan };

/** What EXPECTED_TYPING fixes of the typing case; times, the host log and digests stay evidence. */
export function typingFacts(evidence: TypingFactsInput) {
  const { notices, latched, cleared, config, dirty, watch, reads, entries, allowed, forgotten } =
    evidence;
  return {
    ...{ notices, latched: { window: latched.window }, cleared, config },
    dirty: dirty.available
      ? {
          available: true,
          cleanThenCleared: cleanThenCleared(evidence.window, dirty.transitions),
          refreshRequests: dirty.refreshRequests.total,
        }
      : { available: false },
    watch: watch.available ? { available: true, kinds: watch.kinds } : { available: false },
    ...{ ...readFacts(reads), entries, allowed, forgotten },
  };
}

const editorLine = (editor: StackBrowserEvidence) => ({
  ...counted(editor),
  ...{ errors: scrubEach(editor.consoleErrors), failed: scrubEach(editor.failedRequests) },
});
const caseLine = ({ editor, agent, responses, ...rest }: RewriteCaseEvidence) => ({
  ...{ ...rest, responses: scrubEach(responses) },
  ...{ editor: editorLine(editor), agent: counted(agent) },
});
const typingLine = ({ editor, responses, ...rest }: TypingEvidence) => ({
  ...{ ...rest, responses: scrubEach(responses) },
  editor: editorLine(editor),
});

/** The stack evidence line: sessions counted, the editor's errors and failures scrubbed. */
export function officeRewriteLine(evidence: OfficeRewriteEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office rewrite evidence missing');
  const { clean, unsaved, typing } = evidence;
  return { clean: caseLine(clean), unsaved: caseLine(unsaved), typing: typingLine(typing) };
}

/** A's lane plus the host's Docker, the Document Server namespace position, A's instance, the
 * provider's reply and its rewrite scripts. */
type OfficeRewriteLane = ArchiveLane & {
  readonly run: DockerOutput;
  readonly namespaceRead: NamespaceRead;
  readonly instance: string;
  readonly reply: string;
  readonly rewrites: readonly Readonly<Record<'marker' | 'command' | 'nonce', string>>[];
};

const LIST = `import json, os, sys
print(json.dumps(sorted(os.listdir(sys.argv[1]))))`;
const listing = async ({ exec }: ArchiveLane) =>
  JSON.parse(await exec(['python3', '-c', LIST, WORK])) as string[];
const entryDiff = (before: readonly string[], after: readonly string[]): EntryDiff => ({
  added: after.filter((name) => !before.includes(name)),
  removed: before.filter((name) => !after.includes(name)),
});

// Latches each notice's rendered text sighted in the page, outside the editor iframe, as STOP_LATCH
// does, with its first sighting's and first later absence's Date.now(); innerText, as officeFacts
// reads it, leaves script and style text out. A second install starts the latch afresh.
export const NOTICE_LATCH = `(() => {
  const notices = ${JSON.stringify(NOTICES)};
  window.__dshTeamNotices = Object.fromEntries(Object.keys(notices).map((id) => [id, false]));
  window.__dshTeamNoticeTimes = Object.fromEntries(Object.keys(notices).map((id) => [id, { shown: null, cleared: null }]));
  const check = () => {
    const text = document.body.innerText;
    for (const [id, notice] of Object.entries(notices)) {
      const times = window.__dshTeamNoticeTimes[id];
      if (text.includes(notice)) {
        window.__dshTeamNotices[id] = true;
        times.shown ??= Date.now();
      } else if (times.shown !== null) times.cleared ??= Date.now();
    }
  };
  check();
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
})()`;
export const NOTICES_SEEN = '({ ...window.__dshTeamNotices })';
const NOTICE_TIMES = '({ ...window.__dshTeamNoticeTimes })';
const STALE_LATCHED = 'window.__dshTeamNotices.staleChanged === true';
export const NOTICES_SHOWN = `Object.fromEntries(Object.entries(${JSON.stringify(NOTICES)}).map(([id, notice]) => [id, document.body.innerText.includes(notice)]))`;
type NoticeFlags = Readonly<Record<string, boolean>>;
type NoticeFlag = 'before' | 'window' | 'atSave' | 'saved' | 'quiet';
/** Each notice's five flags; a flag the page did not report counts as seen, so it fails. */
const noticeFlags = (
  before: NoticeFlags,
  window: NoticeFlags,
  atSave: NoticeFlags,
  saved: NoticeFlags,
  quiet: NoticeFlags,
) =>
  Object.fromEntries(
    Object.keys(NOTICES).map((id) => [
      id,
      {
        ...{ before: before[id] !== false, window: window[id] !== false },
        ...{ atSave: atSave[id] !== false, saved: saved[id] !== false, quiet: quiet[id] !== false },
      },
    ]),
  );

/** Whether `check` held, polled every 250ms for at most `timeout`; the caller asserts it. */
async function heldWithin(check: () => Promise<boolean>, timeout: number) {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start >= timeout) return false;
    await delay(250);
  }
  return true;
}

/** Reads until the file holds `nonce` or `timeout` passed; the caller asserts the last read. */
async function readUntil(read: () => Promise<OfficeRead>, nonce: string, timeout: number) {
  let last = await read();
  const landed = async () => {
    if (!holds(last.texts, nonce)) last = await read();
    return holds(last.texts, nonce);
  };
  await heldWithin(landed, timeout);
  return last;
}

const nth = (health: Record<string, unknown>, key: string, index: number) => {
  const list = health[key];
  return Array.isArray(list) ? Number(list[index]) : Number.NaN;
};
const turnDeltas = (before: Record<string, unknown>, after: typeof before, index: number) => ({
  rewriteCalls: nth(after, 'rewriteCalls', index) - nth(before, 'rewriteCalls', index),
  rewriteHits: nth(after, 'rewriteHits', index) - nth(before, 'rewriteHits', index),
  requests: Number(after.requests) - Number(before.requests),
});

/** The Agent's turn in a new browser, done once the provider counted its hit and requests. */
async function agentRewrite(lane: OfficeRewriteLane, index: 0 | 1, marker: string, dir: string) {
  const start = await lane.provider();
  let deltas = turnDeltas(start, start, index);
  const served = async () => {
    deltas = turnDeltas(start, await lane.provider(), index);
    return deltas.rewriteHits >= TURN.rewriteHits && deltas.requests >= TURN.requests;
  };
  const message = 'Office rewrite Agent turn not complete, provider deltas';
  const agent = await converseInWorkbench({
    ...{ ...lane.session, directory: dir, reply: lane.reply },
    message: `${marker} 请改写文档`,
    turnComplete: () => untilSeen(() => deltas, served, lane.session.timeout, message),
  });
  const provider = turnDeltas(start, await lane.provider(), index);
  expect(provider, `Office rewrite Agent turn ${String(index + 1)}`).toEqual(TURN);
  return { agent, provider };
}

/** Writes a case's one-paragraph DOCX, checks it and waits for the Document Server; its reader. */
async function freshDocx(lane: OfficeRewriteLane, id: string, name: string) {
  const written = JSON.parse(await lane.exec(docxCommand(name, PARAGRAPH))) as ArchiveEntry;
  const read = () => readWork(lane, name);
  const { texts, sha256 } = await read();
  const first = { sha256, text: texts['word/document.xml'] };
  expect(first, `Office rewrite ${id} file`).toEqual({ sha256: written.sha256, text: PARAGRAPH });
  await documentServerReady(lane);
  return read;
}

/** The page's config fetches, and status and path of every failed response: the query and hash
 * may carry keys. */
function responseLog() {
  const fetched = { config: 0 };
  const responses: string[] = [];
  const record = (response: Response) => {
    const { pathname } = new URL(response.url());
    if (pathname === CONFIG) fetched.config++;
    const status = response.status();
    if (status >= 400) responses.push(`${String(status)} ${pathname}`);
  };
  return { fetched, responses, record };
}

/** The page calls the notice span makes; Playwright's Page is one. */
interface NoticePage {
  evaluate<R>(expression: string): Promise<R>;
}

// A successful save's `saved` event clears 「保存未写回文件」 (OnlyOfficeView.tsx `saveError`).
const noneShown = (page: NoticePage) => async () =>
  Object.values(await page.evaluate<NoticeFlags>(NOTICES_SHOWN)).every((on) => !on);

/** What the notice span needs of its case: the counts, the pre-turn notices and its two steps. */
interface NoticeSteps<T> {
  readonly fetched: { readonly config: number };
  /** The config fetches before the Agent turn. */
  readonly open: number;
  /** The notices shown before the Agent turn. */
  readonly shown: NoticeFlags;
  /** Whether 「保存未写回文件」 latching is a positive to await, as the config refetch always is. */
  readonly waitSaveFailed: boolean;
  /** Types, saves and polls the read until the save landed. */
  readonly save: () => Promise<T>;
  /** The listing and screenshot after the save, run inside the quiet window. */
  readonly afterCleared: () => Promise<void>;
  readonly timeout: number;
  readonly windowMs: number;
}

/**
 * #657 A: from the Agent turn's `rewritten` read to the end of the editing session. The positives
 * (the refetch; 「保存未写回文件」 latched where awaited) are awaited up to `timeout`, their first
 * hold recorded in `arrived`; then a fixed window for the negatives; the notices shown at the
 * instant before the save; the save; the latch until it landed; the clear; and, with the latch
 * re-installed, a quiet window in which no notice and no refetch may come.
 */
export async function noticeSpan<T>(page: NoticePage, steps: NoticeSteps<T>) {
  const { fetched, open, timeout, windowMs } = steps;
  const seen = () => page.evaluate<NoticeFlags>(NOTICES_SEEN);
  const start = performance.now();
  const arrived: Record<'config' | 'saveFailed', number | null> = {
    config: null,
    saveFailed: null,
  };
  const since = () => Math.round(performance.now() - start);
  await heldWithin(async () => {
    if (arrived.config === null && fetched.config > open) arrived.config = since();
    if (steps.waitSaveFailed && arrived.saveFailed === null && (await seen()).saveFailed === true)
      arrived.saveFailed = since();
    return arrived.config !== null && (!steps.waitSaveFailed || arrived.saveFailed !== null);
  }, timeout);
  await delay(windowMs);
  const [latched, window] = [await seen(), fetched.config];
  const atSave = await page.evaluate<NoticeFlags>(NOTICES_SHOWN);
  const afterSave = await steps.save();
  const savedLatch = await seen();
  const cleared = await heldWithin(noneShown(page), timeout);
  await page.evaluate(NOTICE_LATCH);
  await steps.afterCleared();
  await delay(windowMs);
  const quiet = await seen();
  const config = { open, window, saved: fetched.config };
  const notices = noticeFlags(steps.shown, latched, atSave, savedLatch, quiet);
  return { notices, config, arrived, cleared, afterSave };
}

/** The key the plugin minted for the open `name`, read before anything changes the file. */
async function openKey(lane: OfficeRewriteLane, name: string) {
  const key = await registeredKey(lane, `${WORK}/${name}`);
  if (key === null) throw new Error(`Office rewrite: the plugin minted no key for ${name}`);
  return key;
}

/** One case: open, maybe type unsaved, the Agent's rewrite, a window, type and save, then close. */
async function rewriteCase(
  lane: OfficeRewriteLane,
  index: 0 | 1,
  root: string,
  held: ForgottenKey,
) {
  const { session } = lane;
  const { id, name, typeFirst } = CASES[index];
  const script = lane.rewrites[index];
  if (script === undefined) throw new Error('Office rewrite script missing');
  const read = await freshDocx(lane, id, name);
  const [typed, saved] = [editorNonce(), editorNonce()];
  const directory = join(root, id);
  const shot = `office-rewrite-${id}`;
  const { fetched, responses, record } = responseLog();
  const observe = (file: OfficeRead): Observed => ({
    state: rewriteState(file.texts, script.nonce, saved),
    ...(typeFirst ? { typed: holds(file.texts, typed) } : {}),
    ...digest(file),
  });
  const browse = async (page: Page, shoot: (name: string) => Promise<void>) => {
    await openHinted(page, shoot, session, name, `${shot}-open`, editorRefused);
    held.key = await openKey(lane, name);
    if (typeFirst) {
      await typeAndSave(page, 'docx', typed, session.timeout, undefined, false);
      await shoot(`${shot}-typed`);
    }
    const open = fetched.config;
    const before = await listing(lane);
    const shown = await page.evaluate<NoticeFlags>(NOTICES_SHOWN);
    await page.evaluate(NOTICE_LATCH);
    const { agent, provider } = await agentRewrite(
      lane,
      index,
      script.marker,
      join(directory, 'agent'),
    );
    const rewritten = observe(await read());
    let entries: { saved: EntryDiff } | undefined;
    const span = await noticeSpan(page, {
      ...{ fetched, open, shown, waitSaveFailed: typeFirst },
      save: async () => {
        await typeAndSave(page, 'docx', saved, session.timeout);
        return observe(await readUntil(read, saved, session.timeout));
      },
      afterCleared: async () => {
        entries = { saved: entryDiff(before, await listing(lane)) };
        await shoot(`${shot}-saved`);
      },
      ...{ timeout: session.timeout, windowMs: OBSERVE_MS },
    });
    if (entries === undefined) throw new Error('Office rewrite listing after the save missing');
    return { agent, provider, ...span, rewritten, entries, before };
  };
  let browsed: Awaited<ReturnType<typeof browse>> | undefined;
  const names = {
    label: `office rewrite ${id}`,
    failure: `${shot}-failure`,
    // The save-error notice renders the guard's message: the old key, the path and sizes.
    masked: [NOTICES.saveFailed],
  };
  const body = async (page: Page, shoot: (name: string) => Promise<void>) => {
    browsed = await browse(page, shoot);
  };
  const editor = await workbenchSession({ ...session, directory }, names, body, undefined, record);
  if (browsed === undefined || held.key === null)
    throw new Error('Office rewrite case not observed');
  await delay(OBSERVE_MS);
  const { agent, provider, notices, cleared, config, arrived, rewritten, afterSave, entries } =
    browsed;
  const { before } = browsed;
  const evidence: RewriteCaseEvidence = {
    ...{ file: name, provider, notices, cleared, config, arrived, responses, editor, agent },
    reads: { rewritten, saved: afterSave, closed: observe(await read()) },
    entries: { ...entries, closed: entryDiff(before, await listing(lane)) },
    allowed: editorErrorsAllowed(editor.consoleErrors, responses, session.base),
    forgotten: await forgottenRecord(lane, held.key, `(rewrite ${id})`),
  };
  const seen = `Office rewrite ${id}, observed ${JSON.stringify(caseLine(evidence))}`;
  expect(rewriteFacts(evidence), seen).toEqual(EXPECTED_REWRITE[id]);
  const shots = ['open', ...(typeFirst ? ['typed'] : []), 'saved'].map((at) => `${shot}-${at}.png`);
  expect(editor.screenshots, seen).toEqual(shots);
  return evidence;
}

/** A's instance log since `since`; `undefined` when the read failed, whose redacted error carries
 * no log text (the log holds the launch token and document keys). */
const hostLog = ({ run, instance }: OfficeRewriteLane, since: number) =>
  run(['logs', '--timestamps', '--since', new Date(since).toISOString(), instance]).catch(
    () => undefined,
  );

type Nonces = Readonly<Record<'typed' | 'agent' | 'saved', string>>;

/**
 * The unsaved nonce, then the rewrite with filler typed alongside until the stale banner latched or
 * a session timeout passed. The rewrite's outcome is handled at once and joined after the typing.
 */
async function typeThroughRewrite(page: Page, lane: OfficeRewriteLane, nonces: Nonces) {
  const { timeout } = lane.session;
  const origin = Date.now();
  await typeAndSave(page, 'docx', nonces.typed, timeout, undefined, false);
  const execStart = Date.now();
  const rewrite = lane.exec(rewriteArgv(TYPING.name, nonces.agent)).then(
    () => ({ execEnd: Date.now() }),
    (error: unknown) => ({ error }),
  );
  // The nonce's last keystroke when no filler follows.
  let lastKey = execStart;
  const latched = () => page.evaluate<boolean>(STALE_LATCHED);
  const bound = performance.now() + timeout;
  while (!(await latched()) && performance.now() < bound) {
    await page.keyboard.type(FILLER);
    lastKey = Date.now();
  }
  const done = await rewrite;
  if ('error' in done) throw done.error;
  return { marks: { origin, execStart, execEnd: done.execEnd, lastKey }, latched: await latched() };
}

interface TypingSteps {
  readonly lane: OfficeRewriteLane;
  readonly nonces: Nonces;
  readonly read: () => Promise<OfficeRead>;
  readonly observe: (file: OfficeRead) => Observed;
  readonly fetched: { readonly config: number };
  readonly held: ForgottenKey;
}

/** The typing session: observers, the window, its precondition, the save, the page's signals. */
async function typingBrowse(
  page: Page,
  shoot: (name: string) => Promise<void>,
  steps: TypingSteps,
) {
  const { lane, read, observe, fetched } = steps;
  const { timeout } = lane.session;
  const shot = `office-rewrite-${TYPING.id}`;
  const shown = () => page.evaluate<NoticeFlags>(NOTICES_SHOWN);
  await page.evaluate(WATCH_WRAPPER);
  await openHinted(page, shoot, lane.session, TYPING.name, `${shot}-open`, editorRefused);
  await page.evaluate(NOTICE_LATCH);
  await page.evaluate(FRAME_LISTENER);
  steps.held.key = await openKey(lane, TYPING.name);
  const before = await listing(lane);
  const [open, beforeShown] = [fetched.config, await shown()];
  const { marks, latched } = await typeThroughRewrite(page, lane, steps.nonces);
  const frames = () => page.evaluate<FrameRecord | null>(FRAMES_SEEN);
  const facts = async () => {
    const times = await page.evaluate<Readonly<Record<string, NoticeTimes>>>(NOTICE_TIMES);
    const stale = times.staleChanged ?? { shown: null, cleared: null };
    return windowFacts(marks, stale, await frames());
  };
  const missed = `Office rewrite typing: stale banner not latched within the window, (a)`;
  expect(latched, `${missed} ${JSON.stringify(await facts())}`).toBe(true);
  const rewritten = observe(await read());
  await delay(OBSERVE_MS);
  const held = { shown: await shown(), latched: await page.evaluate<NoticeFlags>(NOTICES_SEEN) };
  const config = { open, window: fetched.config };
  await shoot(`${shot}-window`);
  const savedAt = Date.now();
  await typeAndSave(page, 'docx', steps.nonces.saved, timeout);
  const saved = { read: observe(await readUntil(read, steps.nonces.saved, timeout)) };
  const [savedShown, savedConfig] = [await shown(), fetched.config];
  const cleared = await heldWithin(noneShown(page), timeout);
  const entries = { saved: entryDiff(before, await listing(lane)) };
  const hostBefore = saveLines(await hostLog(lane, marks.origin), marks.origin);
  const watch = watchSignal(await page.evaluate<WatchRecord | null>(WATCH_SEEN), marks.origin);
  await shoot(`${shot}-saved`);
  return {
    ...{ before, origin: marks.origin, rewritten, saved: saved.read, entries, hostBefore },
    notices: { before: beforeShown, window: held.shown, saved: savedShown, end: await shown() },
    latched: { window: held.latched, end: await page.evaluate<NoticeFlags>(NOTICES_SEEN) },
    config: { ...config, saved: savedConfig, end: fetched.config },
    ...{ cleared, window: await facts(), watch },
    dirty: frameSignal(await frames(), marks.origin, savedAt),
  };
}

/**
 * #652: A types into an open DOCX and keeps typing while the file is rewritten in the instance,
 * without an Agent turn, until the plugin's stale banner latches; then A types and saves again in
 * the same editor and closes it. Asserted: the window precondition first, the provider untouched,
 * EXPECTED_TYPING and the screenshots; the times and the host log are recorded (#652 (a)(b)(c)).
 */
async function typingCase(
  lane: OfficeRewriteLane,
  root: string,
  since: number,
  held: ForgottenKey,
) {
  const { session } = lane;
  const provider = await providerCounts(lane);
  const control = saveLines(await hostLog(lane, since), since);
  const read = await freshDocx(lane, TYPING.id, TYPING.name);
  const nonces = { typed: editorNonce(), agent: editorNonce(), saved: editorNonce() };
  const { fetched, responses, record } = responseLog();
  const observe = (file: OfficeRead): Observed => ({
    state: rewriteState(file.texts, nonces.agent, nonces.saved),
    typed: heldApart(file.texts, nonces.typed, nonces.saved),
    ...digest(file),
  });
  const shot = `office-rewrite-${TYPING.id}`;
  const names = { label: 'office rewrite typing', failure: `${shot}-failure` };
  let browsed: Awaited<ReturnType<typeof typingBrowse>> | undefined;
  const editor = await workbenchSession(
    { ...session, directory: join(root, TYPING.id) },
    // The save-error notice renders the guard's message: the old key, the path and sizes.
    { ...names, masked: [NOTICES.saveFailed] },
    async (page, shoot) => {
      browsed = await typingBrowse(page, shoot, { lane, nonces, read, observe, fetched, held });
    },
    undefined,
    record,
  );
  if (browsed === undefined || held.key === null)
    throw new Error('Office rewrite typing case not observed');
  await delay(OBSERVE_MS);
  const { before, origin, rewritten, saved, entries, hostBefore, ...page } = browsed;
  const afterClose = saveLines(await hostLog(lane, origin), origin);
  const evidence: TypingEvidence = {
    ...{ file: TYPING.name, provider: await providerCounts(lane), ...page },
    host: hostSignal(control, hostBefore, afterClose),
    reads: { rewritten, saved, closed: observe(await read()) },
    entries: { ...entries, closed: entryDiff(before, await listing(lane)) },
    ...{ responses, editor },
    allowed: editorErrorsAllowed(editor.consoleErrors, responses, session.base),
    forgotten: await forgottenRecord(lane, held.key, '(rewrite typing)'),
  };
  const seen = `Office rewrite typing, observed ${JSON.stringify(typingLine(evidence))}`;
  expect(evidence.provider, seen).toEqual(provider);
  expect(typingFacts(evidence), seen).toEqual(EXPECTED_TYPING);
  const shots = ['open', 'window', 'saved'].map((at) => `${shot}-${at}.png`);
  expect(editor.screenshots, seen).toEqual(shots);
  return evidence;
}

/**
 * 18.7 (#442): with A's DOCX open in ONLYOFFICE, clean or with an unsaved edit, the Agent's `bash`
 * rewrites the same file. The editor refreshes to the Agent's version, awaited up to a session
 * timeout with its arrival recorded; the clean case shows no plugin notice, the unsaved one drops
 * its edit and shows 「保存未写回文件」 until A's save lands, still at the instant before it. A then
 * types and saves, no notice or refresh comes in the quiet window after the save's clear, and the
 * file holds both sides' text, with no copy left in `/data/work`, still after the editor closes
 * (#657 A). The typing case (#652) follows: with the rewrite in its window, the
 * editor refreshes once it turns clean, and A's next save holds both sides' text. Each case
 * records and then removes the forgotten copy its open key left (#650); a case failing once that
 * key was read clears it after `settle` and rethrows its own failure.
 */
export const officeRewriteScenario = (
  lane: OfficeRewriteLane,
  settle = settleForgotten,
): Promise<OfficeRewriteEvidence> =>
  withWorkFiles(
    lane,
    [...CASES.map(({ name }) => name), TYPING.name],
    'Office rewrite',
    async () => {
      const since = Date.now();
      const start = await lane.provider();
      const configured = [start.rewriteCalls, start.rewriteHits];
      expect(configured, 'Rewrite scripts configured').toEqual([
        [0, 0],
        [0, 0],
      ]);
      const root = join(lane.session.directory, 'office-rewrite');
      const cleared = <T>(id: string, body: (held: ForgottenKey) => Promise<T>) =>
        clearingForgottenOnError(lane, `(rewrite ${id} cleanup)`, body, settle);
      const clean = await cleared('clean', (held) => rewriteCase(lane, 0, root, held));
      const unsaved = await cleared('unsaved', (held) => rewriteCase(lane, 1, root, held));
      const typing = await cleared('typing', (held) => typingCase(lane, root, since, held));
      return { clean, unsaved, typing };
    },
  );

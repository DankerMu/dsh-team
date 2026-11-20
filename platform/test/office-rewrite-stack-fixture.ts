import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Response } from '@playwright/test';
import { expect } from 'vitest';
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
import {
  docxCommand,
  documentServerReady,
  openHinted,
  untilSeen,
} from './office-hints-stack-fixture.ts';
import { withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const PARAGRAPH = '改写探针：开头只有这一段。';
/** §60's cases in order: the second types a nonce, unsaved, before the Agent rewrites the file. */
const CASES = [
  { id: 'clean', name: '干净改写.docx', typeFirst: false },
  { id: 'unsaved', name: '未保存改写.docx', typeFirst: true },
] as const;
type CaseId = (typeof CASES)[number]['id'];
// Every notice dsh-sidebar-onlyoffice@0.2.0 shows above the editor, zh: src/client/locales.ts:25
// `staleChanged`, :27 `staleRemoved`, :28 `saveFailed`.
const NOTICES = {
  staleChanged: '文件已被外部修改（可能是 AI）——重新加载将丢弃未保存的修改',
  staleRemoved: '文件已从磁盘删除',
  saveFailed: '保存未写回文件（文档服务会重试；请勿只关闭标签页，必要时用“下载文件”备份）',
};
const CONFIG = '/sidebar/onlyoffice/config';
// A notice, the refresh or a late status 2 follow the rewrite within seconds. 15s is a quarter of
// the 60s session timeout; each case spends two windows (after the Agent turn and after the editor
// closes), so both cases add 60s to the stack case on top of their session waits.
const OBSERVE_MS = 15_000;
/** One Agent turn: its rewrite's call and hit, and the bash, tool-result and title requests. */
const TURN = { rewriteCalls: 1, rewriteHits: 1, requests: 3 };
const SESSION_LISTS = ['pageErrors', 'failedRequests', 'externalRequests'] as const;
const NO_ENTRIES = { added: [], removed: [] };
const QUIET = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };
const UNSEEN = { before: false, window: false, saved: false };
/**
 * §60's measurement (step 1, review round 1). Clean: no notice above the editor from before the
 * Agent turn until the save landed. Unsaved: the refreshed-away session's status 2 with the
 * discarded edit is refused, so 「保存未写回文件」 shows within the window and until the save
 * landed. Both: no notice shown once the save landed; one config refetch, the plugin's refreshFile;
 * the file the Agent's after the rewrite and both sides' after the save and the close; the unsaved
 * case's typed nonce gone from every read; no new or missing work entry; 18.5's allowed errors.
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
};
const REFUSED = { before: false, window: true, saved: true };
export const EXPECTED_REWRITE = {
  clean: CLEAN,
  unsaved: { ...CLEAN, notices: { ...CLEAN.notices, saveFailed: REFUSED } },
};

// python-docx from the user image; the file and the nonce arrive as argv. No single quote (below).
export const REWRITER = `import sys
from docx import Document
path, nonce = sys.argv[1:]
document = Document(path)
document.add_paragraph(nonce)
document.save(path)
print(nonce)`;
/** The Agent's bash rewrite of `name` in the work directory, each word single-quoted. */
export const rewriteCommand = (name: string, nonce: string) =>
  singleQuoted(['python3', '-c', REWRITER, `${WORK}/${name}`, nonce]);

/** The provider's rewrite scripts, one per case in order; every value is a nonsecret nonce. */
export const ownedRewrites = () =>
  CASES.map(({ name }) => {
    const nonce = editorNonce();
    return { marker: `stack-rewrite-${randomUUID()}`, command: rewriteCommand(name, nonce), nonce };
  });

type OfficeRead = Awaited<ReturnType<typeof readWork>>;

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
  const parts = Object.entries(texts).map(([part, text]): [string, string] => [
    part,
    text.replaceAll(employeeNonce, ''),
  ]);
  const agent = holds(Object.fromEntries(parts), agentNonce);
  if (holds(texts, employeeNonce)) return agent ? 'both' : 'employee-only';
  return agent ? 'agent-only' : 'neither';
}

type Observed = Digest & { readonly state: ReturnType<typeof rewriteState>; typed?: boolean };
type EntryDiff = Readonly<Record<'added' | 'removed', readonly string[]>>;
/** No nonce, marker or key: states, digests, entry names, `status path` lines and sessions. */
interface RewriteCaseEvidence {
  readonly file: string;
  readonly provider: Readonly<Record<string, number>>;
  /** Each notice: shown before the Agent turn, latched from then to the window's end, latched from
   * then until the save landed. */
  readonly notices: Readonly<
    Record<string, Readonly<Record<'before' | 'window' | 'saved', boolean>>>
  >;
  /** No notice shown within a session timeout once the save landed. */
  readonly cleared: boolean;
  /** The page's config fetches so far: before the Agent turn, after the window, after the save. */
  readonly config: Readonly<Record<'open' | 'window' | 'saved', number>>;
  readonly reads: Readonly<Record<'rewritten' | 'saved' | 'closed', Observed>>;
  /** `/data/work` against its listing before the Agent turn. */
  readonly entries: Readonly<Record<'saved' | 'closed', EntryDiff>>;
  readonly responses: readonly string[];
  /** The editing session's errors are 18.5's allowed ones (`editorErrorsAllowed`). */
  readonly allowed: boolean;
  readonly editor: StackBrowserEvidence;
  readonly agent: StackBrowserEvidence;
}
type OfficeRewriteEvidence = Readonly<Record<CaseId, RewriteCaseEvidence>>;

const READS = ['rewritten', 'saved', 'closed'] as const;
/** What EXPECTED_REWRITE fixes of one case; `typed` is false where nothing was typed first. */
export function rewriteFacts(evidence: RewriteCaseEvidence) {
  const { notices, cleared, config, reads, entries, allowed, editor, agent } = evidence;
  const sessions = [editor, agent].map((browser) =>
    Object.fromEntries(SESSION_LISTS.map((key) => [key, browser[key].length])),
  );
  const states = READS.map((at) => reads[at].state);
  return {
    notices,
    cleared,
    config,
    states,
    typed: READS.map((at) => reads[at].typed ?? false),
    entries,
    allowed,
    sessions,
  };
}

/** A query or hash, then any 20-character word run but lowercase words: keys, tokens, nonces. */
const scrub = (text: string) =>
  text
    .replace(/[?#]\S*/g, '')
    .replace(/[\w-]{20,}/g, (run) => (/^[a-z_-]+$/.test(run) ? run : '<redacted>'));

const caseLine = ({ editor, agent, responses, ...rest }: RewriteCaseEvidence) => ({
  ...{ ...rest, responses: responses.map(scrub) },
  editor: {
    ...counted(editor),
    ...{ errors: editor.consoleErrors.map(scrub), failed: editor.failedRequests.map(scrub) },
  },
  agent: counted(agent),
});

/** The stack evidence line: sessions counted, the editor's errors and failures scrubbed. */
export function officeRewriteLine(evidence: OfficeRewriteEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office rewrite evidence missing');
  return { clean: caseLine(evidence.clean), unsaved: caseLine(evidence.unsaved) };
}

/** A's lane plus the provider's reply and its rewrite scripts, one per case in order. */
type OfficeRewriteLane = ArchiveLane & {
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
// does; innerText, as officeFacts reads it, leaves script and style text out. A second install
// starts the latch afresh.
const NOTICE_LATCH = `(() => {
  const notices = ${JSON.stringify(NOTICES)};
  window.__dshTeamNotices = Object.fromEntries(Object.keys(notices).map((id) => [id, false]));
  const check = () => {
    const text = document.body.innerText;
    for (const [id, notice] of Object.entries(notices)) if (text.includes(notice)) window.__dshTeamNotices[id] = true;
  };
  check();
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
})()`;
const NOTICES_SEEN = '({ ...window.__dshTeamNotices })';
const NOTICES_SHOWN = `Object.fromEntries(Object.entries(${JSON.stringify(NOTICES)}).map(([id, notice]) => [id, document.body.innerText.includes(notice)]))`;
type NoticeFlags = Readonly<Record<string, boolean>>;
/** Each notice's three flags; a flag the page did not report counts as seen, so it fails. */
const noticeFlags = (before: NoticeFlags, window: NoticeFlags, saved: NoticeFlags) =>
  Object.fromEntries(
    Object.keys(NOTICES).map((id) => [
      id,
      { before: before[id] !== false, window: window[id] !== false, saved: saved[id] !== false },
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

/** One case: open, maybe type unsaved, the Agent's rewrite, a window, type and save, then close. */
async function rewriteCase(lane: OfficeRewriteLane, index: 0 | 1, root: string) {
  const { session } = lane;
  const { id, name, typeFirst } = CASES[index];
  const script = lane.rewrites[index];
  if (script === undefined) throw new Error('Office rewrite script missing');
  const written = JSON.parse(await lane.exec(docxCommand(name, PARAGRAPH))) as ArchiveEntry;
  const read = () => readWork(lane, name);
  const { texts, sha256 } = await read();
  const first = { sha256, text: texts['word/document.xml'] };
  expect(first, `Office rewrite ${id} file`).toEqual({ sha256: written.sha256, text: PARAGRAPH });
  await documentServerReady(lane);
  const [typed, saved] = [editorNonce(), editorNonce()];
  const directory = join(root, id);
  const shot = `office-rewrite-${id}`;
  const fetched = { config: 0 };
  // Status and path of every failed response; the query and hash may carry keys.
  const responses: string[] = [];
  const record = (response: Response) => {
    const { pathname } = new URL(response.url());
    if (pathname === CONFIG) fetched.config++;
    const status = response.status();
    if (status >= 400) responses.push(`${String(status)} ${pathname}`);
  };
  const observe = (file: OfficeRead): Observed => ({
    state: rewriteState(file.texts, script.nonce, saved),
    ...(typeFirst ? { typed: holds(file.texts, typed) } : {}),
    ...digest(file),
  });
  const browse = async (page: Page, shoot: (name: string) => Promise<void>) => {
    await openHinted(page, shoot, session, name, `${shot}-open`, editorRefused);
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
    await delay(OBSERVE_MS);
    const latched = await page.evaluate<NoticeFlags>(NOTICES_SEEN);
    const window = fetched.config;
    await typeAndSave(page, 'docx', saved, session.timeout);
    const afterSave = observe(await readUntil(read, saved, session.timeout));
    const notices = noticeFlags(shown, latched, await page.evaluate<NoticeFlags>(NOTICES_SEEN));
    // A successful save's `saved` event clears 「保存未写回文件」 (OnlyOfficeView.tsx `saveError`).
    const none = async () =>
      Object.values(await page.evaluate<NoticeFlags>(NOTICES_SHOWN)).every((on) => !on);
    const cleared = await heldWithin(none, session.timeout);
    const entries = { saved: entryDiff(before, await listing(lane)) };
    await shoot(`${shot}-saved`);
    const config = { open, window, saved: fetched.config };
    return { agent, provider, notices, cleared, config, rewritten, afterSave, entries, before };
  };
  let browsed: Awaited<ReturnType<typeof browse>> | undefined;
  const names = { label: `office rewrite ${id}`, failure: `${shot}-failure` };
  const body = async (page: Page, shoot: (name: string) => Promise<void>) => {
    browsed = await browse(page, shoot);
  };
  const editor = await workbenchSession({ ...session, directory }, names, body, undefined, record);
  if (browsed === undefined) throw new Error('Office rewrite case not observed');
  await delay(OBSERVE_MS);
  const { agent, provider, notices, cleared, config, rewritten, afterSave, entries, before } =
    browsed;
  const evidence: RewriteCaseEvidence = {
    ...{ file: name, provider, notices, cleared, config, responses, editor, agent },
    reads: { rewritten, saved: afterSave, closed: observe(await read()) },
    entries: { ...entries, closed: entryDiff(before, await listing(lane)) },
    allowed: editorErrorsAllowed(editor.consoleErrors, responses, session.base),
  };
  const seen = `Office rewrite ${id}, observed ${JSON.stringify(caseLine(evidence))}`;
  expect(rewriteFacts(evidence), seen).toEqual(EXPECTED_REWRITE[id]);
  const shots = ['open', ...(typeFirst ? ['typed'] : []), 'saved'].map((at) => `${shot}-${at}.png`);
  expect(editor.screenshots, seen).toEqual(shots);
  return evidence;
}

/**
 * 18.7 (#442): with A's DOCX open in ONLYOFFICE, clean or with an unsaved edit, the Agent's `bash`
 * rewrites the same file. The editor refreshes to the Agent's version; the clean case shows no
 * plugin notice, the unsaved one drops its edit and shows 「保存未写回文件」 until A's save lands. A
 * then types and saves, and the file holds both sides' text, with no copy left in `/data/work`,
 * still after the editor closes.
 */
export const officeRewriteScenario = (lane: OfficeRewriteLane): Promise<OfficeRewriteEvidence> =>
  withWorkFiles(
    lane,
    CASES.map(({ name }) => name),
    'Office rewrite',
    async () => {
      const start = await lane.provider();
      const configured = [start.rewriteCalls, start.rewriteHits];
      expect(configured, 'Rewrite scripts configured').toEqual([
        [0, 0],
        [0, 0],
      ]);
      const root = join(lane.session.directory, 'office-rewrite');
      const clean = await rewriteCase(lane, 0, root);
      return { clean, unsaved: await rewriteCase(lane, 1, root) };
    },
  );

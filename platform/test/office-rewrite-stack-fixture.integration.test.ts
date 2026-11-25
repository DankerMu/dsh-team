import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { DOCUMENT_SERVER } from './document-server-net-fixture.ts';
import { editorNonce, NONCE_PATTERN, READER } from './office-editor-stack-fixture.ts';
import { docxCommand, HEALTH_COMMAND, openHinted } from './office-hints-stack-fixture.ts';
import type * as OfficeHints from './office-hints-stack-fixture.ts';
import { REGISTRY } from './office-isolation-stack-fixture.ts';
import { rewriteCommand } from './office-rewrite-formats.ts';
import {
  EXPECTED_REWRITE,
  EXPECTED_TYPING,
  heldApart,
  NOTICES as NOTICE_TEXTS,
  noticeSpan,
  officeRewriteLine,
  officeRewriteScenario,
  ownedRewrites,
  rewriteFacts,
  rewriteState,
  typingFacts,
  typingSaved,
} from './office-rewrite-stack-fixture.ts';
import { flagsOf, POLL_MS, standIn, TIMEOUT, WINDOW_MS } from './office-rewrite-stand-in.ts';
import type { NoticeId, StandIn } from './office-rewrite-stand-in.ts';
import {
  everythingPrinted,
  StackWorkbenchFailure,
  workbenchSession,
} from './stack-browser-fixture.ts';
import type * as StackBrowser from './stack-browser-fixture.ts';

// Only the browser session is a stand-in; the lane runs as written around it.
vi.mock('./stack-browser-fixture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof StackBrowser>();
  return { ...actual, workbenchSession: vi.fn(actual.workbenchSession) };
});
// The editor opening is a stand-in where a case needs the session body to reach the key read.
vi.mock('./office-hints-stack-fixture.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof OfficeHints>();
  return { ...actual, openHinted: vi.fn(actual.openHinted) };
});
afterEach(() => {
  vi.mocked(workbenchSession).mockReset();
  vi.mocked(openHinted).mockReset();
});

const [AGENT, EMPLOYEE] = [editorNonce(), editorNonce()];
const DIR = mkdtempSync(join(tmpdir(), 'dsh-team-office-rewrite-'));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});
// Each paragraph as one part's text.
const texts = (...paragraphs: string[]) => Object.fromEntries(paragraphs.entries());

it.each([
  ['both nonces in two parts', texts(`改写探针。${EMPLOYEE}`, AGENT), 'both'],
  ['both nonces in one part', texts(`${AGENT}${EMPLOYEE}`), 'both'],
  [
    'the employee nonce typed inside the Agent nonce',
    texts(`${AGENT.slice(0, 11)}${EMPLOYEE}${AGENT.slice(11)}`),
    'both',
  ],
  [
    'the employee nonce twice inside the Agent nonce',
    texts(`${AGENT.slice(0, 7)}${EMPLOYEE}${EMPLOYEE}${AGENT.slice(7)}`),
    'both',
  ],
  ['only the employee nonce', texts('', EMPLOYEE), 'employee-only'],
  ['only the Agent nonce', texts(`改写探针。${AGENT}`), 'agent-only'],
  ['neither nonce', texts('改写探针。'), 'neither'],
  ['no part at all', texts(), 'neither'],
  [
    'the employee nonce split over two parts',
    texts(EMPLOYEE.slice(0, 9), EMPLOYEE.slice(9)),
    'neither',
  ],
])('reads a file holding %s', (_case, read, state) => {
  expect(rewriteState(read, AGENT, EMPLOYEE)).toBe(state);
});

it.each([
  ['whole', texts(`${AGENT}www`), true],
  ['split by the other nonce', texts(`${AGENT.slice(0, 9)}${EMPLOYEE}${AGENT.slice(9)}`), true],
  ['split over two parts', texts(AGENT.slice(0, 9), AGENT.slice(9)), false],
  ['absent', texts(EMPLOYEE), false],
])('reads a nonce %s as held apart from the other', (_case, read, held) => {
  expect(heldApart(read, AGENT, EMPLOYEE)).toBe(held);
});

it('scripts one rewrite per case file, each with its own marker and nonce', () => {
  const scripts = ownedRewrites();

  const fresh = ownedRewrites().map(({ nonce }) => nonce);

  const names = ['干净改写.docx', '未保存改写.docx', '干净改写.xlsx', '干净改写.pptx'];
  const commands = scripts.map(({ nonce }, index) => rewriteCommand(names[index] ?? '', nonce));
  expect(scripts.map(({ command }) => command)).toEqual(commands);
  expect(scripts).toHaveLength(4);
  for (const { marker, nonce } of scripts) {
    expect(nonce).toMatch(new RegExp(`^${NONCE_PATTERN.source}$`));
    expect(marker).toMatch(/^stack-rewrite-[0-9a-f-]{36}$/);
  }
  const values = scripts.flatMap(({ marker, nonce }) => [marker, nonce]);
  expect(new Set([...values, ...fresh]).size).toBe(12);
});

const BASE = 'http://127.0.0.1:64694';
const DS = '/sidebar/onlyoffice/ds/9.4.0-c83aecd3de42866b80ccf786af6354d6';
// A 24-character run that is not a lowercase word, as a key or token in a URL would be.
const LONG_RUN = 'Ab1'.repeat(8);
const FETCH = 'A bad HTTP response code (403) was received when fetching the script.';
const session = (screenshots: string[], consoleErrors: string[], failedRequests: string[]) => ({
  ...{ screenshots, consoleErrors, pageErrors: [], failedRequests, externalRequests: [] },
  ...{ unloadViolations: [], requests: 40, websockets: 2 },
});
const read = { state: 'both', size: 9_000, sha256: 'b'.repeat(64) } as const;
const unchanged = { added: [], removed: [] };
const unseen = { before: false, window: false, atSave: false, saved: false, quiet: false };
// The plugin's three notices above the editor: none shown before the turn, latched in the window,
// shown at the save, latched until the save landed or seen in the quiet window after its clear.
const NOTICES = { staleChanged: unseen, staleRemoved: unseen, saveFailed: unseen };
const replies = ['login.png', 'workbench.png', 'reply.png'];
const quiet = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };
const UNLOADS = ['sdkjs-plugins/v1/plugins.js:39'];

it('prints each case without nonces, keys or queries: errors and failures scrubbed, sessions counted', () => {
  const editor = {
    ...session(
      ['office-rewrite-clean-open.png', 'office-rewrite-clean-saved.png'],
      [FETCH, `GET ${BASE}/sidebar/onlyoffice/file?token=${LONG_RUN} ${AGENT}`],
      [`GET ${BASE}${DS}/x.json#${LONG_RUN}`],
    ),
    unloadViolations: UNLOADS,
  };
  const observed = {
    ...{ file: '干净改写.docx', provider: { rewriteCalls: 1, rewriteHits: 1, requests: 3 } },
    ...{
      notices: NOTICES,
      cleared: true,
      config: { open: 1, window: 2, saved: 2 },
      arrived: { config: 250, saveFailed: null },
    },
    forgotten: { copies: 0, listed: false, cleared: true },
    reads: { rewritten: { ...read, state: 'agent-only' as const }, saved: read, closed: read },
    entries: { saved: { added: ['干净改写.docx.tmp-1'], removed: [] }, closed: unchanged },
    allowed: false,
  };
  const responses = [
    `403 ${DS}/document_editor_service_worker.js`,
    `404 /cache/files/data/${LONG_RUN}/x`,
  ];
  const clean = { ...observed, responses, editor, agent: session(replies, [], []) };
  const reads = { rewritten: { ...read, typed: true }, saved: read, closed: read };
  const unsaved = { ...clean, file: '未保存改写.docx', reads };
  const [xlsx, pptx] = [
    { ...clean, file: 'x.xlsx' },
    { ...clean, file: 'p.pptx' },
  ];

  const shown = { staleChanged: false, staleRemoved: false, saveFailed: true };
  const typingObserved = {
    ...{ file: '键入改写.docx', provider: { requests: 9, searches: 0, delegations: 0 } },
    window: {
      ...{ execStart: 5, execEnd: 900, lastKey: 1_400 },
      ...{ staleLatched: 1_300, staleCleared: null, dirtyFalse: 'unavailable' },
    },
    ...{ notices: { before: shown, window: shown, saved: shown, end: shown } },
    ...{ latched: { window: shown, end: shown }, cleared: false, quietWindow: shown },
    config: { open: 1, window: 1, saved: 1, end: 1 },
    dirty: { available: false, control: { messages: 3, parsed: 3, malformed: 0, stateChanges: 0 } },
    watch: { available: true, kinds: { change: 1, 'save-error': 2 }, saveErrors: [20, 30] },
    host: { available: false, reason: 'no earlier line' },
    reads: { rewritten: read, saved: read, closed: read },
    entries: { saved: unchanged, closed: unchanged },
    allowed: true,
    forgotten: { copies: 1, listed: true, cleared: true },
  } as const;
  const typing = { ...typingObserved, responses, editor };

  const line = officeRewriteLine({ clean, unsaved, xlsx, pptx, typing });

  const printed = {
    ...observed,
    responses: [
      '403 /sidebar/onlyoffice/ds/9.4.<redacted>/document_editor_service_worker.js',
      '404 /cache/files/data/<redacted>/x',
    ],
    editor: {
      ...{ screenshots: editor.screenshots, consoleErrors: 2, pageErrors: 0 },
      unloadViolations: UNLOADS,
      ...{ failedRequests: 1, externalRequests: 0 },
      errors: [FETCH, `GET ${BASE}/sidebar/onlyoffice/file <redacted>`],
      failed: [`GET ${BASE}/sidebar/onlyoffice/ds/9.4.<redacted>/x.json`],
    },
    agent: { screenshots: replies, unloadViolations: [], consoleErrors: 0, ...quiet },
  };
  expect(line).toEqual({
    clean: printed,
    unsaved: { ...printed, file: '未保存改写.docx', reads },
    ...{ xlsx: { ...printed, file: 'x.xlsx' }, pptx: { ...printed, file: 'p.pptx' } },
    typing: { ...typingObserved, responses: printed.responses, editor: printed.editor },
  });
  for (const secret of [LONG_RUN, AGENT, 'token'])
    expect(JSON.stringify(line)).not.toContain(secret);
  expect(() => officeRewriteLine(undefined)).toThrow('Office rewrite evidence missing');
});

// #650's source prediction: a session closed with its save refused leaves one forgotten copy
// under its key, listed; one closed without a change leaves none; the lane clears either.
const NO_COPY = { copies: 0, listed: false, cleared: true };
const COPY = { copies: 1, listed: true, cleared: true };
// §60's measured values (step 1 and review round 1), written out rather than read from the fixture;
// #657 A's `atSave` and `quiet` flags are predictions, confirmed by the exact-head stack.
const CLEAN = {
  notices: NOTICES,
  cleared: true,
  config: { open: 1, window: 2, saved: 2 },
  // The stack on 47f4f86: the refetch at 250ms and 253ms, the unsaved notice at 5561ms.
  arrived: { config: true, saveFailed: false },
  states: ['agent-only', 'both', 'both'],
  typed: [false, false, false],
  entries: { saved: unchanged, closed: unchanged },
  allowed: true,
  sessions: [quiet, quiet],
  forgotten: NO_COPY,
};
// The old key's status 2 with the discarded edit is refused: 「保存未写回文件」 shows until the save,
// at its instant too, and not after the save's clear.
const REFUSED = { before: false, window: true, atSave: true, saved: true, quiet: false };
const UNSAVED = {
  ...{ ...CLEAN, notices: { ...NOTICES, saveFailed: REFUSED } },
  ...{ arrived: { config: true, saveFailed: true }, forgotten: COPY },
};
// #657 A4's prediction for the clean XLSX and PPTX cases, for the stack to confirm.
const MEASURED = { clean: CLEAN, unsaved: UNSAVED, xlsx: CLEAN, pptx: CLEAN };
type Id = keyof typeof MEASURED;
const at = (state: 'agent-only' | 'both' | 'employee-only', typed?: boolean) => ({
  ...read,
  state,
  ...(typed === undefined ? {} : { typed }),
});
const measured = (id: Id, overrides: object = {}) => {
  const typed = id === 'unsaved' ? false : undefined;
  return {
    ...{ file: `${id}.docx`, provider: { rewriteCalls: 1, rewriteHits: 1, requests: 3 } },
    ...{ notices: MEASURED[id].notices, cleared: true, config: CLEAN.config, responses: [] },
    arrived: { config: 250, saveFailed: id === 'unsaved' ? 250 : null },
    reads: {
      rewritten: at('agent-only', typed),
      saved: at('both', typed),
      closed: at('both', typed),
    },
    entries: { saved: unchanged, closed: unchanged },
    ...{ allowed: true, editor: session([], ['sw'], []), agent: session(replies, [], []) },
    forgotten: MEASURED[id].forgotten,
    ...overrides,
  };
};
/** The ms from the Agent turn until the refetch and 「保存未写回文件」 arrived; null when they did not. */
type Ms = number | null;
const ms = (config: Ms, saveFailed: Ms) => ({ arrived: { config, saveFailed } });
const typedReads = (typed: boolean) => ({
  reads: {
    rewritten: at('agent-only', typed),
    saved: at('both', typed),
    closed: at('both', typed),
  },
});

it.each([
  ['the clean case as measured', 'clean', measured('clean'), true],
  ['the unsaved case as measured', 'unsaved', measured('unsaved'), true],
  ['the XLSX case as predicted', 'xlsx', measured('xlsx'), true],
  ['the PPTX case as predicted', 'pptx', measured('pptx'), true],
  ['a PPTX save-failed bar', 'pptx', measured('pptx', { notices: UNSAVED.notices }), false],
  ['the typed nonce kept', 'unsaved', measured('unsaved', typedReads(true)), false],
  [
    'the unsaved case without the save-failed bar',
    'unsaved',
    measured('unsaved', { notices: NOTICES }),
    false,
  ],
  ['the save-failed bar not cleared', 'unsaved', measured('unsaved', { cleared: false }), false],
  [
    'the save-failed bar gone at the save',
    'unsaved',
    measured('unsaved', { notices: { ...NOTICES, saveFailed: { ...REFUSED, atSave: false } } }),
    false,
  ],
  [
    'a notice back after the save',
    'clean',
    measured('clean', { notices: { ...NOTICES, staleChanged: { ...unseen, quiet: true } } }),
    false,
  ],
  ['other arrival ms, recorded not fixed', 'unsaved', measured('unsaved', ms(14_750, 5_561)), true],
  ['the refetch not within the bound', 'clean', measured('clean', ms(null, null)), false],
  ['the save-failed bar past the bound', 'unsaved', measured('unsaved', ms(253, null)), false],
  [
    'the save-failed bar first seen after the window',
    'unsaved',
    measured('unsaved', { notices: { ...NOTICES, saveFailed: { ...REFUSED, window: false } } }),
    false,
  ],
  [
    'the clean case with the save-failed bar',
    'clean',
    measured('clean', { notices: { ...NOTICES, saveFailed: REFUSED } }),
    false,
  ],
  [
    'the stale bar seen in the window',
    'unsaved',
    measured('unsaved', {
      notices: { ...UNSAVED.notices, staleChanged: { ...unseen, window: true } },
    }),
    false,
  ],
  [
    'the stale bar already shown',
    'clean',
    measured('clean', { notices: { ...NOTICES, staleChanged: { ...unseen, before: true } } }),
    false,
  ],
  [
    'the removed bar seen in the window',
    'clean',
    measured('clean', { notices: { ...NOTICES, staleRemoved: { ...unseen, window: true } } }),
    false,
  ],
  ['no refetch', 'clean', measured('clean', { config: { open: 1, window: 1, saved: 1 } }), false],
  [
    'a second refetch',
    'unsaved',
    measured('unsaved', { config: { open: 1, window: 2, saved: 3 } }),
    false,
  ],
  [
    'the saved file without the Agent text',
    'clean',
    measured('clean', {
      reads: { rewritten: at('agent-only'), saved: at('employee-only'), closed: at('both') },
    }),
    false,
  ],
  [
    'a late write after the close',
    'clean',
    measured('clean', {
      reads: { rewritten: at('agent-only'), saved: at('both'), closed: at('agent-only') },
    }),
    false,
  ],
  [
    'a temporary file left',
    'unsaved',
    measured('unsaved', {
      entries: { saved: unchanged, closed: { added: ['x.docx.tmp-1'], removed: [] } },
    }),
    false,
  ],
  ['an unallowed editor error', 'clean', measured('clean', { allowed: false }), false],
  ['no copy of the old key', 'unsaved', measured('unsaved', { forgotten: NO_COPY }), false],
  ['a copy from the clean case', 'clean', measured('clean', { forgotten: COPY }), false],
  [
    'the copy not cleared',
    'unsaved',
    measured('unsaved', { forgotten: { ...COPY, cleared: false } }),
    false,
  ],
  ['a failed request', 'clean', measured('clean', { editor: session([], [], ['GET /x']) }), false],
  [
    'an Agent page error',
    'unsaved',
    measured('unsaved', { agent: { ...session(replies, [], []), pageErrors: ['x'] } }),
    false,
  ],
] as const)('expects each case as §60 measured it: %s', (_case, id, evidence, exact) => {
  expect(EXPECTED_REWRITE).toEqual(MEASURED);
  expect(JSON.stringify(rewriteFacts(evidence)) === JSON.stringify(MEASURED[id])).toBe(exact);
});

const after = (ms: number, act: () => unknown) => setTimeout(act, ms);

/**
 * The seam over `stand` after case `id`'s Agent turn. The save's `saved` event clears
 * 「保存未写回文件」; `onSave` is what else the save brings about.
 */
const span = (id: Id, stand: StandIn, onSave?: () => unknown) =>
  noticeSpan(stand.page, {
    ...{ fetched: stand.fetched, open: 1, shown: flagsOf(new Set()) },
    waitSaveFailed: id === 'unsaved',
    save: () => {
      stand.hide('saveFailed');
      onSave?.();
      return Promise.resolve(at('both'));
    },
    afterCleared: () => Promise.resolve(),
    ...{ timeout: TIMEOUT, windowMs: WINDOW_MS },
  });
type Span = Awaited<ReturnType<typeof span>>;
/** What EXPECTED_REWRITE fixes of a case whose post-turn span the seam assembled. */
const spanFacts = (id: Id, { notices, config, arrived, cleared }: Span) =>
  rewriteFacts(measured(id, { notices, config, arrived, cleared }));
/** MEASURED[id] with one notice's one flag changed. */
const flipped = (id: Id, notice: NoticeId, flag: keyof typeof unseen, value: boolean) => {
  const { notices } = MEASURED[id];
  return {
    ...MEASURED[id],
    notices: { ...notices, [notice]: { ...notices[notice], [flag]: value } },
  };
};
// The editor refetches its config, and the unsaved case's notice shows, soon after the turn.
const refreshed = (stand: StandIn, id: Id) =>
  after(10, () => {
    stand.refresh();
    if (id === 'unsaved') stand.show('saveFailed');
  });

it.each(['clean', 'unsaved', 'xlsx', 'pptx'] as const)(
  'assembles the %s case as measured once its refresh and notice arrived',
  async (id) => {
    const stand = standIn();
    refreshed(stand, id);

    const result = await span(id, stand);

    expect(spanFacts(id, result)).toEqual(EXPECTED_REWRITE[id]);
    expect(result.arrived.config).toBeGreaterThanOrEqual(10);
    // Awaited only in the unsaved case, where it shows with the refetch.
    if (id === 'unsaved') expect(result.arrived.saveFailed).toBeGreaterThanOrEqual(10);
    else expect(result.arrived.saveFailed).toBeNull();
    expect(result.afterSave).toEqual(at('both'));
  },
);

it.each([
  ['unsaved', 'saveFailed'],
  ['clean', 'staleChanged'],
] as const)(
  'fails the %s case once %s comes back after the save cleared it',
  async (id, notice) => {
    const stand = standIn();
    refreshed(stand, id);
    // The re-install opens the quiet window; the notice returns halfway through its hold.
    stand.onInstall(() => after(WINDOW_MS / 2, () => stand.show(notice)));

    const result = await span(id, stand);

    expect(spanFacts(id, result)).toEqual(flipped(id, notice, 'quiet', true));
  },
);

it('fails the unsaved case once 「保存未写回文件」 is gone before the save', async () => {
  const stand = standIn();
  refreshed(stand, 'unsaved');
  after(30, () => stand.hide('saveFailed'));

  const result = await span('unsaved', stand);

  expect(spanFacts('unsaved', result)).toEqual(flipped('unsaved', 'saveFailed', 'atSave', false));
});

// After the window, and before the positive wait's second poll.
const LATE = 2 * WINDOW_MS;
// After the positive wait's second poll and the window that would follow it, within the timeout.
const LATE_NOTICE = POLL_MS + 2 * WINDOW_MS;

it('waits for 「保存未写回文件」 later than the refetch and the window, within the timeout', async () => {
  const stand = standIn();
  after(10, stand.refresh);
  after(LATE_NOTICE, () => stand.show('saveFailed'));

  const result = await span('unsaved', stand);

  expect(spanFacts('unsaved', result)).toEqual(EXPECTED_REWRITE.unsaved);
  expect(result.arrived.saveFailed).toBeGreaterThanOrEqual(LATE_NOTICE);
  expect(result.arrived.saveFailed).toBeGreaterThan(result.arrived.config ?? Infinity);
});

it('waits for the unsaved refresh after its notice already latched', async () => {
  const stand = standIn();
  // Shown at the seam's start, so a wait for the notice alone would end at its first poll.
  stand.show('saveFailed');
  after(LATE, stand.refresh);

  const result = await span('unsaved', stand);

  expect(spanFacts('unsaved', result)).toEqual(EXPECTED_REWRITE.unsaved);
  expect(result.arrived.config).toBeGreaterThanOrEqual(LATE);
});

it('waits for a refresh later than the window, within the timeout, and records its arrival', async () => {
  const stand = standIn();
  after(LATE, stand.refresh);

  const result = await span('clean', stand);

  expect(spanFacts('clean', result)).toEqual(EXPECTED_REWRITE.clean);
  expect(result.arrived.config).toBeGreaterThanOrEqual(LATE);
});

it('fails a refresh that misses the timeout and lands only with the save, recording none', async () => {
  const stand = standIn();
  const started = performance.now();

  const result = await span('clean', stand, stand.refresh);

  const [config, arrived] = [
    { open: 1, window: 1, saved: 2 },
    { config: false, saveFailed: false },
  ];
  expect(spanFacts('clean', result)).toEqual({ ...MEASURED.clean, config, arrived });
  expect(result.arrived).toEqual({ config: null, saveFailed: null });
  expect(performance.now() - started).toBeGreaterThanOrEqual(TIMEOUT);
});

it.each([
  ['clean', { config: false, saveFailed: false }],
  ['unsaved', { config: true, saveFailed: false }],
] as const)('fails %s with a positive past the timeout, in the window', async (id, arrived) => {
  const stand = standIn();
  // The clean case's refresh, or the unsaved notice after an early refresh.
  if (id === 'clean') stand.onPastBound(stand.refresh);
  else {
    after(10, stand.refresh);
    stand.onPastBound(() => stand.show('saveFailed'));
  }

  const result = await span(id, stand);

  expect(spanFacts(id, result)).toEqual({ ...MEASURED[id], arrived });
});

it('fails a second refresh inside the window after the awaited one', async () => {
  const stand = standIn();
  stand.refresh();
  after(WINDOW_MS / 2, stand.refresh);

  const result = await span('clean', stand);

  const config = { open: 1, window: 3, saved: 3 };
  expect(spanFacts('clean', result)).toEqual({ ...MEASURED.clean, config });
  expect(result.arrived.config).toBeLessThan(WINDOW_MS / 2);
});

it('fails a refresh inside the quiet window after the save cleared the notices', async () => {
  const stand = standIn();
  refreshed(stand, 'clean');
  stand.onInstall(() => after(WINDOW_MS / 2, stand.refresh));

  const result = await span('clean', stand);

  const config = { open: 1, window: 2, saved: 3 };
  expect(spanFacts('clean', result)).toEqual({ ...MEASURED.clean, config });
});

// #652's typing case as the two patched runs on 6f43c7e measured it (tasks.md 「Patched
// measurement」), written out rather than read from the fixture.
const NONE = { staleChanged: false, staleRemoved: false, saveFailed: false };
const SAVE_FAILED = { ...NONE, saveFailed: true };
const STALE_AND_FAILED = { ...SAVE_FAILED, staleChanged: true };
const MEASURED_TYPING = {
  notices: { before: NONE, window: SAVE_FAILED, saved: NONE, end: NONE },
  latched: { window: STALE_AND_FAILED },
  cleared: true,
  config: { open: 1, window: 2, saved: 2, end: 2 },
  dirty: { available: true, cleanThenCleared: true, refreshRequests: 0 },
  watch: {
    available: true,
    kinds: { change: 1, removed: 0, saved: 1, 'save-error': 1, other: 0 },
  },
  states: ['agent-only', 'both', 'both'],
  typed: [false, false, false],
  entries: { saved: unchanged, closed: unchanged },
  allowed: true,
  forgotten: COPY,
  // #716's prediction, for the exact-head stack to confirm: no notice in the quiet window.
  quietWindow: NONE,
};
const typingReads = (saved: 'agent-only' | 'both') => ({
  rewritten: at('agent-only', false),
  saved: at(saved, false),
  closed: at(saved, false),
});
// tasks.md records the stale latch, dirty false and the banner's clear for each run; the first dirty
// true of a patched run, and the transitions of the second typing, are not recorded and left out:
// only the true→false pair inside the banner's span is asserted.
const UNRECORDED_TRUE = 0;
const typingRun = (stale: readonly [number, number], dirtyFalse: number, saveError: number) =>
  ({
    window: { staleLatched: stale[0], staleCleared: stale[1], dirtyFalse },
    notices: MEASURED_TYPING.notices,
    latched: { window: STALE_AND_FAILED, end: STALE_AND_FAILED },
    ...{ cleared: true, config: MEASURED_TYPING.config },
    dirty: {
      available: true,
      transitions: [
        [UNRECORDED_TRUE, true],
        [dirtyFalse, false],
      ],
      transitionCount: 2,
      refreshRequests: { total: 0, afterSave: 0 },
    },
    watch: { available: true, kinds: MEASURED_TYPING.watch.kinds, saveErrors: [saveError] },
    host: { available: false, reason: 'no earlier line' },
    ...{ reads: typingReads('both'), entries: { saved: unchanged, closed: unchanged } },
    allowed: true,
    forgotten: COPY,
    quietWindow: NONE,
  }) as const;
const PATCHED = [typingRun([1433, 2594], 2582, 7956), typingRun([1886, 2832], 2818, 8181)] as const;
const [PATCHED_A] = PATCHED;
// Step 1 on f95bb48, unpatched. Transcribed from tasks.md 2.1: the times, config 1 throughout, no
// refresh request, one save-error after Ctrl+S, 「保存未写回文件」 at the save and the end, the file the
// Agent's in all three reads, no copy. Derived from that record, not printed in it: no notice at the
// window's end (the banner cleared at dirty false, the save error came later), so none latched
// there but the banner, `cleared` false, watch kinds `change` 1, `saved` 0, and the notice still
// shown at the re-arm seen in the quiet window. The rejection does not rest on them: config, the
// states and the saved and end notices differ alone.
const unpatched = (times: readonly [number, number, number, number], saveError: number) => {
  const [dirtyTrue, staleLatched, dirtyFalse, staleCleared] = times;
  const latchedStale = { ...NONE, staleChanged: true };
  return {
    ...PATCHED_A,
    window: { staleLatched, staleCleared, dirtyFalse },
    notices: { before: NONE, window: NONE, saved: SAVE_FAILED, end: SAVE_FAILED },
    latched: { window: latchedStale, end: STALE_AND_FAILED },
    ...{ cleared: false, config: { open: 1, window: 1, saved: 1, end: 1 } },
    dirty: {
      ...PATCHED_A.dirty,
      transitions: [
        [dirtyTrue, true],
        [dirtyFalse, false],
      ] as const,
    },
    watch: {
      ...{ available: true as const, kinds: { ...MEASURED_TYPING.watch.kinds, saved: 0 } },
      saveErrors: [saveError],
    },
    reads: typingReads('agent-only'),
    quietWindow: SAVE_FAILED,
  };
};
const UNPATCHED = [
  unpatched([709, 1509, 2499, 2500], 17142),
  unpatched([466, 1067, 2272, 2272], 16701),
] as const;
const patchedWith = (overrides: object) => ({ ...PATCHED_A, ...overrides });
const dirtyWith = (overrides: object) =>
  patchedWith({ dirty: { ...PATCHED_A.dirty, ...overrides } });
const kindsWith = (overrides: object) =>
  patchedWith({
    watch: { ...PATCHED_A.watch, kinds: { ...MEASURED_TYPING.watch.kinds, ...overrides } },
  });

it.each([
  ['patched run a', PATCHED_A],
  ['patched run b, other times in the same order', PATCHED[1]],
  [
    'with the host signal available',
    patchedWith({ host: { available: true, control: 1, beforeClose: 'read failed' } }),
  ],
  [
    'another first dirty true',
    dirtyWith({
      transitions: [
        [2000, true],
        [2582, false],
      ],
    }),
  ],
] as const)('expects the typing case as the patched runs measured it: %s', (_case, evidence) => {
  expect(EXPECTED_TYPING).toEqual(MEASURED_TYPING);
  expect(typingFacts(evidence)).toEqual(EXPECTED_TYPING);
});

it.each([
  ['step-1 run a, unpatched', UNPATCHED[0]],
  ['step-1 run b, unpatched', UNPATCHED[1]],
  ['no refresh', patchedWith({ config: { open: 1, window: 1, saved: 1, end: 1 } })],
  ['a second refresh', patchedWith({ config: { open: 1, window: 2, saved: 2, end: 3 } })],
  ['a refresh request', dirtyWith({ refreshRequests: { total: 1, afterSave: 1 } })],
  ['the dirty signal unavailable', patchedWith({ dirty: { available: false, control: {} } })],
  ['no true→false transition', dirtyWith({ transitions: [[UNRECORDED_TRUE, true]] })],
  [
    'dirty false after the banner cleared',
    patchedWith({ window: { ...PATCHED_A.window, staleCleared: 2581 } }),
  ],
  [
    'dirty false before the banner latched',
    patchedWith({ window: { ...PATCHED_A.window, staleLatched: 2583 } }),
  ],
  [
    'the banner never cleared',
    patchedWith({ window: { ...PATCHED_A.window, staleCleared: null } }),
  ],
  ['the watch signal unavailable', patchedWith({ watch: { available: false, control: {} } })],
  ['a second save error', kindsWith({ 'save-error': 2 })],
  ['no saved event', kindsWith({ saved: 0 })],
  ['a removed event', kindsWith({ removed: 1 })],
  ['the stale banner not latched', patchedWith({ latched: { window: SAVE_FAILED } })],
  [
    'no save-failed bar in the window',
    patchedWith({ notices: { ...MEASURED_TYPING.notices, window: NONE } }),
  ],
  [
    'the save-failed bar after the save',
    patchedWith({ notices: { ...MEASURED_TYPING.notices, saved: SAVE_FAILED } }),
  ],
  ['the notices not cleared', patchedWith({ cleared: false })],
  ["the saved file the Agent's only", patchedWith({ reads: typingReads('agent-only') })],
  [
    'the in-window typing kept',
    patchedWith({ reads: { ...typingReads('both'), saved: at('both', true) } }),
  ],
  [
    'a copy left',
    patchedWith({
      entries: { saved: { added: ['键入改写 (1).docx'], removed: [] }, closed: unchanged },
    }),
  ],
  ['an unallowed editor error', patchedWith({ allowed: false })],
  ['a notice in the quiet window', patchedWith({ quietWindow: SAVE_FAILED })],
  ['no copy of the refreshed-away key', patchedWith({ forgotten: NO_COPY })],
  ['the copy not cleared', patchedWith({ forgotten: { ...COPY, cleared: false } })],
] as const)('rejects a typing case unlike the patched runs: %s', (_case, evidence) => {
  expect(typingFacts(evidence)).not.toEqual(EXPECTED_TYPING);
});

const STATE = 'onDocumentStateChange';
/**
 * The typing case on `stand` from its save on, as the patched runs measured it: the stale banner
 * latched and cleared around the editor's dirty true→false, 「保存未写回文件」 shown until the save
 * landed. The seam's span, in a patched run's evidence, as EXPECTED_TYPING fixes it.
 */
async function typedSave(stand: StandIn) {
  const origin = Date.now();
  stand.refresh();
  stand.show('staleChanged');
  stand.show('saveFailed');
  const dirtyFalse = Date.now();
  stand.hide('staleChanged');
  const dirty = (value: boolean, time: number) => ({ event: STATE, dirty: value, at: time });
  const events = [dirty(true, origin), dirty(false, dirtyFalse)];
  stand.frames({ messages: 2, parsed: 2, malformed: 0, events });
  const result = await typingSaved(stand.page, {
    marks: { origin, execStart: origin, execEnd: origin, lastKey: origin },
    ...{ savedAt: Date.now(), fetched: stand.fetched },
    landed: () => {
      stand.hide('saveFailed');
      return Promise.resolve(at('both', false));
    },
    afterCleared: () => Promise.resolve('listed'),
    ...{ timeout: TIMEOUT, windowMs: WINDOW_MS },
  });
  const { notices, latched, config, cleared, window, quietWindow } = result;
  const facts = typingFacts({
    ...{ ...PATCHED_A, notices: { ...PATCHED_A.notices, ...notices } },
    ...{
      latched: { ...PATCHED_A.latched, ...latched },
      config: { ...PATCHED_A.config, ...config },
    },
    ...{ cleared, window, dirty: result.dirty, quietWindow },
  });
  return { result, facts };
}

it('assembles the typing case after its save as measured, its facts read before the re-arm', async () => {
  const stand = standIn();

  const { result, facts } = await typedSave(stand);

  expect(facts).toEqual(EXPECTED_TYPING);
  expect(result.latched.end).toEqual(STALE_AND_FAILED);
  expect(result.after).toBe('listed');
});

it('fails the typing case once a notice comes back in the quiet window after the clear', async () => {
  const stand = standIn();
  // The re-arm opens the quiet window; the notice returns halfway through its hold.
  stand.onInstall(() => after(WINDOW_MS / 2, () => stand.show('saveFailed')));

  const { facts } = await typedSave(stand);

  expect(facts).toEqual({ ...EXPECTED_TYPING, quietWindow: SAVE_FAILED });
});

const KEY = 'e5'.repeat(32);
const SOCKET = `${BASE}/doc/${KEY}/c/?EIO=4&transport=polling`;
const reply = (value: unknown) => Promise.resolve(JSON.stringify(value));
const fresh = { size: 9, sha256: 'a'.repeat(64) };
/** A's instance as the rewrite lane drives it before and after the clean case's browser session. */
const rewriteLane = {
  session: { base: BASE, directory: DIR, email: 'a@x.test', password: 'p', timeout: 500 },
  exec: (args: readonly string[]) => {
    const [, , script, path = '', ...rest] = args;
    if (script === HEALTH_COMMAND[2]) return reply({ status: 200, body: 'true' });
    if (script === READER)
      return reply({ texts: { 'word/document.xml': '改写探针：开头只有这一段。' }, ...fresh });
    if (script === docxCommand('')[2]) return reply({ name: path.split('/').pop(), ...fresh });
    // withWorkFiles' removal: the work directory, then each name.
    return reply(rest.map(() => false));
  },
  // The forgotten store through host Docker: its count, and one removal; nothing else.
  run: (args: string[]) => {
    if (args.slice(0, 3).join(' ') !== `exec ${DOCUMENT_SERVER} sh`)
      return Promise.reject(new Error('no host Docker before the typing case'));
    return Promise.resolve(
      args[4]?.includes('rm -rf') === true ? '{"matched":1}' : '{"matched":0}',
    );
  },
  namespaceRead: () => Promise.reject(new Error('no namespace read before the session closes')),
  provider: () =>
    Promise.resolve({ rewriteCalls: [0, 0, 0, 0], rewriteHits: [0, 0, 0, 0], requests: 0 }),
  ...{ instance: 'dsh-team-u-a', reply: 'reply', rewrites: ownedRewrites() },
};

it('leaves a failed rewrite session without the key or query anywhere it is printed', async () => {
  const cause = new Error(`page.goto: net::ERR_ABORTED at ${SOCKET}`, {
    cause: new Error(`frame ${SOCKET}`),
  });
  const evidence = {
    ...session(['office-rewrite-clean-failure.png'], [`WebSocket ${SOCKET} failed`], []),
    ...{ failedRequests: [`GET ${SOCKET}`], externalRequests: [SOCKET] },
  };
  vi.mocked(workbenchSession).mockImplementation((_session, names) =>
    Promise.reject(new StackWorkbenchFailure(cause, evidence, names.label)),
  );

  const error = await officeRewriteScenario(rewriteLane).catch((caught: unknown) => caught);

  const printed = everythingPrinted(error);
  for (const secret of [KEY, 'EIO=4', 'transport=']) expect(printed).not.toContain(secret);
  const counts = 'consoleErrors=1 pageErrors=0 failedRequests=1 externalRequests=1';
  const socket = `${BASE}/doc/<redacted>/c/`;
  expect(error).toBeInstanceOf(StackWorkbenchFailure);
  expect(error).toHaveProperty(
    'message',
    `Stack workbench office rewrite clean failed (${counts}): page.goto: net::ERR_ABORTED at ${socket} <- frame ${socket}`,
  );
});

it('masks the save-error notice in every screenshot of the clean and unsaved sessions', async () => {
  vi.mocked(workbenchSession).mockRejectedValue(new Error('stand-in browser'));

  await expect(officeRewriteScenario(rewriteLane)).rejects.toThrow('stand-in browser');

  // `clean` and `unsaved` pass the same `names` expression; the clean case is the one reached.
  const [[, names] = []] = vi.mocked(workbenchSession).mock.calls;
  expect(names?.label).toBe('office rewrite clean');
  expect(names?.masked ?? []).toContain(NOTICE_TEXTS.saveFailed);
});

it('clears the open key after a failed clean session and rethrows its failure unchanged', async () => {
  const calls: string[][] = [];
  const lane = {
    ...rewriteLane,
    // A's registry names the DOCX once the editor is open.
    exec: (args: readonly string[]) =>
      args[4] === REGISTRY ? reply([KEY]) : rewriteLane.exec(args),
    run: (args: string[]) => {
      calls.push(args);
      return rewriteLane.run(args);
    },
  };
  const evidence = session([], [`WebSocket ${SOCKET} failed`], [`GET ${SOCKET}`]);
  let failure: StackWorkbenchFailure | undefined;
  vi.mocked(openHinted).mockResolvedValue(undefined);
  // The body runs: the editor opens and its key is read, then the page dies before the Agent turn.
  vi.mocked(workbenchSession).mockImplementation(async (_session, names, body) => {
    const page = {} as Parameters<typeof body>[0]; // a page whose every call fails
    const passed = () => Promise.resolve();
    const cause = await body(page, passed, passed).then(
      () => new Error('session body did not fail'),
      (error: unknown) => error,
    );
    failure = new StackWorkbenchFailure(cause, evidence, names.label);
    throw failure;
  });

  const error = await officeRewriteScenario(lane, () => Promise.resolve()).catch(
    (caught: unknown) => caught,
  );

  expect(failure).toBeDefined();
  expect(error).toBe(failure);
  expect(error).toBeInstanceOf(StackWorkbenchFailure);
  expect(everythingPrinted(error)).not.toContain(KEY);
  const removals = calls.filter((args) => args[4]?.includes('rm -rf') === true);
  expect(removals).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain(KEY);
});

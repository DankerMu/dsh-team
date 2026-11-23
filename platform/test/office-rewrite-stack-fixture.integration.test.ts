import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { editorNonce, NONCE_PATTERN, READER } from './office-editor-stack-fixture.ts';
import { docxCommand, HEALTH_COMMAND } from './office-hints-stack-fixture.ts';
import {
  EXPECTED_REWRITE,
  EXPECTED_TYPING,
  heldApart,
  NOTICES as NOTICE_TEXTS,
  officeRewriteLine,
  officeRewriteScenario,
  ownedRewrites,
  REWRITER,
  rewriteArgv,
  rewriteCommand,
  rewriteFacts,
  rewriteState,
  typingFacts,
} from './office-rewrite-stack-fixture.ts';
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
afterEach(() => {
  vi.mocked(workbenchSession).mockReset();
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

const PATH = '/data/work/干净改写.docx';

it('hands bash python3, the rewriter, the file and the nonce as single-quoted words', () => {
  const command = rewriteCommand('干净改写.docx', AGENT);

  const words = execFileSync('sh', ['-c', `printf '%s\\0' ${command}`]).toString();

  expect(REWRITER).not.toContain("'");
  expect(rewriteArgv('干净改写.docx', AGENT)).toEqual(['python3', '-c', REWRITER, PATH, AGENT]);
  expect(command).toBe(`'python3' '-c' '${REWRITER}' '${PATH}' '${AGENT}'`);
  expect(words.split('\0')).toEqual(['python3', '-c', REWRITER, PATH, AGENT, '']);
  expect(() => rewriteCommand("x'.docx", AGENT)).toThrow('Bash word holds a single quote');
});

// A stand-in for python-docx, which the CI host lacks: a document is its lines, one per paragraph.
const FAKE_DOCX = `class Document:
    def __init__(self, path):
        self.paragraphs = open(path, encoding="utf-8").read().splitlines()
    def add_paragraph(self, text):
        self.paragraphs.append(text)
    def save(self, path):
        open(path, "w", encoding="utf-8").write("\\n".join(self.paragraphs) + "\\n")`;

it('appends the nonce as a paragraph, saves the file in place and prints the nonce', () => {
  writeFileSync(join(DIR, 'docx.py'), FAKE_DOCX);
  const file = join(DIR, '改写.docx');
  writeFileSync(file, '改写探针。\n');

  // `-c` puts the working directory first on the module path: the stand-in shadows python-docx.
  const out = execFileSync('python3', ['-c', REWRITER, file, AGENT], { cwd: DIR }).toString();

  expect(out).toBe(`${AGENT}\n`);
  expect(readFileSync(file, 'utf8')).toBe(`改写探针。\n${AGENT}\n`);
});

it('scripts one rewrite per case file, each with its own marker and nonce', () => {
  const scripts = ownedRewrites();

  const [clean, unsaved] = scripts;
  const fresh = ownedRewrites().map(({ nonce }) => nonce);

  expect(scripts).toHaveLength(2);
  expect([clean?.command, unsaved?.command]).toEqual([
    rewriteCommand('干净改写.docx', clean?.nonce ?? ''),
    rewriteCommand('未保存改写.docx', unsaved?.nonce ?? ''),
  ]);
  for (const { marker, nonce } of scripts) {
    expect(nonce).toMatch(new RegExp(`^${NONCE_PATTERN.source}$`));
    expect(marker).toMatch(/^stack-rewrite-[0-9a-f-]{36}$/);
  }
  const values = scripts.flatMap(({ marker, nonce }) => [marker, nonce]);
  expect(new Set([...values, ...fresh]).size).toBe(6);
});

const BASE = 'http://127.0.0.1:64694';
const DS = '/sidebar/onlyoffice/ds/9.4.0-c83aecd3de42866b80ccf786af6354d6';
// A 24-character run that is not a lowercase word, as a key or token in a URL would be.
const LONG_RUN = 'Ab1'.repeat(8);
const FETCH = 'A bad HTTP response code (403) was received when fetching the script.';
const session = (screenshots: string[], consoleErrors: string[], failedRequests: string[]) => ({
  ...{ screenshots, consoleErrors, pageErrors: [], failedRequests, externalRequests: [] },
  ...{ requests: 40, websockets: 2 },
});
const read = { state: 'both', size: 9_000, sha256: 'b'.repeat(64) } as const;
const unchanged = { added: [], removed: [] };
const unseen = { before: false, window: false, saved: false };
// The plugin's three notices above the editor, none shown, latched or seen until the save landed.
const NOTICES = { staleChanged: unseen, staleRemoved: unseen, saveFailed: unseen };
const replies = ['login.png', 'workbench.png', 'reply.png'];
const quiet = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };

it('prints each case without nonces, keys or queries: errors and failures scrubbed, sessions counted', () => {
  const editor = session(
    ['office-rewrite-clean-open.png', 'office-rewrite-clean-saved.png'],
    [FETCH, `GET ${BASE}/sidebar/onlyoffice/file?token=${LONG_RUN} ${AGENT}`],
    [`GET ${BASE}${DS}/x.json#${LONG_RUN}`],
  );
  const observed = {
    ...{ file: '干净改写.docx', provider: { rewriteCalls: 1, rewriteHits: 1, requests: 3 } },
    ...{
      notices: NOTICES,
      cleared: true,
      config: { open: 1, window: 2, saved: 2 },
    },
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

  const shown = { staleChanged: false, staleRemoved: false, saveFailed: true };
  const typingObserved = {
    ...{ file: '键入改写.docx', provider: { requests: 9, searches: 0, delegations: 0 } },
    window: {
      ...{ execStart: 5, execEnd: 900, lastKey: 1_400 },
      ...{ staleLatched: 1_300, staleCleared: null, dirtyFalse: 'unavailable' },
    },
    ...{ notices: { before: shown, window: shown, saved: shown, end: shown } },
    ...{ latched: { window: shown, end: shown }, cleared: false },
    config: { open: 1, window: 1, saved: 1, end: 1 },
    dirty: { available: false, control: { messages: 3, parsed: 3, malformed: 0, stateChanges: 0 } },
    watch: { available: true, kinds: { change: 1, 'save-error': 2 }, saveErrors: [20, 30] },
    host: { available: false, reason: 'no earlier line' },
    reads: { rewritten: read, saved: read, closed: read },
    entries: { saved: unchanged, closed: unchanged },
    allowed: true,
  } as const;
  const typing = { ...typingObserved, responses, editor };

  const line = officeRewriteLine({ clean, unsaved, typing });

  const printed = {
    ...observed,
    responses: [
      '403 /sidebar/onlyoffice/ds/9.4.<redacted>/document_editor_service_worker.js',
      '404 /cache/files/data/<redacted>/x',
    ],
    editor: {
      ...{ screenshots: editor.screenshots, consoleErrors: 2, pageErrors: 0 },
      ...{ failedRequests: 1, externalRequests: 0 },
      errors: [FETCH, `GET ${BASE}/sidebar/onlyoffice/file <redacted>`],
      failed: [`GET ${BASE}/sidebar/onlyoffice/ds/9.4.<redacted>/x.json`],
    },
    agent: { screenshots: replies, consoleErrors: 0, ...quiet },
  };
  expect(line).toEqual({
    clean: printed,
    unsaved: { ...printed, file: '未保存改写.docx', reads },
    typing: { ...typingObserved, responses: printed.responses, editor: printed.editor },
  });
  for (const secret of [LONG_RUN, AGENT, 'token'])
    expect(JSON.stringify(line)).not.toContain(secret);
  expect(() => officeRewriteLine(undefined)).toThrow('Office rewrite evidence missing');
});

// §60's measured values (step 1 and review round 1), written out rather than read from the fixture.
const CLEAN = {
  notices: NOTICES,
  cleared: true,
  config: { open: 1, window: 2, saved: 2 },
  states: ['agent-only', 'both', 'both'],
  typed: [false, false, false],
  entries: { saved: unchanged, closed: unchanged },
  allowed: true,
  sessions: [quiet, quiet],
};
// The old key's status 2 with the discarded edit is refused: 「保存未写回文件」 shows until the save.
const REFUSED = { before: false, window: true, saved: true };
const UNSAVED = { ...CLEAN, notices: { ...NOTICES, saveFailed: REFUSED } };
const MEASURED = { clean: CLEAN, unsaved: UNSAVED };
const at = (state: 'agent-only' | 'both' | 'employee-only', typed?: boolean) => ({
  ...read,
  state,
  ...(typed === undefined ? {} : { typed }),
});
const measured = (id: 'clean' | 'unsaved', overrides: object = {}) => {
  const typed = id === 'unsaved' ? false : undefined;
  return {
    ...{ file: `${id}.docx`, provider: { rewriteCalls: 1, rewriteHits: 1, requests: 3 } },
    ...{ notices: MEASURED[id].notices, cleared: true, config: CLEAN.config, responses: [] },
    reads: {
      rewritten: at('agent-only', typed),
      saved: at('both', typed),
      closed: at('both', typed),
    },
    entries: { saved: unchanged, closed: unchanged },
    ...{ allowed: true, editor: session([], ['sw'], []), agent: session(replies, [], []) },
    ...overrides,
  };
};
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
  ['the typed nonce kept', 'unsaved', measured('unsaved', typedReads(true)), false],
  [
    'the unsaved case without the save-failed bar',
    'unsaved',
    measured('unsaved', { notices: NOTICES }),
    false,
  ],
  ['the save-failed bar not cleared', 'unsaved', measured('unsaved', { cleared: false }), false],
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
  }) as const;
const PATCHED = [typingRun([1433, 2594], 2582, 7956), typingRun([1886, 2832], 2818, 8181)] as const;
const [PATCHED_A] = PATCHED;
// Step 1 on f95bb48, unpatched. Transcribed from tasks.md 2.1: the times, config 1 throughout, no
// refresh request, one save-error after Ctrl+S, 「保存未写回文件」 at the save and the end, the file the
// Agent's in all three reads, no copy. Derived from that record, not printed in it: no notice at the
// window's end (the banner cleared at dirty false, the save error came later), so none latched
// there but the banner, `cleared` false, and watch kinds `change` 1, `saved` 0. The rejection does
// not rest on them: config, the states and the saved and end notices differ alone.
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
] as const)('rejects a typing case unlike the patched runs: %s', (_case, evidence) => {
  expect(typingFacts(evidence)).not.toEqual(EXPECTED_TYPING);
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
  run: () => Promise.reject(new Error('no host Docker before the typing case')),
  provider: () => Promise.resolve({ rewriteCalls: [0, 0], rewriteHits: [0, 0], requests: 0 }),
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

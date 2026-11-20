import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { editorNonce, NONCE_PATTERN } from './office-editor-stack-fixture.ts';
import {
  EXPECTED_REWRITE,
  officeRewriteLine,
  ownedRewrites,
  REWRITER,
  rewriteCommand,
  rewriteFacts,
  rewriteState,
} from './office-rewrite-stack-fixture.ts';

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

const PATH = '/data/work/干净改写.docx';

it('hands bash python3, the rewriter, the file and the nonce as single-quoted words', () => {
  const command = rewriteCommand('干净改写.docx', AGENT);

  const words = execFileSync('sh', ['-c', `printf '%s\\0' ${command}`]).toString();

  expect(REWRITER).not.toContain("'");
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

  const line = officeRewriteLine({ clean, unsaved });

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

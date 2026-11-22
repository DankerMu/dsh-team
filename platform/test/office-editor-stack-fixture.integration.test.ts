import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from '@playwright/test';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { docxCommand, HEALTH_COMMAND } from './office-hints-stack-fixture.ts';
import {
  bothOpen,
  editorErrorsAllowed,
  editorNonce,
  editorRefused,
  EXPECTED_DELTAS,
  gate,
  NONCE_PATTERN,
  officeEditorLine,
  officeEditorScenario,
  providerDeltas,
  READ_BACK_COMMAND,
  READER,
  retiringOnError,
  sameNameState,
  writeArgv,
  writeBackState,
} from './office-editor-stack-fixture.ts';
import type { OfficeEditorLane } from './office-editor-stack-fixture.ts';
import {
  aGuessScript,
  bCrossScript,
  EXPECTED_INFO,
  namespaceInfoScript,
  NODE,
} from './office-isolation-stack-fixture.ts';
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

const NONCE = editorNonce();
const EXTS = ['docx', 'xlsx', 'pptx'];
const PATHS = EXTS.map((ext) => `/data/work/编辑写回.${ext}`);
const DIR = mkdtempSync(join(tmpdir(), 'dsh-team-office-editor-'));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});
const python = (...argv: string[]) => execFileSync('python3', ['-I', '-c', ...argv]).toString();
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
// A zip of `parts` (a name, then its content) written by Python's own zipfile.
const ZIP = `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for name, text in zip(sys.argv[2::2], sys.argv[3::2]):
        archive.writestr(name, text)`;
const zipped = (file: string, ...parts: string[]) => {
  python(ZIP, join(DIR, file), ...parts);
  return join(DIR, file);
};

it('generates EDITOR and 32 uppercase hex digits, which the exported pattern matches', () => {
  expect(NONCE).toMatch(/^EDITOR[0-9A-F]{32}$/);
  expect(editorNonce()).not.toBe(NONCE);
  expect(NONCE.match(NONCE_PATTERN)?.[0]).toBe(NONCE);
  expect(`EDITOR${'A'.repeat(31)}`).not.toMatch(NONCE_PATTERN);
  expect(NONCE.toLowerCase()).not.toMatch(NONCE_PATTERN);
});

it('writes the one-paragraph docx, or the base64 bytes of a template, and reads the digest', () => {
  expect(writeArgv('编辑写回.docx')).toEqual(docxCommand('编辑写回.docx', '编辑写回探针。'));
  expect(writeArgv('编辑写回.xlsx', 'UEsD').slice(3)).toEqual([PATHS[1], '--base64', 'UEsD']);
  const [, , script = ''] = writeArgv('编辑写回.pptx', '');
  const bytes = Buffer.from([0x50, 0x4b, 0, 255, 10]);
  const out = python(script, join(DIR, 'w.pptx'), '--base64', bytes.toString('base64'));
  expect(readFileSync(join(DIR, 'w.pptx'))).toEqual(bytes);
  expect(JSON.parse(out)).toEqual({ name: 'w.pptx', size: 5, sha256: sha256(join(DIR, 'w.pptx')) });
});

const DOCUMENT = (...runs: string[]) =>
  `<w:document xmlns:w="urn:w"><w:body><w:p>${runs.map((run) => `<w:r><w:t>${run}</w:t></w:r>`).join('<w:tab/><w:instrText> PAGE </w:instrText>')}</w:p></w:body></w:document>`;
const RELS = '<Relationships xmlns="urn:r"><Relationship Id="t" Target="t"/></Relationships>';

it('joins the text of every element named t in each XML part and skips other parts', () => {
  const cell = '<sst xmlns="urn:s"><si><t>甲</t></si><c t="s"><v>0</v></c><si><t>乙</t></si></sst>';
  const parts = ['word/document.xml', DOCUMENT('编辑写回', '探针。'), '_rels/.rels', RELS];
  const docx = zipped('reader.docx', ...parts, 'xl/x.xml', cell, 'media/x.bin', '<not xml');
  const texts = { 'word/document.xml': '编辑写回探针。', '_rels/.rels': '', 'xl/x.xml': '甲乙' };
  const digest = { size: readFileSync(docx).length, sha256: sha256(docx) };
  expect(JSON.parse(python(READER, docx))).toEqual({ texts, ...digest });
});

it('hands bash the reader over the three paths as single-quoted words, never a nonce', () => {
  expect(READER).not.toContain("'");
  expect(READ_BACK_COMMAND).toBe(`'python3' '-c' '${READER}' '${PATHS.join("' '")}'`);
  const words = execFileSync('sh', ['-c', `printf '%s\\0' ${READ_BACK_COMMAND}`]).toString();
  expect(words.split('\0')).toEqual(['python3', '-c', READER, ...PATHS, '']);
  expect(READ_BACK_COMMAND).not.toMatch(NONCE_PATTERN);
});

it('prints only the nonce-shaped strings all three files hold', () => {
  const other = editorNonce();
  const [head, tail] = [NONCE.slice(0, 10), NONCE.slice(10)];
  const docx = zipped('a.docx', 'word/document.xml', DOCUMENT('探针。', head, tail));
  const xlsx = zipped('a.xlsx', 'xl/sharedStrings.xml', `<t>${other} ${NONCE}</t>`);
  const slide = (text: string) => `<a:p xmlns:a="urn:a"><a:t>Click</a:t><a:t>${text}</a:t></a:p>`;
  const pptx = zipped('a.pptx', 'ppt/slides/slide1.xml', slide(`${NONCE}${other.slice(0, 6)}`));
  expect(python(READER, docx, xlsx, pptx)).toBe(`${NONCE}\n`);
  const without = zipped('b.pptx', 'ppt/slides/slide1.xml', slide(other));
  expect(python(READER, docx, xlsx, without)).toBe('');
});

const [ORIGINAL, CHANGED] = ['a'.repeat(64), 'b'.repeat(64)];
// Each paragraph as one part's text.
const read = (sha256: string, paragraphs: string[]) => ({
  ...{ texts: Object.fromEntries(paragraphs.entries()), size: 9_000, sha256 },
});

it.each([
  ['the digest unchanged', read(ORIGINAL, ['编辑写回探针。']), 'unchanged'],
  ['the digest unchanged, whatever it reads', read(ORIGINAL, [NONCE]), 'unchanged'],
  ['a new digest without the nonce', read(CHANGED, ['编辑写回探针。']), 'changed-without-nonce'],
  ['a new digest without paragraphs', read(CHANGED, []), 'changed-without-nonce'],
  ['a new digest and the nonce in a paragraph', read(CHANGED, [`探针。${NONCE}`]), 'saved'],
  ['the nonce in a middle paragraph', read(CHANGED, ['编辑写回探针。', NONCE, '']), 'saved'],
])('reads the write-back as %s', (_case, observed, state) => {
  expect(writeBackState(ORIGINAL, observed, NONCE)).toBe(state);
});

// 51.2's exact deltas, written out rather than read from the fixture.
const EXACT = { readBacks: 1, readBackHits: 1, requests: 3, searches: 0, delegations: 0 };
const health = { ready: true, requests: 10, searches: 1, delegations: 1 };
const before = { ...health, readBacks: 0, readBackHits: 0 };

it.each([
  ['the read-back turn alone', { readBacks: 1, readBackHits: 1, requests: 13 }, true],
  ['a late request', { readBacks: 1, readBackHits: 1, requests: 14 }, false],
  ['no hit', { readBacks: 1, readBackHits: 0, requests: 13 }, false],
  ['a second hit', { readBacks: 1, readBackHits: 2, requests: 13 }, false],
  ['a search', { readBacks: 1, readBackHits: 1, requests: 13, searches: 2 }, false],
  ['a delegation', { readBacks: 1, readBackHits: 1, requests: 13, delegations: 2 }, false],
  ['no read-back counters', { requests: 13 }, false],
])('expects one read-back, one hit, three requests and no retrieval: %s', (_case, after, exact) => {
  const deltas = providerDeltas(before, { ...health, ...after });
  expect(EXPECTED_DELTAS).toEqual(EXACT);
  expect(Object.keys(deltas)).toEqual(Object.keys(EXACT));
  expect(JSON.stringify(deltas) === JSON.stringify(EXACT)).toBe(exact);
});

const settled = (promise: Promise<unknown>) =>
  promise.then(
    () => 'released',
    (error: unknown) => (error instanceof Error ? error.message : ''),
  );

it('releases both sides once both arrived, running whenBoth once before', async () => {
  const events: string[] = [];
  const { arrive } = gate(['A', 'B'], 1_000, () => Promise.resolve(void events.push('both')));
  const a = arrive('A').then(() => events.push('A'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual([]);
  await Promise.all([a, arrive('B').then(() => events.push('B'))]);
  expect(events).toEqual(['both', 'A', 'B']);
});

it('rejects a lone arrival after the timeout, naming the side that arrived', async () => {
  const started = performance.now();
  const lone = await settled(gate(['A', 'B'], 30).arrive('B'));
  expect(lone).toMatch(/after 30ms, only B arrived/);
  expect(performance.now() - started).toBeGreaterThanOrEqual(25);
});

it('rejects the waiting side and every later arrival at once after a failure', async () => {
  const calls: string[] = [];
  const { arrive, fail } = gate(['A', 'B'], 60_000, () => Promise.resolve(void calls.push('both')));
  const started = performance.now();
  const waiting = settled(arrive('A'));
  fail(new Error('B opened nothing'));
  expect(await waiting).toBe('Office editor gate closed: B opened nothing');
  expect(await settled(arrive('B'))).toBe('Office editor gate closed: B opened nothing');
  expect([performance.now() - started < 1_000, calls]).toEqual([true, []]);
});

it('ignores a failure after the release', async () => {
  const { arrive, fail } = gate(['A', 'B'], 1_000);
  await Promise.all([arrive('A'), arrive('B')]);
  fail(new Error('late'));
  expect(await settled(arrive('A'))).toBe('released');
});

it('rejects both sides when whenBoth fails', async () => {
  let calls = 0;
  const { arrive } = gate(['A', 'B'], 1_000, () => {
    calls++;
    return Promise.reject(new Error('Office editor keys equal'));
  });
  const sides = await Promise.all([settled(arrive('A')), settled(arrive('B'))]);
  expect(sides).toEqual(['Office editor keys equal', 'Office editor keys equal']);
  expect(calls).toBe(1);
});

it('keeps the release when whenBoth outlasts the timeout', async () => {
  const { arrive } = gate(['A', 'B'], 30, () => new Promise((resolve) => setTimeout(resolve, 60)));
  const later = new Promise((resolve) => setTimeout(resolve, 10)).then(() => settled(arrive('B')));
  expect(await Promise.all([settled(arrive('A')), later])).toEqual(['released', 'released']);
});

const KEYS = {
  kA: 'a1'.repeat(32),
  kB: 'b1'.repeat(32),
  k0: 'c0'.repeat(32),
  kCross: 'd1'.repeat(32),
};
const INPUT = ['dsh-team-u-a', PATHS[0], '9', '1700000000000'].join('\0');
/** A and B answering their registry with one key each, A's recompute and B's kCross; each call's
 * step and argv go to `calls` in call order. */
function openSides(calls: string[][]) {
  const side = (name: 'A' | 'B', key: string, reply: object) => ({
    exec: (args: readonly string[]) => {
      const registry = args[0] === 'python3';
      calls.push([`${name} ${registry ? 'registry' : 'script'}`, ...args]);
      return Promise.resolve(JSON.stringify(registry ? [key] : reply));
    },
  });
  const holder = (script: string) => {
    calls.push(['holder', script]);
    return Promise.resolve({ ...EXPECTED_INFO });
  };
  const a = side('A', KEYS.kA, { k1: KEYS.kA, k0: KEYS.k0, input: INPUT });
  return [{ ...a, namespaceRead: holder }, side('B', KEYS.kB, { kCross: KEYS.kCross })] as const;
}

it("with both editors open reads A's then B's registry, recomputes A, derives kCross in B and asks the holder", async () => {
  const calls: string[][] = [];
  const met = { distinct: false, info: {} };

  await bothOpen(...openSides(calls), met);

  const steps = ['A registry', 'B registry', 'A script', 'B script', 'holder'];
  expect(calls.map(([step]) => step)).toEqual(steps);
  const [, , [, ...recompute] = [], [, ...cross] = [], [, script] = []] = calls;
  expect(recompute).toEqual([...NODE, aGuessScript(PATHS[0] ?? '')]);
  expect(cross).toEqual([...NODE, bCrossScript(), JSON.stringify(INPUT)]);
  const { kA: k1, kB, k0, kCross } = KEYS;
  expect(script).toBe(namespaceInfoScript({ k1, kB, k0, kCross }));
  expect(met).toEqual({ distinct: true, info: EXPECTED_INFO });
});

it("fails bothOpen with A's registry query rejection, never as zero keys, and asks no holder", async () => {
  const calls: string[][] = [];
  const [a, b] = openSides(calls);
  // Only the first registry read fails: a caller that counted it as zero keys would pass on retry.
  let failed = false;
  const exec = (args: readonly string[]) => {
    if (args[0] !== 'python3' || failed) return a.exec(args);
    failed = true;
    return Promise.reject(new Error('registry unreadable'));
  };
  const met = { distinct: false, info: {} };

  const opened = bothOpen({ ...a, exec }, b, met);

  const message = 'Office editor registry entries per side {}: registry unreadable';
  await expect(opened).rejects.toThrow(new Error(message));
  expect(calls.map(([step]) => step)).toEqual(['B registry']);
  expect(met).toEqual({ distinct: false, info: {} });
});

const OTHER = editorNonce();
it.each([
  ['its own nonce only', [`探针。${NONCE}`], 'own'],
  ['the other nonce', ['', OTHER], 'crossed'],
  ['both nonces', [NONCE, OTHER], 'crossed'],
  ['neither nonce', ['编辑写回探针。'], 'missing'],
])('reads a same-name file holding %s', (_case, paragraphs, state) => {
  expect(sameNameState(read(CHANGED, paragraphs), NONCE, OTHER)).toBe(state);
});

it('retires B only when the lane fails, rethrowing the lane failure first', async () => {
  const retired: string[] = [];
  const retire = () => Promise.resolve(void retired.push('retire'));
  expect(await retiringOnError(() => Promise.resolve('evidence'), retire)).toBe('evidence');
  expect(retired).toEqual([]);
  const lane = new Error('Office editor lane failed');
  await expect(retiringOnError(() => Promise.reject(lane), retire)).rejects.toBe(lane);
  expect(retired).toEqual(['retire']);
  const disable = new Error('disable failed');
  const both = retiringOnError(
    () => Promise.reject(lane),
    () => Promise.reject(disable),
  );
  const error: unknown = await both.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([lane, disable]);
  expect((error as AggregateError).message).toBe('Office editor lane and retiring B failed');
  const failing = () => Promise.reject(lane);
  const named = retiringOnError(failing, () => Promise.reject(disable), 'Named');
  await expect(named).rejects.toThrow(new AggregateError([lane, disable], 'Named'));
});

const session = (screenshots: string[], consoleErrors: string[]) => ({
  ...{ screenshots, consoleErrors, pageErrors: [], failedRequests: [], externalRequests: [] },
  ...{ requests: 40, websockets: 2 },
});
const quiet = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };

it("prints the three files, their digests, the deltas, each session by extension, B's same-name file and the guessed-key info", () => {
  const files = EXTS.map((ext, size) => ({
    ...{ file: `编辑写回.${ext}`, before: { size, sha256: ORIGINAL } },
    after: { size: size + 400, sha256: CHANGED },
  }));
  const shots = (ext: string) => ['open', 'saved'].map((at) => `office-editor-${ext}-${at}.png`);
  const replies = ['login.png', 'workbench.png', 'reply.png'];
  const errors = (ext: string) => ['sw fetch', 'sw register', ...(ext === 'xlsx' ? ['404'] : [])];
  const editors = EXTS.map((ext) => [ext, session(shots(ext), errors(ext))] as const);
  const digests = { before: { size: 7, sha256: ORIGINAL }, after: { size: 9, sha256: CHANGED } };
  const b = { file: '编辑写回.docx', ...digests };
  const sameName = { b, editor: session(shots('docx'), errors('docx')) };
  const [open, unknown] = [
    { status: 200, error: 0, users: ['dsh'] },
    { status: 200, error: 1 },
  ];
  const guessedKey = { k1: open, kB: open, k0: unknown, kCross: unknown };
  const line = officeEditorLine({
    ...{ files, saved: true, provider: EXPECTED_DELTAS },
    ...{ editors: Object.fromEntries(editors), readBack: session(replies, []) },
    sameName: { ...sameName, distinctKeys: true, crossed: false, guessedKey },
  });

  expect(line).toEqual({
    ...{ files, saved: true, provider: EXACT },
    editors: {
      docx: { screenshots: shots('docx'), consoleErrors: 2, ...quiet },
      xlsx: { screenshots: shots('xlsx'), consoleErrors: 3, ...quiet },
      pptx: { screenshots: shots('pptx'), consoleErrors: 2, ...quiet },
    },
    readBack: { screenshots: replies, consoleErrors: 0, ...quiet },
    sameName: {
      ...{ b, distinctKeys: true, crossed: false, guessedKey },
      editor: { screenshots: shots('docx'), consoleErrors: 2, ...quiet },
    },
  });
  expect(JSON.stringify(line)).not.toContain('sw fetch');
  expect(() => officeEditorLine(undefined)).toThrow('Office editor evidence missing');
});

const BASE = 'http://127.0.0.1:64694';
const FETCH = 'A bad HTTP response code (403) was received when fetching the script.';
const DS = '/sidebar/onlyoffice/ds/9.4.0-c83aecd3de42866b80ccf786af6354d6';
const REGISTER = `Registration failed with TypeError: Failed to register a ServiceWorker for scope ('${BASE}${DS}/') with script ('${BASE}${DS}/document_editor_service_worker.js'): ${FETCH}`;
const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
const WORKER = `403 ${DS}/document_editor_service_worker.js`;
const plugin = (file: string, guid = '9DC93CDB-B576-4F0C-B55E-FCC9C48DD007') =>
  `404 ${DS}/sdkjs-plugins/%7B${guid}%7D/translations/helpers/${file}`;
const AI = plugin('zh-ZH.json');

const SW = [FETCH, REGISTER];
const SW404 = [...SW, NOT_FOUND];

it.each([
  ['the SW refusals only', true, true, SW, [WORKER]],
  ['the AI plugin 404 and its text', true, true, [FETCH, NOT_FOUND, REGISTER], [WORKER, AI]],
  ['the 404 text first', true, true, [NOT_FOUND, FETCH, REGISTER], [WORKER, AI]],
  ['the AI plugin 404 without a text', true, true, SW, [AI, WORKER]],
  ['the 404 text without its response', false, true, SW404, [WORKER]],
  ['another plugin', false, true, SW404, [WORKER, plugin('zh-ZH.json', '0')]],
  ['another AI plugin file', false, true, SW404, [WORKER, plugin('en-EN.json')]],
  ['two 404 texts', false, true, [...SW404, NOT_FOUND], [WORKER, AI]],
  ['two plugin 404 responses', false, true, SW404, [WORKER, AI, AI]],
  ['an unrelated console error', false, false, [...SW, 'Uncaught TypeError: x'], [WORKER]],
  ['a 404 for another path', false, true, SW, [WORKER, `404 ${DS}/x.json`]],
  ['another 403', false, true, SW, [`403 ${DS}/x/document_editor_service_worker.js`]],
  ['the SW response missing', false, true, SW, []],
  ['a SW refusal missing', false, false, [REGISTER, NOT_FOUND], [WORKER, AI]],
  ['the fetch refusal alone', false, false, [FETCH], [WORKER]],
])('allows the editing session %s: %s', (_case, allowed, refused, consoleErrors, responses) => {
  expect(editorErrorsAllowed(consoleErrors, responses, `${BASE}/`)).toBe(allowed);
  expect(editorRefused(consoleErrors, `${BASE}/`), 'openHinted wait').toBe(refused);
});

const KEY = 'c3'.repeat(32);
const SOCKET = `/doc/${KEY}/c/?EIO=4&transport=polling`;
const LEAKED = [KEY, 'EIO=4', 'transport='];
const leaky = {
  ...session(['office-editor-docx-open.png'], [`WebSocket ${BASE}${SOCKET} failed`]),
  failedRequests: [`GET ${BASE}${SOCKET}`],
};
const reply = (value: unknown) => Promise.resolve(JSON.stringify(value));
const written = { size: 9, sha256: ORIGINAL };
/** A's instance as the editor lane drives it around its browser sessions; B's `docker exec` too. */
function editorLane(retire: () => Promise<void>): OfficeEditorLane {
  const exec = (args: readonly string[]) => {
    const [, , script, path = '', ...rest] = args;
    if (script === HEALTH_COMMAND[2]) return reply({ status: 200, body: 'true' });
    if (script === READER)
      return reply({ texts: { 'word/document.xml': '编辑写回探针。' }, ...written });
    if (script === docxCommand('')[2]) return reply({ name: path.split('/').pop(), ...written });
    // withWorkFiles' removal: the work directory, then each name.
    return reply(rest.map(() => false));
  };
  return {
    session: { base: BASE, directory: DIR, email: 'a@x.test', password: 'p', timeout: 500 },
    ...{ exec, run: (args) => exec(args.slice(4)), retire },
    provider: () => Promise.resolve({ readBacks: 0, readBackHits: 0, requests: 0 }),
    namespaceRead: () => Promise.reject(new Error('no holder read before both editors open')),
    ...{ reply: 'reply', readBack: { marker: 'marker', command: 'read', nonce: NONCE } },
    ...{ secondEmployee: () => Promise.resolve('dsh-team-u-b'), secondEmail: 'b@x.test' },
  };
}
const DISABLE = new Error('disable B failed');
/** The lane's failure and every error it holds, A's and B's sessions included. */
const errorTree = (error: unknown): unknown[] => [
  error,
  // AggregateError types its entries as any; each is walked whatever it is.
  ...(error instanceof AggregateError ? (error.errors as unknown[]).flatMap(errorTree) : []),
];
/** A's and B's session failures, once no error of the tree prints the key or query. */
const sides = (error: unknown) => {
  const tree = errorTree(error);
  for (const entry of tree)
    for (const secret of LEAKED) expect(everythingPrinted(entry)).not.toContain(secret);
  return tree.filter(
    (entry): entry is Error =>
      entry instanceof Error && !(entry instanceof AggregateError) && entry !== DISABLE,
  );
};

it.each([
  ['the same-name DOCX', () => Promise.resolve(), 3],
  ["B's retirement as well", () => Promise.reject(DISABLE), 5],
])(
  'fails both editing sessions of %s without the key or query anywhere',
  async (_case, retire, size) => {
    const cause = new Error(`page.goto: ${BASE}${SOCKET}`);
    vi.mocked(workbenchSession).mockImplementation((_session, names) =>
      Promise.reject(new StackWorkbenchFailure(cause, leaky, names.label)),
    );

    const error = await officeEditorScenario(editorLane(retire)).catch((caught: unknown) => caught);

    expect(errorTree(error)).toHaveLength(size);
    const reasons = sides(error).map((side) => side.message);
    const counts = 'consoleErrors=1 pageErrors=0 failedRequests=1 externalRequests=0';
    const failure = `Stack workbench office editor docx failed (${counts}): page.goto: ${BASE}/doc/<redacted>/c/`;
    expect(reasons).toEqual([failure, failure]);
  },
);

it('names the console errors and failed responses of an editing session scrubbed', async () => {
  // Only `status` and `url` are read of a response; the stand-in answers both.
  const response = { status: () => 502, url: () => `${BASE}${SOCKET}` } as unknown as Response;
  vi.mocked(workbenchSession).mockImplementation((_session, _names, _body, _launch, onResponse) => {
    onResponse?.(response);
    return Promise.resolve(leaky);
  });

  const error = await officeEditorScenario(editorLane(() => Promise.resolve())).catch(
    (caught: unknown) => caught,
  );

  const seen = `consoleErrors, responses [["WebSocket ${BASE}/doc/<redacted>/c/ failed"],["502 /doc/<redacted>/c/"]]`;
  const messages = sides(error).map((side) => side.message);
  expect(messages).toEqual(
    [1, 2].map(() => `${seen}: expected false to be true // Object.is equality`),
  );
});

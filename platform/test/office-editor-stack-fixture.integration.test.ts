import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { docxCommand } from './office-hints-stack-fixture.ts';
import {
  editorErrorsAllowed,
  EXPECTED_DELTAS,
  officeEditorLine,
  providerDeltas,
  READ_BACK_COMMAND,
  READER,
  READER_ARGV,
  WRITE_ARGV,
  writeBackState,
} from './office-editor-stack-fixture.ts';

const FILE = '/data/work/编辑写回.docx';
const NONCE = 'EDITOR0123456789ABCDEF0123456789ABCD';

it('writes the one-paragraph docx, then reads every paragraph, the size and the digest via argv', () => {
  expect(WRITE_ARGV).toEqual(docxCommand('编辑写回.docx', '编辑写回探针。'));
  expect(WRITE_ARGV.slice(3)).toEqual([FILE, '编辑写回探针。']);
  expect(READER_ARGV).toEqual(['python3', '-c', READER, FILE]);
  for (const part of [
    'Document(sys.argv[1]).paragraphs',
    '"paragraphs": paragraphs, "size": len(data)',
    'hashlib.sha256(data).hexdigest()',
  ])
    expect(READER).toContain(part);
});

it('hands bash the same argv as single-quoted words, which a POSIX shell splits back', () => {
  expect(READER).not.toContain("'");
  expect(READ_BACK_COMMAND).toBe(`'python3' '-c' '${READER}' '${FILE}'`);
  const words = execFileSync('sh', ['-c', `printf '%s\\0' ${READ_BACK_COMMAND}`]).toString();
  expect(words.split('\0')).toEqual([...READER_ARGV, '']);
  expect(READ_BACK_COMMAND).not.toContain('EDITOR');
});

const [ORIGINAL, CHANGED] = ['a'.repeat(64), 'b'.repeat(64)];
const read = (sha256: string, paragraphs: string[]) => ({ paragraphs, size: 9_000, sha256 });

it.each([
  ['the digest unchanged', read(ORIGINAL, ['编辑写回探针。']), 'unchanged'],
  ['the digest unchanged, whatever it reads', read(ORIGINAL, [NONCE]), 'unchanged'],
  ['a new digest without the nonce', read(CHANGED, ['编辑写回探针。']), 'changed-without-nonce'],
  ['a new digest without paragraphs', read(CHANGED, []), 'changed-without-nonce'],
  ['a new digest and the nonce in a paragraph', read(CHANGED, [`探针。${NONCE}`]), 'saved'],
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

const session = (screenshots: string[], consoleErrors: string[]) => ({
  ...{ screenshots, consoleErrors, pageErrors: [], failedRequests: [], externalRequests: [] },
  ...{ requests: 40, websockets: 2 },
});
const quiet = { pageErrors: 0, failedRequests: 0, externalRequests: 0 };

it('prints the file, both digests, the deltas and each session by screenshots and error counts', () => {
  const file = { file: '编辑写回.docx', before: { size: 9_000, sha256: ORIGINAL } };
  const evidence = { ...file, after: { size: 9_400, sha256: CHANGED }, saved: true as const };
  const editor = ['office-editor-open.png', 'office-editor-saved.png'];
  const replies = ['login.png', 'workbench.png', 'reply.png'];
  const line = officeEditorLine({
    ...{ ...evidence, provider: EXPECTED_DELTAS },
    editor: session(editor, ['sw fetch', 'sw register']),
    readBack: session(replies, []),
  });

  expect(line).toEqual({
    ...{ ...evidence, provider: EXACT },
    editor: { screenshots: editor, consoleErrors: 2, ...quiet },
    readBack: { screenshots: replies, consoleErrors: 0, ...quiet },
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

it.each([
  ['both ServiceWorker refusals only', true, [FETCH, REGISTER], [WORKER]],
  ['the AI plugin 404 and its text', true, [FETCH, NOT_FOUND, REGISTER], [WORKER, AI]],
  ['the AI plugin 404 without a text', true, [FETCH, REGISTER], [AI, WORKER]],
  ['the 404 text without the plugin response', false, [FETCH, REGISTER, NOT_FOUND], [WORKER]],
  ['another plugin GUID', false, [FETCH, REGISTER, NOT_FOUND], [WORKER, plugin('zh-ZH.json', '0')]],
  ['another AI plugin file', false, [FETCH, REGISTER, NOT_FOUND], [WORKER, plugin('en-EN.json')]],
  ['two 404 texts', false, [FETCH, REGISTER, NOT_FOUND, NOT_FOUND], [WORKER, AI]],
  ['two plugin 404 responses', false, [FETCH, REGISTER, NOT_FOUND], [WORKER, AI, AI]],
  ['an unrelated console error', false, [FETCH, REGISTER, 'Uncaught TypeError: x'], [WORKER]],
  ['a 404 for another path', false, [FETCH, REGISTER], [WORKER, `404 ${DS}/x.json`]],
  ['the ServiceWorker response missing', false, [FETCH, REGISTER], []],
  ['a ServiceWorker refusal missing', false, [REGISTER, NOT_FOUND], [WORKER, AI]],
])('allows the editing session %s: %s', (_case, allowed, consoleErrors, responses) => {
  expect(editorErrorsAllowed(consoleErrors, responses, `${BASE}/`)).toBe(allowed);
});

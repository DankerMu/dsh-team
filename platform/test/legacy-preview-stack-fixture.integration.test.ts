import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { cellInputState, previewFacts, previewOutcome } from './better-sidebar-browser-fixture.mjs';
import {
  base64Chunks,
  inViewport,
  readLegacySamples,
  readOnlyViolations,
} from './legacy-preview-stack-fixture.ts';

const OFFICE = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office';
const EXCEL = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const bytes = (length: number) => Buffer.from(Array.from({ length }, (_, index) => index % 251));
const decoded = (chunks: readonly string[]) =>
  Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));

it('reads the three samples and checks them against office-legacy/README.md', async () => {
  const samples = await readLegacySamples();

  // Digests from platform/test/office-legacy/README.md; sizes measured on the committed binaries.
  expect(
    samples.map(({ name, size, sha256: digest, preview }) => [name, size, digest, preview]),
  ).toEqual([
    [
      '旧通知.doc',
      8704,
      'dd1721dbab058011625c8d19757361893b38df5c795ce45f2b357ef9db9f9aa3',
      'office',
    ],
    [
      '旧报表.xls',
      5632,
      '272ce2ff747bd538b55a19e7614f9fe8932e79806c927b66ffc476d40a93a02c',
      'excel',
    ],
    [
      '旧汇报.ppt',
      459264,
      '4c1ad7ac48a108f94f04d4370112f3791107b242d022c6cfe716bfc3313b8767',
      'office',
    ],
  ]);
  for (const sample of samples) expect(sha256(sample.bytes)).toBe(sample.sha256);
});

it('rejects an empty file: nothing would be written', () => {
  expect(() => base64Chunks(Buffer.alloc(0))).toThrow(/empty/);
});

it.each([
  [73_728, 1],
  [73_729, 2],
  [459_264, 7],
])('cuts %i raw bytes into %i independently decodable chunks', (size, count) => {
  const data = bytes(size);

  const chunks = base64Chunks(data);

  expect(chunks).toHaveLength(count);
  expect(decoded(chunks).equals(data)).toBe(true);
  for (const chunk of chunks)
    expect(Buffer.from(chunk, 'base64').length).toBeLessThanOrEqual(73_728);
});

it('keeps every full chunk at 98 304 base64 characters, below the 131 072-byte argument limit', () => {
  const chunks = base64Chunks(bytes(73_729));

  expect(chunks.map((chunk) => chunk.length)).toEqual([98_304, 4]);
});

const clean = { labels: [], contentEditable: 0, cellInput: false, editors: 0, iframes: 0 };

it.each([
  ['a 保存 label', { ...clean, labels: ['保存'] }, ['label:保存']],
  ['an Edit label', { ...clean, labels: ['Edit'] }, ['label:Edit']],
  ['an editable region', { ...clean, contentEditable: 1 }, ['contentEditable:1']],
  ['an iframe', { ...clean, iframes: 1 }, ['iframes:1']],
  ['a CodeMirror editor', { ...clean, editors: 2 }, ['editors:2']],
])('judges %s a read-only violation', (_case, facts, violations) => {
  expect(readOnlyViolations(facts)).toEqual(violations);
});

it('accepts reload, open-with and save-as labels and no editable surface as read-only', () => {
  const facts = { ...clean, labels: ['重新加载', '打开方式', '另存为', '报表'] };

  expect(readOnlyViolations(facts)).toEqual([]);
});

it("does not judge Fortune-sheet's cell input alone a violation, but any other editable one", () => {
  expect(readOnlyViolations({ ...clean, cellInput: true })).toEqual([]);
  expect(readOnlyViolations({ ...clean, cellInput: true, contentEditable: 1 })).toEqual([
    'contentEditable:1',
  ]);
});

it('settles the Office preview with the selectors observeDocx always used', () => {
  const office = previewOutcome(OFFICE, '旧通知.doc');

  for (const selector of [
    JSON.stringify(`[data-document-preview="${OFFICE}"]`),
    'section[data-pdf-preview] [data-pdf-page] [data-document-zoom-surface]:not([hidden]) canvas',
    'section[data-pdf-preview] [data-pdf-page]',
    '[data-textpreview-failed]',
    '[role="alert"]',
    '[data-dsh-native-tab-host]',
    '[data-office-font-warning]',
    '"/旧通知.doc"',
  ])
    expect(office).toContain(selector);
  // The workbook's draw condition is the Excel branch's alone.
  expect(office).not.toContain('luckysheet-sheets-item-name');
});

it('settles the Excel preview on its section and the visible 报表 sheet name', () => {
  const excel = previewOutcome(EXCEL, '旧报表.xls');

  for (const selector of [
    JSON.stringify(`[data-document-preview="${EXCEL}"]`),
    'section[data-excel-preview]',
    '#fortune-sheettab-container-c .luckysheet-sheets-item-name',
    '"报表"',
    '[data-textpreview-failed]',
    '[role="alert"]',
    // Fortune-sheet's screen-reader live regions inside the drawn workbook are no failure.
    ".filter((node) => node.closest('section[data-excel-preview]') === null)",
  ])
    expect(excel).toContain(selector);
  expect(excel).not.toContain('[data-document-zoom-surface]');
});

it('reads read-only facts and the formula bar only inside the matched preview container', () => {
  const facts = previewFacts(EXCEL, '旧报表.xls');

  for (const selector of [
    JSON.stringify(`[data-document-preview="${EXCEL}"]`),
    'button,[role="button"],[role="menuitem"],[role="tab"]',
    '[contenteditable="true"]',
    '.cm-editor',
    'iframe',
    '.fortune-fx-input',
    // Only the cell input, by its exact id, leaves the editable count; it is reported apart.
    '.filter((node) => node.id !== "luckysheet-rich-text-editor").length',
    'cellInput: el.querySelector("#luckysheet-rich-text-editor") !== null',
  ])
    expect(facts).toContain(selector);
  expect(facts).not.toContain("document.querySelectorAll('[contenteditable");
});

it('reads the cell input rectangle and focus, the viewport, the formula bar and the input box z-index', () => {
  const state = cellInputState(EXCEL, '旧报表.xls');

  for (const selector of [
    JSON.stringify(`[data-document-preview="${EXCEL}"]`),
    '"#luckysheet-rich-text-editor"',
    'viewport: { width: innerWidth, height: innerHeight }',
    'document.activeElement === input',
    "'.luckysheet-input-box'",
    "'.fortune-fx-input'",
    'box.style.zIndex || getComputedStyle(box).zIndex',
  ])
    expect(state).toContain(selector);
});

const VIEWPORT = { width: 1280, height: 800 };

it.each([
  ['the A1 input of a drawn workbook', { x: 40, y: 200, width: 115, height: 15 }, true],
  [
    'a rectangle flush with the bottom-right corner',
    { x: 1180, y: 790, width: 100, height: 10 },
    true,
  ],
  [
    'the input parked off-screen without a selection',
    { x: -10000, y: -10000, width: 115, height: 15 },
    false,
  ],
  ['a rectangle past the right edge', { x: 1200, y: 200, width: 115, height: 15 }, false],
  ['a rectangle past the bottom edge', { x: 40, y: 790, width: 115, height: 15 }, false],
  ['a rectangle above the top edge', { x: 40, y: -1, width: 115, height: 15 }, false],
])('judges %s inside the viewport: %s', (_case, rect, inside) => {
  expect(inViewport(rect, VIEWPORT)).toBe(inside);
});

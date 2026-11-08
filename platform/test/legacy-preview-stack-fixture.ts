import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect } from 'vitest';
import {
  cellInputState,
  previewFacts,
  previewOutcome,
  rowQuery,
} from './better-sidebar-browser-fixture.mjs';
import type {
  CellInputState,
  PreviewFacts,
  PreviewOutcome,
} from './better-sidebar-browser-fixture.mjs';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { element, showSidebarRows, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

/**
 * DSH 0.2.1's own document preview: DOC and PPT convert to PDF in the instance (`…/office`,
 * `remote.officeToPdf.render`); XLS opens in the browser's Fortune-sheet view (`…/excel`).
 */
type Preview = 'office' | 'excel';
const PREVIEW = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/';

interface LegacySample extends ArchiveEntry {
  /** The committed binary under `platform/test/office-legacy/`. */
  readonly file: string;
  readonly preview: Preview;
}

// The sha256 column of platform/test/office-legacy/README.md; sizes are the committed binaries'.
const SAMPLES: readonly LegacySample[] = [
  {
    file: 'probe.doc',
    name: '旧通知.doc',
    size: 8704,
    sha256: 'dd1721dbab058011625c8d19757361893b38df5c795ce45f2b357ef9db9f9aa3',
    preview: 'office',
  },
  {
    file: 'probe.xls',
    name: '旧报表.xls',
    size: 5632,
    sha256: '272ce2ff747bd538b55a19e7614f9fe8932e79806c927b66ffc476d40a93a02c',
    preview: 'excel',
  },
  {
    file: 'probe.ppt',
    name: '旧汇报.ppt',
    size: 459_264,
    sha256: '4c1ad7ac48a108f94f04d4370112f3791107b242d022c6cfe716bfc3313b8767',
    preview: 'office',
  },
];
const NAMES = SAMPLES.map(({ name }) => name);
// A1 of the probe workbook's sheet 报表 (office-legacy/README.md).
const FIRST_CELL = '旧格式探针 XLS：部门';
// The product's own conversion timeout is 60s (dsh-office-to-pdf lib/index.js); the first one of
// an instance also loads the ~150 MB WASM engine, and the PDF must then render.
const CONVERSION_MS = 240_000;
const EDITING = /编辑|保存|edit|save/i;

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The three samples' bytes, each checked against its size and digest before any use. */
export function readLegacySamples(): Promise<(LegacySample & { readonly bytes: Buffer })[]> {
  return Promise.all(
    SAMPLES.map(async (sample) => {
      const bytes = await readFile(new URL(`./office-legacy/${sample.file}`, import.meta.url));
      if (bytes.length !== sample.size || digest(bytes) !== sample.sha256)
        throw new Error(`Legacy sample ${sample.file} differs from office-legacy/README.md`);
      return { ...sample, bytes };
    }),
  );
}

// 73 728 raw bytes, a multiple of 3, encode to exactly 98 304 base64 characters with no inner
// padding, so each chunk decodes alone and stays below Linux's 131 072-byte single-argument limit.
const CHUNK = 73_728;

/** The file's raw bytes in base64 chunks of at most CHUNK bytes each, in order. */
export function base64Chunks(bytes: Buffer): string[] {
  if (bytes.length === 0) throw new Error('Legacy sample empty: nothing to write');
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK)
    chunks.push(bytes.subarray(at, at + CHUNK).toString('base64'));
  return chunks;
}

/**
 * Every editing affordance in a preview's facts; empty when the preview is read-only. The cell
 * input alone is none: its contenteditable ignores the workbook's `allowEdit`, so the XLS step
 * types into it instead.
 */
export function readOnlyViolations(
  facts: Pick<PreviewFacts, 'labels' | 'contentEditable' | 'cellInput' | 'editors' | 'iframes'>,
): string[] {
  const labels = facts.labels
    .filter((label) => EDITING.test(label))
    .map((label) => `label:${label}`);
  const counts = (['contentEditable', 'editors', 'iframes'] as const)
    .filter((key) => facts[key] > 0)
    .map((key) => `${key}:${String(facts[key])}`);
  return [...labels, ...counts];
}

// Python in the instance as uid 1001; every value arrives as argv, never through a shell or stdin
// (docker-command.ts closes stdin; `docker cp` would leave the file owned by root).
const WRITER = `import base64, sys
path, mode, data = sys.argv[1:]
with open(path, mode) as f: f.write(base64.b64decode(data, validate=True))`;
const READ = `import hashlib, json, pathlib, sys
data = [(n, pathlib.Path(sys.argv[1], n).read_bytes()) for n in sys.argv[2:]]
print(json.dumps([{"name": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in data]))`;

/** One previewed file; `pages` for the converted PDFs, `cell` for the spreadsheet's formula bar. */
interface LegacyFile extends ArchiveEntry {
  readonly preview: Preview;
  readonly pages?: number;
  readonly cell?: string | null;
  /** The workbook after typing into the selected cell: the formula bar and the input box z-index. */
  readonly typed?: Pick<CellInputState, 'cell' | 'zIndex'>;
}

export interface LegacyPreviewEvidence {
  readonly browser: StackBrowserEvidence;
  readonly files: readonly LegacyFile[];
}

type Shoot = (name: string) => Promise<void>;

/**
 * Clicks the selected cell where its input lies, types `ZZ`, then Enter and Escape: a read-only
 * workbook keeps the formula bar's text and never enters the cell edit state (input box z-index
 * stays -1; 19 while a cell is edited).
 */
async function typeIntoWorkbook(page: Page, shoot: Shoot, id: string, name: string) {
  const { rect } = await page.evaluate<CellInputState>(cellInputState(id, name));
  if (rect === null) throw new Error(`Legacy ${name} cell input missing`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.type('ZZ');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const { cell, zIndex } = await page.evaluate<CellInputState>(cellInputState(id, name));
  await shoot('legacy-xls-typed');
  expect({ cell, zIndex }, `${name} after typing`).toEqual({ cell: FIRST_CELL, zIndex: '-1' });
  return { cell, zIndex };
}

/** Opens one file from the file area and waits for DSH's preview to settle read-only. */
async function previewFile(page: Page, shoot: Shoot, sample: LegacySample, timeout: number) {
  const { name, size, sha256, preview } = sample;
  const id = `${PREVIEW}${preview}`;
  await until(() => showSidebarRows(page, [name]), timeout, `legacy ${name} row`);
  const row = await element(page, rowQuery(name));
  if (row === null) throw new Error(`Legacy ${name} row missing`);
  await row.click();
  let outcome: PreviewOutcome | undefined;
  const settled = async () => {
    outcome = await page.evaluate<PreviewOutcome>(previewOutcome(id, name));
    return outcome.state !== null;
  };
  await until(settled, preview === 'office' ? CONVERSION_MS : timeout, `legacy ${name} preview`);
  if (outcome === undefined) throw new Error(`Legacy ${name} preview never read`);
  const facts = await page.evaluate<PreviewFacts | null>(previewFacts(id, name));
  await shoot(`legacy-${sample.file.slice(sample.file.lastIndexOf('.') + 1)}`);
  // Opened by DSH's own container, neither by better-sidebar nor by ONLYOFFICE.
  expect(outcome, name).toMatchObject({ state: 'rendered', nativeHost: false });
  if (facts === null) throw new Error(`Legacy ${name} preview container gone`);
  expect(readOnlyViolations(facts), `${name} read-only`).toEqual([]);
  if (preview === 'excel') {
    expect(facts.cell, `${name} formula bar`).toBe(FIRST_CELL);
    const typed = await typeIntoWorkbook(page, shoot, id, name);
    return { name, size, sha256, preview, cell: facts.cell, typed };
  }
  // One paragraph, one slide.
  expect(outcome.pages, `${name} pages`).toBe(1);
  return { name, size, sha256, preview, pages: outcome.pages };
}

/** The writes, the previews and every check of the lane; cleanup is the caller's. */
async function legacyPreview(lane: ArchiveLane): Promise<LegacyPreviewEvidence> {
  const { exec, session } = lane;
  const samples = await readLegacySamples();
  const before = await providerCounts(lane);
  for (const { name, bytes } of samples)
    for (const [index, chunk] of base64Chunks(bytes).entries())
      await exec(['python3', '-c', WRITER, `${WORK}/${name}`, index === 0 ? 'wb' : 'ab', chunk]);
  const expected = samples.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  // The instance's own JSON for the files on its disk.
  const readBack = async () =>
    JSON.parse(await exec(['python3', '-c', READ, WORK, ...NAMES])) as unknown;
  expect(await readBack(), 'Legacy samples written').toEqual(expected);
  const files: LegacyFile[] = [];
  const names = { label: 'legacy preview', failure: 'legacy-failure' };
  // One file at a time: an opened tab hides the explorer and the previous preview.
  const browser = await workbenchSession(session, names, async (page, shoot) => {
    for (const sample of samples)
      files.push(await previewFile(page, shoot, sample, session.timeout));
  });
  expect(await readBack(), 'Legacy samples unchanged by their previews').toEqual(expected);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  return { browser, files };
}

/**
 * DSH's read-only preview of 旧通知.doc, 旧报表.xls and 旧汇报.ppt from the employee's file area
 * (#433, 17.4): each renders in DSH's own container with no editing or saving affordance, and
 * leaves the instance's bytes unchanged; the three files are then removed.
 */
export const legacyPreviewScenario = (lane: ArchiveLane): Promise<LegacyPreviewEvidence> =>
  withWorkFiles(lane, NAMES, 'Legacy preview', () => legacyPreview(lane));

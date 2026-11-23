import { extname } from 'node:path';
import { expect } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { holds, readWork, singleQuoted, templateBase64 } from './office-editor-stack-fixture.ts';
import { docxCommand, documentServerReady } from './office-hints-stack-fixture.ts';
import { WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';

// python-docx from the user image; the file and the nonce arrive as argv. No single quote (below).
export const REWRITER = `import sys
from docx import Document
path, nonce = sys.argv[1:]
document = Document(path)
document.add_paragraph(nonce)
document.save(path)
print(nonce)`;

// Python stdlib only, no single quote (below): the user image has no openpyxl or python-pptx. The
// named part must hold the anchor exactly once, counted on its bytes, else the file is left as it
// was. The archive is rebuilt in memory, every entry in order with its content, only the part's
// anchor replaced, and written back to the same path and inode, as python-docx's save does.
export const PART_REWRITER = `import io, sys, zipfile
path, nonce, part, anchor, replacement = sys.argv[1:]
if nonce not in replacement:
    sys.exit("The replacement does not hold the nonce")
anchor, replacement = anchor.encode("utf-8"), replacement.encode("utf-8")
with zipfile.ZipFile(path) as archive:
    entries = [(info, archive.read(info)) for info in archive.infolist()]
count = sum(data.count(anchor) for info, data in entries if info.filename == part)
if count != 1:
    sys.exit("%s holds the anchor %d times, not once" % (part, count))
rebuilt = io.BytesIO()
with zipfile.ZipFile(rebuilt, "w") as archive:
    for info, data in entries:
        archive.writestr(info, data.replace(anchor, replacement) if info.filename == part else data)
with open(path, "wb") as target:
    target.write(rebuilt.getvalue())
print(nonce)`;

// The pinned Document Server 9.4.0 blank templates (design § Must add/change, measured
// 2026-11-23): the sheet's empty sheetData, and the start of slide 1's empty subtitle paragraph,
// which the employee does not type into (EDITING.pptx clicks the title). The nonce needs no XML
// escaping: NONCE_PATTERN is uppercase hex after EDITOR.
const SUBTITLE =
  '<p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>';
const PARTS = {
  xlsx: {
    part: 'xl/worksheets/sheet1.xml',
    anchor: '<sheetData/>',
    replacement: (nonce: string) =>
      `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${nonce}</t></is></c></row></sheetData>`,
  },
  pptx: {
    part: 'ppt/slides/slide1.xml',
    anchor: SUBTITLE,
    replacement: (nonce: string) =>
      `${SUBTITLE}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${nonce}</a:t></a:r>`,
  },
};
type PartExt = keyof typeof PARTS;
type Ext = 'docx' | PartExt;

/** The rewrite of `name` in the work directory as argv, by its extension. */
export function rewriteArgv(name: string, nonce: string) {
  const path = `${WORK}/${name}`;
  const ext = extname(name).slice(1);
  if (ext === 'docx') return ['python3', '-c', REWRITER, path, nonce];
  if (ext !== 'xlsx' && ext !== 'pptx') throw new Error(`No Office rewriter for ${name}`);
  const { part, anchor, replacement } = PARTS[ext];
  return ['python3', '-c', PART_REWRITER, path, nonce, part, anchor, replacement(nonce)];
}
/** The Agent's bash rewrite of `name` in the work directory, each word single-quoted. */
export const rewriteCommand = (name: string, nonce: string) =>
  singleQuoted(rewriteArgv(name, nonce));

const PARAGRAPH = '改写探针：开头只有这一段。';

/**
 * Writes a case's file, checks it and waits for the Document Server; its reader. A DOCX holds one
 * paragraph; an XLSX or PPTX is the Document Server's blank template, not yet holding `nonce`.
 */
export async function freshFile(
  lane: ArchiveLane & { readonly run: DockerOutput },
  { id, name, ext }: { readonly id: string; readonly name: string; readonly ext: Ext },
  nonce: string,
) {
  const content = ext === 'docx' ? [PARAGRAPH] : ['--base64', await templateBase64(lane.run, ext)];
  const written = JSON.parse(await lane.exec(docxCommand(name, ...content))) as ArchiveEntry;
  const read = () => readWork(lane, name);
  const { texts, sha256 } = await read();
  const [first, fresh] =
    ext === 'docx'
      ? [{ sha256, text: texts['word/document.xml'] }, { text: PARAGRAPH }]
      : [{ sha256, agent: holds(texts, nonce) }, { agent: false }];
  expect(first, `Office rewrite ${id} file`).toEqual({ sha256: written.sha256, ...fresh });
  await documentServerReady(lane);
  return read;
}

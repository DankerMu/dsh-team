import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { DOCUMENT_SERVER } from './document-server-net-fixture.ts';
import { editorNonce, READER } from './office-editor-stack-fixture.ts';
import { docxCommand, HEALTH_COMMAND } from './office-hints-stack-fixture.ts';
import {
  freshFile,
  PART_REWRITER,
  REWRITER,
  rewriteArgv,
  rewriteCommand,
} from './office-rewrite-formats.ts';

const AGENT = editorNonce();
const DIR = mkdtempSync(join(tmpdir(), 'dsh-team-office-rewrite-formats-'));
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
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
  const dir = join(DIR, 'docx');
  mkdirSync(dir);
  writeFileSync(join(dir, 'docx.py'), FAKE_DOCX);
  const file = join(dir, '改写.docx');
  writeFileSync(file, '改写探针。\n');

  // `-c` puts the working directory first on the module path: the stand-in shadows python-docx.
  const out = execFileSync('python3', ['-c', REWRITER, file, AGENT], { cwd: dir }).toString();

  expect(out).toBe(`${AGENT}\n`);
  expect(readFileSync(file, 'utf8')).toBe(`改写探针。\n${AGENT}\n`);
});

// The pinned Document Server 9.4.0 blank templates' anchors (design § Must add/change), written out
// rather than read from the module.
const SHEET = 'xl/worksheets/sheet1.xml';
const SLIDE = 'ppt/slides/slide1.xml';
const SHEET_ANCHOR = '<sheetData/>';
const SLIDE_ANCHOR =
  '<p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>';
const sheetCell = (nonce: string) =>
  `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${nonce}</t></is></c></row></sheetData>`;
const slideRun = (nonce: string) =>
  `${SLIDE_ANCHOR}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${nonce}</a:t></a:r>`;
const BOM = '﻿';
// Each format's part wrapped as well-formed XML around its anchor; the slide starts with a BOM.
const FORMATS = {
  xlsx: {
    part: SHEET,
    anchor: SHEET_ANCHOR,
    replacement: sheetCell,
    xml: (body: string) => `<worksheet xmlns="urn:s">${body}</worksheet>`,
  },
  pptx: {
    part: SLIDE,
    anchor: SLIDE_ANCHOR,
    replacement: slideRun,
    xml: (body: string) =>
      `${BOM}<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:nvSpPr>` +
      `<p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr/><p:nvPr>${body}` +
      '<a:endParaRPr/></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  },
} as const;
type Ext = keyof typeof FORMATS;
const EXTS = Object.keys(FORMATS) as Ext[];

it.each(EXTS)('hands bash the stdlib part rewriter for %s with its part and anchor', (ext) => {
  const { part, anchor, replacement } = FORMATS[ext];
  const name = `干净改写.${ext}`;
  const path = `/data/work/${name}`;
  const argv = ['python3', '-c', PART_REWRITER, path, AGENT, part, anchor, replacement(AGENT)];

  const command = rewriteCommand(name, AGENT);

  const words = execFileSync('sh', ['-c', `printf '%s\\0' ${command}`]).toString();
  expect(PART_REWRITER).not.toContain("'");
  expect(rewriteArgv(name, AGENT)).toEqual(argv);
  expect(words.split('\0')).toEqual([...argv, '']);
});

it.each(['干净改写.doc', '干净改写.txt', '干净改写', '干净改写.xlsx.bak', '干净改写.XLSX'])(
  'refuses to rewrite %s, which has no rewriter',
  (name) => {
    expect(() => rewriteArgv(name, AGENT)).toThrow(`No Office rewriter for ${name}`);
  },
);

// A zip of `entries` (a name, then its content) by Python's zipfile, deflated; a name ending in `/`
// is a directory entry.
const ZIP = `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for name, text in zip(sys.argv[2::2], sys.argv[3::2]):
        archive.writestr(zipfile.ZipInfo(name) if name.endswith("/") else name, text)`;
// Every entry of a zip in order: its name and its content as UTF-8 text.
const ENTRIES = `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    listed = [[info.filename, archive.read(info).decode("utf-8")] for info in archive.infolist()]
print(json.dumps(listed))`;
const python = (...args: string[]) => execFileSync('python3', ['-c', ...args]).toString();
const entries = (file: string) => JSON.parse(python(ENTRIES, file)) as [string, string][];

/** A case's own directory holding `name`: a directory entry, the part, another anchor holder. */
function archive(ext: Ext, id: string, body: string) {
  const { part, anchor, xml } = FORMATS[ext];
  const dir = join(DIR, `${ext}-${id}`);
  mkdirSync(dir);
  const name = `干净改写.${ext}`;
  const file = join(dir, name);
  const listed: [string, string][] = [
    ['docProps/', ''],
    [part, xml(body)],
    ['docProps/anchor.txt', `${anchor}${anchor}`],
  ];
  python(ZIP, file, ...listed.flat());
  return { dir, name, file, listed };
}
/** `argv` run with the host python3 on `file` in place of the instance path. */
const rewrite = (argv: readonly string[], file: string) => {
  const [command = '', ...args] = argv.with(3, file);
  const { status, stdout, stderr } = spawnSync(command, args, { encoding: 'utf8' });
  return { status, stdout, stderr };
};

it.each(EXTS)('rewrites the %s part once in place and leaves every other entry', (ext) => {
  const { part, anchor, replacement } = FORMATS[ext];
  const { dir, name, file, listed } = archive(ext, 'once', anchor);
  const inode = statSync(file).ino;

  const { status, stdout } = rewrite(rewriteArgv(name, AGENT), file);

  expect({ status, stdout }).toEqual({ status: 0, stdout: `${AGENT}\n` });
  const rewritten = FORMATS[ext].xml(replacement(AGENT));
  expect(entries(file)).toEqual([listed[0], [part, rewritten], listed[2]]);
  expect(rewritten.startsWith(BOM)).toBe(ext === 'pptx');
  const { texts } = JSON.parse(python(READER, file)) as { texts: Record<string, string> };
  expect(texts[part]).toBe(AGENT);
  expect(statSync(file).ino).toBe(inode);
  expect(readdirSync(dir)).toEqual([name]);
});

it.each([
  ['xlsx', 'missing', '', 0],
  ['pptx', 'missing', '', 0],
  ['xlsx', 'twice', `${SHEET_ANCHOR}${SHEET_ANCHOR}`, 2],
  ['pptx', 'twice', `${SLIDE_ANCHOR}</a:p><a:p>${SLIDE_ANCHOR}`, 2],
] as const)(
  'fails the %s rewrite with its anchor %s and leaves the file byte for byte',
  (ext, id, body, count) => {
    const { part } = FORMATS[ext];
    const { name, file } = archive(ext, id, body);
    const before = readFileSync(file);

    const { status, stdout, stderr } = rewrite(rewriteArgv(name, AGENT), file);

    expect({ status, stdout }).toEqual({ status: 1, stdout: '' });
    expect(stderr).toContain(`${part} holds the anchor ${String(count)} times`);
    expect(stderr).not.toContain(AGENT);
    expect(readFileSync(file)).toEqual(before);
  },
);

it.each(EXTS)('fails a %s replacement without the nonce and leaves the file', (ext) => {
  const { anchor, replacement } = FORMATS[ext];
  const { name, file } = archive(ext, 'nonceless', anchor);
  const before = readFileSync(file);
  const argv = rewriteArgv(name, AGENT).with(7, replacement(editorNonce()));

  const { status, stdout, stderr } = rewrite(argv, file);

  expect({ status, stdout }).toEqual({ status: 1, stdout: '' });
  expect(stderr).toContain('The replacement does not hold the nonce');
  expect(stderr).not.toContain(AGENT);
  expect(readFileSync(file)).toEqual(before);
});

const BASE64 = 'UEsDBBQ=';
const digest = { size: 9, sha256: 'a'.repeat(64) };
const TEMPLATE = '/var/www/onlyoffice/documentserver/document-templates/new/en-US/new';
const PARAGRAPH = '改写探针：开头只有这一段。';
/** A's instance and the host's Docker as freshFile drives them; the first read finds `texts`. */
function freshLane(texts: Record<string, string>) {
  const calls = { run: [] as string[][], exec: [] as (readonly string[])[] };
  const reply = (value: unknown) => Promise.resolve(JSON.stringify(value));
  const lane = {
    session: {
      base: 'http://127.0.0.1:1',
      directory: DIR,
      email: 'a@x',
      password: 'p',
      timeout: 500,
    },
    provider: () => Promise.resolve({}),
    exec: (args: readonly string[]) => {
      calls.exec.push(args);
      const [, , script, path = ''] = args;
      if (script === HEALTH_COMMAND[2]) return reply({ status: 200, body: 'true' });
      if (script === READER) return reply({ texts, ...digest });
      if (script === docxCommand('')[2]) return reply({ name: path.split('/').pop(), ...digest });
      return Promise.reject(new Error('unscripted exec'));
    },
    run: (args: string[]) => {
      calls.run.push(args);
      return Promise.resolve(`${BASE64}\n`);
    },
  };
  return { lane, calls };
}

it.each(EXTS)('starts a %s case from the Document Server blank template', async (ext) => {
  const name = `干净改写.${ext}`;
  const texts = { [FORMATS[ext].part]: '' };
  const { lane, calls } = freshLane(texts);

  const read = await freshFile(lane, { id: ext, name, ext }, AGENT);

  expect(calls.run).toEqual([['exec', DOCUMENT_SERVER, 'base64', '-w0', `${TEMPLATE}.${ext}`]]);
  const reader = ['python3', '-c', READER, `/data/work/${name}`];
  const health = ['python3', '-c', HEALTH_COMMAND[2]];
  expect(calls.exec).toEqual([docxCommand(name, '--base64', BASE64), reader, health]);
  expect(await read()).toEqual({ texts, ...digest });
});

it('starts the DOCX case from its one paragraph, without the template', async () => {
  const name = '干净改写.docx';
  const { lane, calls } = freshLane({ 'word/document.xml': PARAGRAPH });

  await freshFile(lane, { id: 'clean', name, ext: 'docx' }, AGENT);

  expect(calls.run).toEqual([]);
  expect(calls.exec[0]).toEqual(docxCommand(name, PARAGRAPH));
});

it.each([
  ['xlsx', { [SHEET]: AGENT }],
  ['pptx', { [SLIDE]: `x${AGENT}` }],
  ['docx', { 'word/document.xml': `${PARAGRAPH}x` }],
] as const)('fails a %s case whose first read is not the fresh file', async (ext, texts) => {
  const { lane } = freshLane(texts);

  const fresh = freshFile(lane, { id: ext, name: `干净改写.${ext}`, ext }, AGENT);

  await expect(fresh).rejects.toThrow(`Office rewrite ${ext} file`);
});

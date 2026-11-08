import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containerDocument,
  output,
  OWNER_LABEL,
  record,
  registerCleanupTarget,
} from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import type { DockerCommand } from './docker-command.ts';
import { assertSecurity } from './web-startup-fixture.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const SECCOMP = join(repositoryRoot, 'images/seccomp/dsh-user.json');
const FIXTURES = join(repositoryRoot, 'platform/test/office-legacy');
const GiB = 1024 * 1024 * 1024;
// Six serial and two parallel conversions, each starting a fresh ~152MB WASM engine.
const CONVERSION_DEADLINE_MS = 300_000;

// The <a:t> runs of ppt/slides/slideN.xml, in slide-number order, read with python3 zipfile.
const PPTX_TEXT = String.raw`
import html, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    slides = sorted(
        (int(match.group(1)), name)
        for name in archive.namelist()
        for match in [re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name)]
        if match
    )
    runs = [
        html.unescape(text)
        for _, name in slides
        for text in re.findall(r"<a:t(?:\s[^>]*)?>([^<]*)</a:t>", archive.read(name).decode("utf-8"))
    ]
sys.stdout.buffer.write("".join(runs).encode("utf-8"))
`;

// Every non-empty <text:p>/<text:h> of the ODT body in document order, body paragraphs then each
// table cell, one per line, read with python3 zipfile. Writer always keeps an empty paragraph after a
// table that ends the document, and empty paragraphs carry no content, so they are dropped.
export const ODT_TEXT = String.raw`
import sys, zipfile
import xml.etree.ElementTree as ElementTree
OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
with zipfile.ZipFile(sys.argv[1]) as archive:
    body = ElementTree.fromstring(archive.read("content.xml")).find(OFFICE + "body/" + OFFICE + "text")
lines = [
    "".join(node.itertext())
    for node in body.iter()
    if node.tag in (TEXT + "p", TEXT + "h")
]
sys.stdout.buffer.write("\n".join(line for line in lines if line).encode("utf-8"))
`;

/**
 * Converts with the released document preview's own engine, resolved the way the preview resolves
 * it, and `createConverter` with the preview's own options; only facts leave the container, the
 * judgement is `assertOfficeConversion`. Raw so the PDF and Python patterns keep their escapes.
 */
function officeConvertScript(docxScript: string): string {
  return String.raw`
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const docxScript = ${JSON.stringify(docxScript)};
const pptxText = ${JSON.stringify(PPTX_TEXT)};
const odtText = ${JSON.stringify(ODT_TEXT)};
// memory.peak only exists from Linux 5.19; its absence is recorded as null.
const cgroup = (name) => {
  try { return readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const peak = () => { const value = cgroup('memory.peak'); return value === null ? null : Number(value); };
const dsh = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const officeToPdf = dsh.resolve('@deepseek-ai/dsh-office-to-pdf/package.json');
const kitManifest = createRequire(officeToPdf).resolve('@deepseek-ai/libreoffice-kit/package.json');
const kit = await import(pathToFileURL(join(dirname(kitManifest), 'lib/index.js')).href);
const runtime = await kit.discoverRuntime();
const docxReadback = execFileSync('python3', ['-c', docxScript], { encoding: 'utf8' });
const DOCX = '/data/work/offline.docx';
const OUT = '/data/work/out';
// A fresh directory: the engine opens every output exclusively.
mkdirSync(OUT);
const pdf = (path) => {
  const bytes = readFileSync(path);
  const latin = bytes.toString('latin1');
  const fonts = [...latin.matchAll(/\/BaseFont\s*\/([^\s\/<>\[\]()]+)/g)].map((found) => found[1]);
  return { bytes: bytes.length, header: latin.slice(0, 8), trailer: latin.trimEnd().slice(-5),
    cjkFonts: [...new Set(fonts.filter((name) => name.includes('CJK')))] };
};
const text = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r', '').replace(/\n+$/, '');
const timed = async (operation) => {
  const started = performance.now();
  const { backend, missingFonts } = await operation();
  return { backend, missingFonts, ms: Math.round(performance.now() - started) };
};
const zipped = (script) => (path) => execFileSync('python3', ['-c', script, path], { encoding: 'utf8' });
const readers = { txt: text, pptx: zipped(pptxText), odt: zipped(odtText) };
// The DOCX reads back as odt, never txt: libreoffice-kit 0.1.5's WASM engine hangs exporting a DOCX
// that contains a table to txt until the 60s timeout, while the same DOCX exports to odt in ~4s.
const inputs = [['doc', '/fixtures/probe.doc', 'txt'], ['ppt', '/fixtures/probe.ppt', 'pptx'], ['docx', DOCX, 'odt']];
const conversions = [];
// Exactly the options dsh-office-to-pdf passes (its released defaults, lib/index.js:387-397, built
// into this.options at :458-470): no fontDirectories or fontFallbacks, so the kit's bundled office
// fonts and default fallbacks apply, and a conversion slower than the product's 60s timeout fails.
const MiB = 1024 * 1024;
const options = {
  timeoutMs: 60000, maxInputBytes: 50 * MiB, maxOutputBytes: 100 * MiB, maxImageResolution: 192,
  maxArchiveEntries: 10000, maxUncompressedBytes: 250 * MiB, maxFontFiles: 20000,
  maxFontFileBytes: 256 * MiB, maxLoadedFontBytes: 512 * MiB,
};
const converter = await kit.createConverter(options);
try {
  for (const [input, inputPath, readback] of inputs) {
    const rendered = OUT + '/' + input + '.pdf';
    const render = await timed(() => converter.render({ inputPath, outputPath: rendered }));
    conversions.push({ input, operation: 'render', ...render, pdf: pdf(rendered) });
    const converted = OUT + '/' + input + '.' + readback;
    const convert = await timed(() => converter.convert({ inputPath, outputPath: converted }));
    conversions.push({ input, operation: 'convert', ...convert, text: readers[readback](converted) });
  }
} finally {
  await converter.dispose();
}
const serialPeak = peak();
// The preview's default two conversion slots, one converter each, on the same DOCX.
const pair = [];
let parallel;
try {
  pair.push(await kit.createConverter(options));
  pair.push(await kit.createConverter(options));
  parallel = await Promise.all(pair.map(async (each, index) => {
    const rendered = OUT + '/parallel-' + (index + 1) + '.pdf';
    const render = await timed(() => each.render({ inputPath: DOCX, outputPath: rendered }));
    return { input: 'docx', operation: 'render', ...render, pdf: pdf(rendered) };
  }));
} finally {
  await Promise.all(pair.map((each) => each.dispose()));
}
const concurrentPeak = peak();
const installedKiB = Object.fromEntries(['fonts-noto-cjk', 'fonts-dejavu-core'].map((name) =>
  [name, Number(execFileSync('dpkg-query', ['-W', '-f=\x24{Installed-Size}', name], { encoding: 'utf8' }))]));
process.stdout.write(JSON.stringify({
  uid: process.getuid(), memoryMax: cgroup('memory.max'),
  runtime: { backend: runtime.backend, version: runtime.version },
  resolution: { officeToPdf, kit: kitManifest },
  docxReadback, conversions, serialPeak, parallel, concurrentPeak, installedKiB,
}));
`;
}

/** The create flags of an employee instance (`orchestrator/start.ts`), with the fixtures read-only. */
function assertInstanceLimits(document: Record<string, unknown>): void {
  const host = record(document.HostConfig);
  deepStrictEqual(
    {
      Memory: host.Memory,
      MemorySwap: host.MemorySwap,
      PidsLimit: host.PidsLimit,
      NanoCpus: host.NanoCpus,
      NetworkMode: host.NetworkMode,
      User: record(document.Config).User,
    },
    {
      Memory: 4 * GiB,
      MemorySwap: 4 * GiB,
      PidsLimit: 512,
      NanoCpus: 2_000_000_000,
      NetworkMode: 'none',
      User: '1001',
    },
    'office-convert container must carry the instance limits',
  );
  assertSecurity(host, SECCOMP);
  const mounts = Array.isArray(document.Mounts) ? document.Mounts.map(record) : [];
  deepStrictEqual(
    mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })),
    [{ Type: 'bind', Source: FIXTURES, Destination: '/fixtures', RW: false }],
    'office-convert container must mount only a read-only /fixtures',
  );
}

/**
 * Create, start and boundedly wait for one conversion container; its stdout observation is
 * returned with the image's size, read here before cleanup removes the owned tag.
 */
export function runOfficeConvert(
  command: DockerCommand,
  targets: CleanupTarget[],
  run: { container: string; imageId: string; runId: string; docxScript: string },
): string {
  const { container, imageId, runId } = run;
  const create = [
    'create',
    '--user',
    '1001',
    '--network',
    'none',
    '--memory',
    '4g',
    '--memory-swap',
    '4g',
    '--pids-limit',
    '512',
    '--cpus',
    '2',
    '--security-opt',
    `seccomp=${SECCOMP}`,
    '--mount',
    `type=bind,source=${FIXTURES},target=/fixtures,readonly`,
    '--name',
    container,
    '--label',
    `${OWNER_LABEL}=${runId}`,
    imageId,
    'node',
    '--input-type=module',
    '-e',
    officeConvertScript(run.docxScript),
  ];
  registerCleanupTarget(targets, runId, { kind: 'container', name: container });
  output(command(create, 30_000), create);
  assertInstanceLimits(containerDocument(command(['container', 'inspect', container], 30_000)));
  const start = ['start', container];
  output(command(start, 30_000), start);
  const wait = ['wait', container];
  const exit = output(command(wait, CONVERSION_DEADLINE_MS), wait).replace(/\r?\n$/, '');
  const logs = command(['logs', container], 30_000);
  if (exit !== '0') {
    const oom = ['container', 'inspect', '--format', '{{.State.OOMKilled}}', container];
    throw new Error(
      `office-convert container exited ${exit} oomKilled=${command(oom, 30_000).stdout.trim()}:\n` +
        `${logs.stdout}\n${logs.stderr}`,
    );
  }
  const observed = record(JSON.parse(output(logs, ['logs', container])));
  const size = ['image', 'inspect', '--format', '{{.Size}}', imageId];
  const imageSize = Number(output(command(size, 30_000), size).trim());
  return JSON.stringify({ ...observed, imageSize });
}

interface Conversion {
  readonly input: string;
  readonly operation: 'render' | 'convert';
  readonly backend: string;
  readonly missingFonts: readonly string[];
  readonly ms: number;
  readonly pdf?: { bytes: number; header: string; trailer: string; cjkFonts: string[] };
  readonly text?: string;
}

interface OfficeObservation {
  readonly uid: number;
  readonly memoryMax: string | null;
  readonly runtime: { backend: string; version: string };
  readonly resolution: { officeToPdf: string; kit: string };
  readonly docxReadback: string;
  readonly conversions: readonly Conversion[];
  readonly serialPeak: number | null;
  readonly parallel: readonly Conversion[];
  readonly concurrentPeak: number | null;
  readonly installedKiB: Readonly<Record<string, number>>;
  readonly imageSize: number;
}

const DOC_MARKER = '旧格式探针 DOC：关于开展年度检查的通知';
const PPT_MARKER = '旧格式探针 PPT：工作汇报';
// offlineDocxScript's two paragraphs, then its 2x2 table cells row by row.
const DOCX_READBACK = [
  '离线办公验证',
  '中文段落：无需联网即可生成文档。',
  '项目',
  '状态',
  '文档生成',
  '成功',
].join('\n');
const DSH_MODULE =
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/(?:.+/)?@deepseek-ai/';

function assertRender(entry: Conversion | undefined, input: string): string {
  const label = `${input} render`;
  strictEqual(entry?.input, input, `${label} out of order`);
  strictEqual(entry.operation, 'render', `${label} out of order`);
  strictEqual(entry.backend, 'wasm', `${label} must use the WASM engine`);
  // For OLE inputs (DOC/PPT) the kit reports no document families, so [] is trivially true there;
  // the embedded CJK /BaseFont and the text readback discriminate. DOCX missingFonts is meaningful.
  deepStrictEqual(entry.missingFonts, [], `${label} reports missing fonts`);
  const { pdf } = entry;
  if (pdf === undefined) throw new Error(`${label} produced no PDF`);
  ok(pdf.header.startsWith('%PDF-'), `${label} is not a PDF`);
  strictEqual(pdf.trailer, '%%EOF', `${label} PDF does not end with %%EOF`);
  ok(pdf.cjkFonts.length > 0, `${label} PDF embeds no CJK font`);
  return `${input}:render=${String(entry.ms)}ms/${String(pdf.bytes)}B/${pdf.cjkFonts.join('+')}`;
}

function assertReadback(
  entry: Conversion | undefined,
  input: string,
  accept: (text: string) => boolean,
): string {
  strictEqual(entry?.input, input, `${input} convert out of order`);
  strictEqual(entry.operation, 'convert', `${input} convert out of order`);
  ok(
    accept(entry.text ?? ''),
    `${input} readback lost the Chinese markers: ${JSON.stringify(entry.text)}`,
  );
  return `${input}:convert=${String(entry.ms)}ms missingFonts=${JSON.stringify(entry.missingFonts)}`;
}

/** Independent oracle over the probe's facts; returns the evidence line's measurements. */
export function assertOfficeConversion(
  stdout: string,
  assertDocx: (stdout: string) => void,
): string {
  const observed = JSON.parse(stdout) as OfficeObservation;
  deepStrictEqual(
    [observed.uid, observed.memoryMax, observed.runtime.backend],
    [1001, String(4 * GiB), 'wasm'],
    'office-convert must run as uid1001 under a 4GiB cgroup with the WASM engine',
  );
  match(
    observed.resolution.officeToPdf,
    new RegExp(`^${DSH_MODULE}dsh-office-to-pdf/package\\.json$`),
  );
  match(observed.resolution.kit, new RegExp(`^${DSH_MODULE}libreoffice-kit/package\\.json$`));
  assertDocx(observed.docxReadback);
  const [docRender, doc, pptRender, ppt, docxRender, docx, extra] = observed.conversions;
  strictEqual(extra, undefined, 'office-convert must run exactly six serial conversions');
  strictEqual(observed.parallel.length, 2, 'office-convert must render twice in parallel');
  const peaks = [observed.serialPeak, observed.concurrentPeak];
  ok(
    peaks.every((value) => value === null) ||
      (peaks.every(Number.isSafeInteger) && Number(peaks[1]) >= Number(peaks[0])),
    `memory.peak must be absent or monotonic: ${JSON.stringify(peaks)}`,
  );
  const sizes = Object.values(observed.installedKiB);
  ok(
    sizes.length === 2 && sizes.every((value) => Number.isSafeInteger(value) && value > 0),
    'font package sizes missing',
  );
  ok(Number.isSafeInteger(observed.imageSize) && observed.imageSize > 0, 'image size missing');
  return [
    assertRender(docRender, 'doc'),
    assertReadback(doc, 'doc', (text) => text === DOC_MARKER),
    assertRender(pptRender, 'ppt'),
    assertReadback(ppt, 'ppt', (text) => text === PPT_MARKER),
    assertRender(docxRender, 'docx'),
    assertReadback(docx, 'docx', (text) => text === DOCX_READBACK),
    ...observed.parallel.map((entry) => `parallel-${assertRender(entry, 'docx')}`),
    `serialPeak=${String(observed.serialPeak)} concurrentPeak=${String(observed.concurrentPeak)}`,
    `installedKiB=${JSON.stringify(observed.installedKiB)} imageSize=${String(observed.imageSize)}`,
    `engine=${observed.runtime.version}`,
  ].join(' ');
}

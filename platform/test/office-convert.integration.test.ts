import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertOfficeConversion, ODT_TEXT, runOfficeConvert } from './office-convert-fixture.ts';
import { assertDocxReadback, offlineDocxScript, runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const seccomp = `${repositoryRoot}images/seccomp/dsh-user.json`;
const fixtures = `${repositoryRoot}platform/test/office-legacy`;
const imageId = `sha256:${'c'.repeat(64)}`;
const GiB = 1024 * 1024 * 1024;
const observation = { conversions: [] };

type Fault = 'memory' | 'network' | 'user' | 'writable' | 'seccomp' | 'oom';

/** Substitute daemon boundary for the office-convert probe: owned resources and every call. */
function daemon(fault?: Fault, fontsMount?: Record<string, unknown>) {
  const resources = new Map<string, string>([['dsh-team-test-sentinel', 'sentinel-owner']]);
  const calls: { args: readonly string[]; timeout: number }[] = [];
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const absent = (kind: string, name: string): DockerCommandResult => ({
    status: 1,
    stdout: '',
    stderr: `Error response from daemon: No such ${kind}: ${name}\n`,
  });
  // Docker normalizes the supplied seccomp path into the policy JSON in inspect.
  const policy = fault === 'seccomp' ? '{"defaultAction":"SCMP_ACT_ALLOW"}' : readFileSync(seccomp);
  const document = () => ({
    Config: { User: fault === 'user' ? 'dsh' : '1001' },
    HostConfig: {
      Memory: (fault === 'memory' ? 8 : 4) * GiB,
      MemorySwap: 4 * GiB,
      PidsLimit: 512,
      NanoCpus: 2_000_000_000,
      NetworkMode: fault === 'network' ? 'bridge' : 'none',
      SecurityOpt: [`seccomp=${String(policy)}`],
      CapAdd: null,
      Privileged: false,
      MaskedPaths: ['/proc/kcore'],
      ReadonlyPaths: ['/proc/bus'],
    },
    Mounts: [
      ...(fontsMount === undefined ? [] : [fontsMount]),
      { Type: 'bind', Source: fixtures, Destination: '/fixtures', RW: fault === 'writable' },
    ],
  });
  function inspect(kind: string, args: readonly string[]): DockerCommandResult {
    const name = args.at(-1) ?? '';
    // The probe reads the size by the built identity, before cleanup removes the owned tag.
    if (args.includes('{{.Size}}') && name === imageId) return ok('589000000\n');
    const owner = resources.get(name);
    if (owner === undefined) return absent(kind, name);
    if (args.includes('{{.Id}}')) return ok(`${imageId}\n`);
    if (args.includes('{{.State.OOMKilled}}')) return ok('true\n');
    if (!args.includes('--format')) return ok(JSON.stringify([document()]));
    return ok(`${owner}\n`);
  }
  // A built tag or created container is owned by its invocation label.
  function own(args: readonly string[], flag: '--tag' | '--name'): DockerCommandResult {
    const label = (args[args.indexOf('--label') + 1] ?? '').split('=')[1] ?? '';
    resources.set(args[args.indexOf(flag) + 1] ?? '', label);
    return ok();
  }
  const command: DockerCommand = (args, timeout) => {
    calls.push({ args: [...args], timeout });
    const [operation, subcommand] = args;
    if (operation === 'version') return ok('28.0.0\n');
    if (operation === 'build') return own(args, '--tag');
    if (operation === 'create') return own(args, '--name');
    if (operation === 'start') return ok();
    if (operation === 'wait') return ok(fault === 'oom' ? '137\n' : '0\n');
    if (operation === 'logs') return ok(JSON.stringify(observation));
    if (subcommand === 'inspect') return inspect(operation ?? '', args);
    if (subcommand === 'rm') {
      resources.delete(args.at(-1) ?? '');
      return ok();
    }
    throw new Error(`Unexpected Docker boundary call: ${args.join(' ')}`);
  };
  const operations = () => calls.map(({ args }) => args[0]);
  return { command, calls, resources, operations };
}

describe('office-convert user-image probe', () => {
  it('creates the probe under instance limits with the fixture mount, waits 300s and adds the image size', () => {
    const fake = daemon();
    let observed: unknown;

    runUserImage(
      'office-convert',
      (stdout) => {
        observed = JSON.parse(stdout);
      },
      fake.command,
    );

    const create = fake.calls.find(({ args }) => args[0] === 'create')?.args ?? [];
    const image = create.indexOf(imageId);
    expect(create.slice(1, image)).toEqual([
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
      `seccomp=${seccomp}`,
      '--mount',
      `type=bind,source=${fixtures},target=/fixtures,readonly`,
      '--name',
      expect.stringMatching(/^dsh-team-test-.+-office-convert$/),
      '--label',
      expect.stringMatching(/^dsh-team\.test-run=/),
    ]);
    expect(create.slice(image + 1, -1)).toEqual(['node', '--input-type=module', '-e']);
    const script = create.at(-1) ?? '';
    expect(script).toContain(JSON.stringify(offlineDocxScript));
    expect(script).toContain('/fixtures/probe.doc');
    expect(script).toContain('/fixtures/probe.ppt');
    // The DOCX with a table hangs the WASM engine's txt export; it reads back through odt.
    expect(script).toContain("['docx', DOCX, 'odt']");
    expect(script).not.toContain("['docx', DOCX, 'txt']");
    expect(script).toContain(JSON.stringify(ODT_TEXT));
    expect(fake.calls.find(({ args }) => args[0] === 'wait')?.timeout).toBe(300_000);
    expect(fake.calls.find(({ args }) => args[0] === 'start')?.args).not.toContain('--attach');
    expect(observed).toEqual({ ...observation, imageSize: 589_000_000 });
    expect([...fake.resources]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it.each([
    ['memory', 'instance limits'],
    ['network', 'instance limits'],
    ['user', 'instance limits'],
    ['writable', 'read-only /fixtures'],
    ['seccomp', 'Expected values to be strictly deep-equal'],
  ] as const)(
    'refuses to start a probe whose inspect shows a weakened %s and still cleans up',
    (fault, message) => {
      const fake = daemon(fault);

      expect(() => runUserImage('office-convert', () => undefined, fake.command)).toThrow(message);
      expect(fake.operations()).not.toContain('start');
      expect([...fake.resources]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
    },
  );

  it('reports an OOM-killed conversion with its exit status instead of an observation', () => {
    const fake = daemon('oom');

    expect(() => runUserImage('office-convert', () => undefined, fake.command)).toThrow(
      'office-convert container exited 137 oomKilled=true',
    );
    expect([...fake.resources]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });

  it('throws on an unknown probe instead of falling back to the offline DOCX script', () => {
    const fake = daemon();

    expect(() =>
      runUserImage('office-render' as 'office-convert', () => undefined, fake.command),
    ).toThrow('Unknown user-image probe: office-render');
    expect(fake.operations()).not.toContain('create');
    expect([...fake.resources]).toEqual([['dsh-team-test-sentinel', 'sentinel-owner']]);
  });
});

/** offlineDocxScript's paragraphs and table cells, as the odt readback lists them. */
const DOCX_ODT_TEXT = '离线办公验证\n中文段落：无需联网即可生成文档。\n项目\n状态\n文档生成\n成功';
const DSH_MODULES = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pdf = {
  bytes: 14_383,
  header: '%PDF-1.7',
  trailer: '%%EOF',
  cjkFonts: ['ABCDEF+NotoSansCJKsc-Regular'],
};
const render = (input: string) => ({
  input,
  operation: 'render',
  backend: 'wasm',
  missingFonts: [],
  ms: 2100,
  pdf,
});
const convert = (input: string, text: string) => ({
  input,
  operation: 'convert',
  backend: 'wasm',
  missingFonts: [],
  ms: 1900,
  text,
});
/** The #554 measurements with fonts installed, shaped as the probe reports them. */
function accepted(): Record<string, unknown> {
  return {
    uid: 1001,
    memoryMax: '4294967296',
    runtime: { backend: 'wasm', version: '0.1.5' },
    resolution: {
      officeToPdf: `${DSH_MODULES}/dsh-office-to-pdf/package.json`,
      kit: `${DSH_MODULES}/libreoffice-kit/package.json`,
    },
    docxReadback: `${JSON.stringify({
      effectiveUid: 1001,
      path: '/data/work/offline.docx',
      paragraphs: ['离线办公验证', '中文段落：无需联网即可生成文档。'],
      tables: [
        [
          ['项目', '状态'],
          ['文档生成', '成功'],
        ],
      ],
    })}\n`,
    conversions: [
      render('doc'),
      convert('doc', '旧格式探针 DOC：关于开展年度检查的通知'),
      render('ppt'),
      convert('ppt', '旧格式探针 PPT：工作汇报'),
      render('docx'),
      convert('docx', DOCX_ODT_TEXT),
    ],
    serialPeak: 2_140_000_000,
    parallel: [render('docx'), render('docx')],
    concurrentPeak: 3_100_000_000,
    installedKiB: { 'fonts-noto-cjk': 91_003, 'fonts-dejavu-core': 2960 },
    imageSize: 589_000_000,
  };
}
type Observation = ReturnType<typeof accepted>;
const replaceConversion =
  (index: number, change: Record<string, unknown>) => (observed: Observation) => {
    const conversions = [...(observed.conversions as Record<string, unknown>[])];
    conversions[index] = { ...conversions[index], ...change };
    return { ...observed, conversions };
  };

const FONTS = { directory: '/owned/instance-fonts', family: 'DshTmP Sans', baseFont: 'DshTmP' };
const FONTS_MOUNT = {
  Type: 'bind',
  Source: FONTS.directory,
  Destination: '/usr/share/fonts/truetype/custom',
  RW: false,
};

describe('office-convert probe with an instance fonts directory', () => {
  const run = (fake: ReturnType<typeof daemon>) =>
    runOfficeConvert(fake.command, {
      container: 'dsh-team-test-fonts-office-convert',
      imageId,
      runId: 'fonts',
      docxScript: offlineDocxScript,
      fonts: FONTS,
    });

  it('binds the directory read-only at the instance fonts path and renders its family', () => {
    const fake = daemon(undefined, FONTS_MOUNT);

    expect(JSON.parse(run(fake))).toEqual({ ...observation, imageSize: 589_000_000 });

    const create = fake.calls.find(({ args }) => args[0] === 'create')?.args ?? [];
    const mounts = create.flatMap((arg, index) => (create[index - 1] === '--mount' ? [arg] : []));
    expect(mounts).toEqual([
      `type=bind,source=${fixtures},target=/fixtures,readonly`,
      'type=bind,source=/owned/instance-fonts,target=/usr/share/fonts/truetype/custom,readonly',
    ]);
    const script = create.at(-1) ?? '';
    expect(script).toContain('"family":"DshTmP Sans","baseFont":"DshTmP"');
    expect(script).toContain('qn(\\"w:ascii\\"), family');
    expect(script).toContain('qn(\\"w:hAnsi\\"), family');
  });

  it.each([
    ['without the fonts bind', undefined],
    ['with a writable fonts bind', { ...FONTS_MOUNT, RW: true }],
    ['with another fonts source', { ...FONTS_MOUNT, Source: '/owned/other-fonts' }],
  ])('refuses to start a probe inspected %s', (_, mount) => {
    const fake = daemon(undefined, mount);

    expect(() => run(fake)).toThrow('read-only /fixtures and fonts');
    expect(fake.operations()).not.toContain('start');
  });
});

describe('office-convert observation oracle', () => {
  it('accepts the fonts-installed conversion facts and reports every measurement', () => {
    const evidence = assertOfficeConversion(JSON.stringify(accepted()), assertDocxReadback);

    expect(evidence).toContain('docx:render=2100ms/14383B/ABCDEF+NotoSansCJKsc-Regular');
    expect(evidence).toContain('serialPeak=2140000000 concurrentPeak=3100000000');
    expect(evidence).toContain('imageSize=589000000');
  });

  it('records absent memory.peak as null on kernels before 5.19', () => {
    const observed = { ...accepted(), serialPeak: null, concurrentPeak: null };

    expect(assertOfficeConversion(JSON.stringify(observed), assertDocxReadback)).toContain(
      'serialPeak=null concurrentPeak=null',
    );
  });

  it.each([
    [
      'no CJK font',
      replaceConversion(0, { pdf: { ...pdf, cjkFonts: [] } }),
      'doc render PDF embeds no CJK font',
    ],
    [
      'a missing DOCX font',
      replaceConversion(4, { missingFonts: ['Calibri'] }),
      'docx render reports missing fonts',
    ],
    [
      'a truncated PDF',
      replaceConversion(2, { pdf: { ...pdf, trailer: 'obj\n' } }),
      'ppt render PDF does not end with %%EOF',
    ],
    [
      'a native engine',
      replaceConversion(0, { backend: 'native' }),
      'doc render must use the WASM engine',
    ],
    [
      'a lost DOC marker',
      replaceConversion(1, { text: '旧格式探针 DOC：' }),
      'doc readback lost the Chinese markers',
    ],
    [
      'a lost PPT marker',
      replaceConversion(3, { text: '' }),
      'ppt readback lost the Chinese markers',
    ],
    [
      'a lost DOCX paragraph',
      replaceConversion(5, { text: DOCX_ODT_TEXT.replace('离线办公验证\n', '') }),
      'docx readback lost the Chinese markers',
    ],
    [
      'a lost DOCX table cell',
      replaceConversion(5, { text: DOCX_ODT_TEXT.replace('\n成功', '') }),
      'docx readback lost the Chinese markers',
    ],
    [
      'reordered DOCX table cells',
      replaceConversion(5, { text: DOCX_ODT_TEXT.replace('项目\n状态', '状态\n项目') }),
      'docx readback lost the Chinese markers',
    ],
    [
      'the paragraphs-only txt-shaped DOCX readback',
      replaceConversion(5, { text: '离线办公验证\n中文段落：无需联网即可生成文档。\n' }),
      'docx readback lost the Chinese markers',
    ],
    ['a swapped order', replaceConversion(0, { input: 'ppt' }), 'doc render out of order'],
    [
      'a seventh conversion',
      (o: Observation) => ({ ...o, conversions: [...(o.conversions as unknown[]), render('doc')] }),
      'exactly six',
    ],
    [
      'one parallel render',
      (o: Observation) => ({ ...o, parallel: [render('docx')] }),
      'twice in parallel',
    ],
    [
      'a failed parallel render',
      (o: Observation) => ({
        ...o,
        parallel: [render('docx'), { ...render('docx'), missingFonts: ['SimSun'] }],
      }),
      'docx render reports missing fonts',
    ],
    ['a larger cgroup', (o: Observation) => ({ ...o, memoryMax: 'max' }), 'under a 4GiB cgroup'],
    [
      'a kit outside DSH',
      (o: Observation) => ({
        ...o,
        resolution: { ...(o.resolution as object), kit: '/tmp/libreoffice-kit/package.json' },
      }),
      'libreoffice-kit',
    ],
    [
      'a non-monotonic peak',
      (o: Observation) => ({ ...o, concurrentPeak: 1 }),
      'absent or monotonic',
    ],
    [
      'a missing font package size',
      (o: Observation) => ({ ...o, installedKiB: { 'fonts-noto-cjk': 91_003 } }),
      'font package sizes',
    ],
    [
      'a wrong DOCX readback',
      (o: Observation) => ({ ...o, docxReadback: '{}' }),
      'Offline DOCX readback',
    ],
  ] as const)('rejects %s', (_name, change, message) => {
    expect(() =>
      assertOfficeConversion(JSON.stringify(change(accepted())), assertDocxReadback),
    ).toThrow(message);
  });

  const fontRender = {
    ...render('fonts-docx'),
    pdf: { ...pdf, cjkFonts: [], namedFonts: ['GHIJKL+DshTmPSans'] },
  };

  it('accepts the fonts render of the bound family and reports its embedded font', () => {
    const observed = { ...accepted(), fontRender };

    expect(assertOfficeConversion(JSON.stringify(observed), assertDocxReadback, FONTS)).toContain(
      'fonts:render=2100ms/GHIJKL+DshTmPSans',
    );
  });

  it.each([
    ['an unrendered family', { fontRender: null }, FONTS, 'did not render the fonts DOCX'],
    [
      'a missing family',
      { fontRender: { ...fontRender, missingFonts: ['DshTmP Sans'] } },
      FONTS,
      'fonts render misses DshTmP Sans',
    ],
    [
      'no embedded family font',
      { fontRender: { ...fontRender, pdf: { ...fontRender.pdf, namedFonts: [] } } },
      FONTS,
      'fonts render PDF embeds no DshTmP font',
    ],
    ['a fonts render without a directory', { fontRender }, undefined, 'without a fonts directory'],
  ] as const)('rejects %s', (_name, change, fonts, message) => {
    const observed = { ...accepted(), ...change };

    expect(() =>
      assertOfficeConversion(JSON.stringify(observed), assertDocxReadback, fonts),
    ).toThrow(message);
  });
});

const ODF = (prefix: string) => `urn:oasis:names:tc:opendocument:xmlns:${prefix}`;
/** The shape Writer exports for offlineDocxScript: spans, a table, then the trailing empty paragraph. */
const WRITER_CONTENT =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  `<office:document-content xmlns:office="${ODF('office:1.0')}" xmlns:text="${ODF('text:1.0')}" ` +
  `xmlns:table="${ODF('table:1.0')}" office:version="1.3"><office:body><office:text>` +
  '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>' +
  '<text:p text:style-name="P1"><text:span text:style-name="T1">离线</text:span>办公验证</text:p>' +
  '<text:p text:style-name="P1">中文段落：无需联网即可生成文档。</text:p>' +
  '<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/>' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>项目</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="string"><text:p>状态</text:p></table:table-cell></table:table-row>' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>文档生成</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="string"><text:p><text:span>成功</text:span></text:p></table:table-cell>' +
  '</table:table-row></table:table><text:p text:style-name="Standard"/></office:text></office:body>' +
  '</office:document-content>';
// Builds the archive with python3 zipfile, the reader's own library, then runs the reader on it.
const ARCHIVE = String.raw`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("mimetype", "application/vnd.oasis.opendocument.text")
    archive.writestr("content.xml", sys.argv[2])
`;

function readOdt(content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-test-odt-'));
  try {
    const path = join(directory, 'docx.odt');
    const built = spawnSync('python3', ['-c', ARCHIVE, path, content], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    return spawnSync('python3', ['-c', ODT_TEXT, path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('office-convert odt readback', () => {
  it('lists the body paragraphs then every table cell, dropping the trailing empty paragraph', () => {
    const read = readOdt(WRITER_CONTENT);

    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe(DOCX_ODT_TEXT);
  });

  it('fails loud on an odt without a text body instead of reporting empty text', () => {
    const read = readOdt(WRITER_CONTENT.replaceAll('office:text>', 'office:spreadsheet>'));

    expect(read.status).not.toBe(0);
    expect(read.stdout).toBe('');
    expect(read.stderr).toContain('AttributeError');
  });
});

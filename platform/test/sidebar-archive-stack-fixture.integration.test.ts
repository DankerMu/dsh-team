import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { byName, parseTarGz } from './sidebar-archive-stack-fixture.ts';

const GNU = 'ustar  \u0000';
const USTAR = 'ustar\u000000';
const TEXT = Buffer.from('第一行：打包下载。\n第二行：结束。\n', 'utf8');
const BINARY = Buffer.from(Array.from({ length: 700 }, (_, index) => (index * 37) % 256));
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// One header laid out by hand at the GNU tar manual's field offsets, with its checksum: the byte
// sum with the chksum field read as eight spaces, written `%06o\0 `.
function header(name: string, size: number, magic: string, type = '0'): Buffer {
  const block = Buffer.alloc(512);
  const put = (offset: number, text: string) => block.write(text, offset, 'utf8');
  put(0, name);
  put(100, '0000644\u0000');
  for (const offset of [108, 116]) put(offset, '0001751\u0000');
  put(124, `${size.toString(8).padStart(11, '0')}\u0000`);
  put(136, '15050243400\u0000');
  put(148, '        ');
  put(156, type);
  put(257, magic);
  for (const offset of [265, 297]) put(offset, 'node\u0000');
  if (magic === USTAR) for (const offset of [329, 337]) put(offset, '0000000\u0000');
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\u0000 `);
  return block;
}

const member = (name: string, data: Buffer, magic = GNU, type = '0') =>
  Buffer.concat([header(name, data.length, magic, type), data, Buffer.alloc(-data.length & 511)]);

/** GNU tar's default output: the members, two zero blocks, then zeros up to the 10240-byte record. */
function record(members: readonly Buffer[]): Buffer {
  const body = Buffer.concat([...members, Buffer.alloc(1024)]);
  return Buffer.concat([body, Buffer.alloc((10240 - (body.length % 10240)) % 10240)]);
}

const sample = (magic: string) =>
  record([member('打包甲.txt', TEXT, magic), member('archive-b.bin', BINARY, magic)]);
const text = { name: '打包甲.txt', size: TEXT.length, sha256: sha256(TEXT) };
const binary = { name: 'archive-b.bin', size: 700, sha256: sha256(BINARY) };
const expected = [text, binary];

it('reads a GNU tar.gz record: UTF-8 names, sizes and sha256 of each regular file', () => {
  const tar = sample(GNU);

  const contents = parseTarGz(gzipSync(tar));

  expect(tar.length).toBe(10240);
  expect(contents).toEqual({ format: 'gnu', entries: expected });
});

it('reads a POSIX ustar tar.gz the same way and names its format', () => {
  expect(parseTarGz(gzipSync(sample(USTAR)))).toEqual({ format: 'ustar', entries: expected });
});

const corrupted = sample(GNU).fill(0x41, 3, 4);
const trailing = sample(GNU).fill(1, 10239);
const truncated = Buffer.concat([member('a.txt', TEXT), Buffer.alloc(512)]);
const mixed = record([member('a', TEXT), member('b', TEXT, USTAR)]);

it.each([
  ['input without the gzip magic', sample(GNU), /not gzip/],
  ['a header whose checksum does not match', gzipSync(corrupted), /checksum/],
  ['a GNU long-name member', gzipSync(record([member('././@LongLink', TEXT, GNU, 'L')])), /type L/],
  ['a pax extended header', gzipSync(record([member('pax', TEXT, USTAR, 'x')])), /type x/],
  ['a member whose data is cut short', gzipSync(header('a.bin', 700, GNU)), /truncated/],
  ['GNU and ustar headers mixed', gzipSync(mixed), /mixed/],
  ['an archive with one end block', gzipSync(truncated), /end blocks/],
  ['a nonzero byte after the end blocks', gzipSync(trailing), /end blocks/],
  ['an unknown header magic', gzipSync(record([member('a.txt', TEXT, 'ustar\u0000  ')])), /magic/],
])('rejects %s', (_case, input, message) => {
  expect(() => parseTarGz(input)).toThrow(message);
});

it('compares entries by name in any order, and tells a prefixed, extra or changed entry apart', () => {
  expect(byName([binary, text])).toEqual(byName(expected));
  for (const archived of [
    [{ ...text, name: `work/${text.name}` }, binary],
    [text, binary, binary],
    [text, { ...binary, size: 1 }],
    [text, { ...binary, sha256: sha256(TEXT) }],
  ])
    expect(byName(archived)).not.toEqual(byName(expected));
});

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { retiringOnError } from './office-editor-stack-fixture.ts';
import {
  archiveScenario,
  byName,
  parseTarGz,
  withWorkFiles,
} from './sidebar-archive-stack-fixture.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { everythingPrinted } from './stack-browser-fixture.ts';

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

// Two Document Server keys: the lane's in a socket URL with a query, the cleanup's in a path.
const LANE_KEY = 'c7'.repeat(32);
const CLEANUP_KEY = '5e'.repeat(32);
const LANE_FAILURE = `lane /doc/${LANE_KEY}/c/?EIO=4`;
const REASONS = ['lane /doc/<redacted>/c/', 'cleanup /doc/<redacted>/f'];
/** The instance: the provider (archiveDownload's first call) rejects with the lane's failure,
 * every command with the cleanup's; `removed` answers the removal instead when given. */
const failingLane = (removed?: string): ArchiveLane => ({
  session: {
    ...{ base: 'http://127.0.0.1:1', directory: '/nonexistent' },
    ...{ email: 'a@x.test', password: 'p', timeout: 500 },
  },
  exec: () =>
    removed === undefined
      ? Promise.reject(new Error(`cleanup /doc/${CLEANUP_KEY}/f`))
      : Promise.resolve(removed),
  provider: () => Promise.reject(new Error(LANE_FAILURE)),
});
/** The thrown error is plain and holds both reasons once, scrubbed, and neither key anywhere. */
const foldedOnce = (error: unknown, label: string) => {
  expect(error).not.toBeInstanceOf(AggregateError);
  expect(error).toBeInstanceOf(Error);
  expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
  expect(Object.hasOwn(error as Error, 'errors')).toBe(false);
  const { message } = error as Error;
  expect(message).toBe(`${label} lane and cleanup failed [${REASONS.join('; ')}]`);
  for (const reason of REASONS) expect(message.split(reason)).toHaveLength(2);
  const printed = everythingPrinted(error);
  for (const secret of [LANE_KEY, CLEANUP_KEY, 'EIO=4']) expect(printed).not.toContain(secret);
};

it('folds a lane and a cleanup failure of the archive scenario into one plain scrubbed error', async () => {
  const error = await archiveScenario(failingLane()).catch((caught: unknown) => caught);

  foldedOnce(error, 'Sidebar archive');
});

it('folds them the same inside a retirement wrapper whose retirement succeeds', async () => {
  const lane = failingLane();

  const error = await retiringOnError(
    () =>
      withWorkFiles(lane, ['x.docx'], 'Office editor', () =>
        Promise.reject(new Error(LANE_FAILURE)),
      ),
    () => Promise.resolve(),
  ).catch((caught: unknown) => caught);

  foldedOnce(error, 'Office editor');
});

it('prints each reason once when the retirement around the double failure fails too', async () => {
  const lane = failingLane();
  const body = () =>
    withWorkFiles(lane, ['x.docx'], 'Office editor', () => Promise.reject(new Error(LANE_FAILURE)));

  const error = await retiringOnError(body, () =>
    Promise.reject(new Error('disable failed')),
  ).catch((caught: unknown) => caught);

  const inner = `Office editor lane and cleanup failed [${REASONS.join('; ')}]`;
  expect((error as Error).message).toBe(
    `Office editor lane and retiring B failed [${inner}; disable failed]`,
  );
  for (const reason of REASONS) expect((error as Error).message.split(reason)).toHaveLength(2);
  for (const secret of [LANE_KEY, CLEANUP_KEY])
    expect(everythingPrinted(error)).not.toContain(secret);
});

it('rethrows a lane failure alone as the same object after a clean removal', async () => {
  const failure = new Error(LANE_FAILURE);

  const run = withWorkFiles(failingLane('[false]'), ['x.docx'], 'L', () => Promise.reject(failure));

  await expect(run).rejects.toBe(failure);
});

it('returns the lane evidence after a clean removal and fails on a file left behind', async () => {
  const run = () => Promise.resolve('evidence');

  expect(await withWorkFiles(failingLane('[false]'), ['x.docx'], 'L', run)).toBe('evidence');
  await expect(withWorkFiles(failingLane('[true]'), ['x.docx'], 'L', run)).rejects.toThrow(
    'L files removed',
  );
});

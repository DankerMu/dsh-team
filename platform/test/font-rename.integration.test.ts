import { describe, expect, it } from 'vitest';
import { renameFontFamily } from './font-rename-fixture.ts';

interface NameRecord {
  readonly platform: number;
  readonly encoding: number;
  readonly nameId: number;
  readonly text: string;
}

function encoded(platform: number, text: string): Buffer {
  if (platform === 1) return Buffer.from(text, 'latin1');
  const bytes = Buffer.from(text, 'utf16le');
  return bytes.swap16();
}

/** A minimal sfnt: the offset table, one table record, and that table built as a `name` table. */
function ttf(records: readonly NameRecord[], tag = 'name'): Buffer {
  const strings = records.map(({ platform, text }) => encoded(platform, text));
  const header = Buffer.alloc(6 + 12 * records.length);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  records.forEach(({ platform, encoding, nameId }, index) => {
    const at = 6 + 12 * index;
    const length = strings[index]?.length ?? 0;
    for (const [field, value] of [platform, encoding, 0, nameId, length, offset].entries())
      header.writeUInt16BE(value, at + 2 * field);
    offset += length;
  });
  const table = Buffer.concat([header, ...strings]);
  const directory = Buffer.alloc(12 + 16);
  directory.writeUInt32BE(0x00010000, 0);
  directory.writeUInt16BE(1, 4);
  directory.write(tag, 12, 'latin1');
  directory.writeUInt32BE(0x12345678, 16);
  directory.writeUInt32BE(directory.length, 20);
  directory.writeUInt32BE(table.length, 24);
  return Buffer.concat([directory, table]);
}

const FAMILY = [
  { platform: 0, encoding: 3, nameId: 1, text: 'DejaVu Sans' },
  { platform: 1, encoding: 0, nameId: 1, text: 'DejaVu Sans' },
  { platform: 3, encoding: 1, nameId: 1, text: 'DejaVu Sans' },
  { platform: 3, encoding: 1, nameId: 4, text: 'DejaVu Sans Book, DejaVu' },
  { platform: 3, encoding: 1, nameId: 2, text: 'Book' },
];

describe('renameFontFamily', () => {
  it('replaces the family in place in every Unicode and Macintosh record', () => {
    const original = ttf(FAMILY);
    const input = Buffer.from(original);

    const renamed = renameFontFamily(input, 'DejaVu', 'DshTmP');

    expect(renamed).toEqual(
      ttf(
        FAMILY.map((record) => ({ ...record, text: record.text.replaceAll('DejaVu', 'DshTmP') })),
      ),
    );
    // The directory, checksum, offsets and lengths are those of the original font.
    expect(renamed.subarray(0, 28 + 6 + 12 * FAMILY.length)).toEqual(
      original.subarray(0, 28 + 6 + 12 * FAMILY.length),
    );
    expect(input).toEqual(original);
  });

  it('rejects names of different lengths before reading the font', () => {
    expect(() => renameFontFamily(ttf(FAMILY), 'DejaVu', 'DshTmPx')).toThrow(
      'Font family rename requires equal-length ASCII names',
    );
  });

  it('rejects a font without a name table', () => {
    expect(() => renameFontFamily(ttf(FAMILY, 'head'), 'DejaVu', 'DshTmP')).toThrow(
      'Font has no name table',
    );
  });

  it('rejects a font whose names never contain the family', () => {
    const other = FAMILY.map((record) => ({ ...record, text: 'Noto Sans' }));

    expect(() => renameFontFamily(ttf(other), 'DejaVu', 'DshTmP')).toThrow(
      'Font name table never names DejaVu',
    );
  });

  it('rejects a rename that leaves the family in a record', () => {
    const record = { platform: 3, encoding: 1, nameId: 1, text: 'abb' };

    expect(() => renameFontFamily(ttf([record]), 'ab', 'aa')).toThrow(
      'Font name record still names ab',
    );
  });
});

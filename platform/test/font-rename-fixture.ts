import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** Platforms 0 (Unicode) and 3 (Windows) store UTF-16BE; 1 (Macintosh) stores single bytes. */
const ENCODINGS: Readonly<
  Partial<Record<number, { step: number; encode: (text: string) => Buffer }>>
> = {
  0: { step: 2, encode: (text) => Buffer.from(text, 'utf16le').swap16() },
  1: { step: 1, encode: (text) => Buffer.from(text, 'latin1') },
  3: { step: 2, encode: (text) => Buffer.from(text, 'utf16le').swap16() },
};

/** First occurrence at or after `from` aligned to the record's code-unit width, or -1. */
function aligned(view: Buffer, pattern: Buffer, step: number, from = 0): number {
  let at = view.indexOf(pattern, from);
  while (at !== -1 && at % step !== 0) at = view.indexOf(pattern, at + 1);
  return at;
}

function nameTableOffset(font: Buffer): number {
  const tables = font.readUInt16BE(4);
  for (let index = 0; index < tables; index += 1) {
    const record = 12 + 16 * index;
    if (font.toString('latin1', record, record + 4) === 'name')
      return font.readUInt32BE(record + 8);
  }
  throw new Error('Font has no name table');
}

/**
 * A copy of `bytes` whose `name` records read `to` wherever they read `from`. Equal lengths keep
 * every table offset and length; neither the kit nor FreeType verifies table checksums.
 */
export function renameFontFamily(bytes: Uint8Array, from: string, to: string): Buffer {
  if (from.length !== to.length || !/^[\x20-\x7e]+$/.test(from + to))
    throw new Error('Font family rename requires equal-length ASCII names');
  const font = Buffer.from(bytes);
  const table = nameTableOffset(font);
  const count = font.readUInt16BE(table + 2);
  const strings = table + font.readUInt16BE(table + 4);
  let replaced = 0;
  for (let index = 0; index < count; index += 1) {
    const record = table + 6 + 12 * index;
    const encoding = ENCODINGS[font.readUInt16BE(record)];
    if (encoding === undefined) continue;
    const start = strings + font.readUInt16BE(record + 10);
    const view = font.subarray(start, start + font.readUInt16BE(record + 8));
    const [source, target] = [encoding.encode(from), encoding.encode(to)];
    for (let at = aligned(view, source, encoding.step); at !== -1; replaced += 1) {
      target.copy(view, at);
      at = aligned(view, source, encoding.step, at + source.length);
    }
    if (aligned(view, source, encoding.step) !== -1)
      throw new Error(`Font name record still names ${from}`);
  }
  if (replaced === 0) throw new Error(`Font name table never names ${from}`);
  return font;
}

/** The renamed DejaVu Sans family and the token of its PostScript name in PDF `/BaseFont`s. */
export const RENAMED_FONT = { family: 'DshTmP Sans', baseFont: 'DshTmP' } as const;

/**
 * The image's own DejaVu Sans, copied out of a never-started owned container and renamed to
 * `RENAMED_FONT` in a 0755 directory under `root` holding one 0644 file. No licensed font is used.
 */
export function renamedFontDirectory(
  lifecycle: Pick<UserImageLifecycle, 'command' | 'imageId' | 'runId' | 'registerContainer'>,
  root: string,
): { readonly directory: string } & typeof RENAMED_FONT {
  const source = `dsh-team-test-${lifecycle.runId}-font-source`;
  lifecycle.registerContainer(source);
  const label = `${OWNER_LABEL}=${lifecycle.runId}`;
  const create = ['create', '--name', source, '--label', label, lifecycle.imageId, 'true'];
  output(lifecycle.command(create, 30_000), create);
  const copied = join(root, 'DejaVuSans.ttf');
  const font = `${source}:/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`;
  const copy = ['cp', '--follow-link', font, copied];
  output(lifecycle.command(copy, 30_000), copy);
  const directory = join(root, 'instance-fonts');
  mkdirSync(directory);
  chmodSync(directory, 0o755);
  const renamed = join(directory, 'DshTmPSans.ttf');
  writeFileSync(renamed, renameFontFamily(readFileSync(copied), 'DejaVu', 'DshTmP'));
  chmodSync(renamed, 0o644);
  return { directory, ...RENAMED_FONT };
}

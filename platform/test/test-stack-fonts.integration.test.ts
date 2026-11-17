import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { probeFonts } from '../../scripts/test-stack.mjs';

// The real font prerequisite of `pnpm test:stack` (§51-g); test-stack.integration.test.ts injects it.
const nested = (name: string) => async (fonts: string) => {
  await mkdir(join(fonts, 'custom'));
  if (name !== '') await writeFile(join(fonts, 'custom', name), '');
};

it.each<[string, boolean, (fonts: string) => Promise<unknown>]>([
  ['a missing directory', false, (fonts) => rm(fonts, { recursive: true })],
  ['an empty directory', false, () => Promise.resolve()],
  ['only an empty subdirectory', false, nested('')],
  ['only .DS_Store', false, (fonts) => writeFile(join(fonts, '.DS_Store'), '')],
  ['a .TTF file in a subdirectory', true, nested('SimHei.TTF')],
])('probes the font directory with %s as %s', async (_case, expected, arrange) => {
  const fonts = await mkdtemp(join(tmpdir(), 'dsh-team-stack-fonts-'));
  try {
    await arrange(fonts);
    expect(probeFonts(fonts)).toBe(expected);
  } finally {
    await rm(fonts, { recursive: true, force: true });
  }
});

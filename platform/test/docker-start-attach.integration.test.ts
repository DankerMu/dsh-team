import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// `start --attach` mirrors the container's exit, so a nonzero one-shot container leaves an
// unsettled custody row; fixtures start, boundedly wait and read logs instead.
const ATTACHED_START = /'start',\s*'--attach'/g;

it('keeps one-shot Docker test containers off start --attach', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const self = basename(fileURLToPath(import.meta.url));
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== self)
    .sort();
  expect(files).toContain('user-image-fixture.ts');
  const sites = files.flatMap((file) => {
    const source = readFileSync(join(directory, file), 'utf8');
    return [...source.matchAll(ATTACHED_START)].map(
      ({ index }) => `${file}:${String(source.slice(0, index).split('\n').length)}`,
    );
  });

  expect(sites).toEqual([]);
});

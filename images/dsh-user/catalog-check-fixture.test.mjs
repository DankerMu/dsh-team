import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { verifyCatalog } from './catalog-check.mjs';
import {
  imageTree,
  removeImageTrees,
  repositoryCatalog,
  verify,
} from './catalog-check-fixture.mjs';

afterEach(removeImageTrees);

it('records exactly the toolchain and DSH in the fake image baseline', () => {
  const { baseline } = imageTree();

  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({
    globals: ['@deepseek-ai/dsh', 'corepack', 'npm', 'pnpm'],
  });
});

it('accepts the consistent image with the repository catalog and writes nothing', () => {
  const tree = imageTree();

  expect(verify(tree)).toEqual({ status: 0, stderr: '' });
  expect(verifyCatalog(tree.root, repositoryCatalog, tree.baseline)).toEqual({ problems: [] });
});

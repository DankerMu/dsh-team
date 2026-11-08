import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SUBTREES = new Set(['platform/src/**', 'platform/web/src/**']);
const GLOBAL_EXCLUDES = ['**/.env', '**/.env.*', '**/.git', '**/node_modules', '**/.run'];

/** Effective rules of the platform build-context allowlist, comments and blank lines removed. */
function rules() {
  return readFileSync(join(root, 'platform/Dockerfile.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Exact git-tracked paths: no pathspec (directories would match) and no stat (ignored artifacts would). */
function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
  return new Set(output.split('\0').filter((path) => path !== ''));
}

it('starts by excluding the whole context', () => {
  expect(rules()[0]).toBe('**');
});

it('ends with the global excludes so no later re-inclusion can override them', () => {
  expect(rules().slice(-GLOBAL_EXCLUDES.length)).toEqual(GLOBAL_EXCLUDES);
});

it('re-includes only tracked files or the two fixed source subtrees', () => {
  const tracked = trackedFiles();
  const offending = rules().filter((rule) => {
    if (!rule.startsWith('!')) return false;
    const path = rule.slice(1);
    return !SUBTREES.has(path) && !tracked.has(path);
  });
  expect(offending, 're-inclusions that are neither tracked files nor fixed subtrees').toEqual([]);
});

import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// The published client.js is neither vendored nor fetched: every synthetic tree reaches at most
// the input-hash check. The real success path is the user-image build and its Docker cases.
const SCRIPT = fileURLToPath(
  new URL('../../images/dsh-user/patch-plugin-manager.mjs', import.meta.url),
);
const PACKAGE_DIR = ['@deepseek-ai', 'dsh-client-ui-plugin-manager'];
const VERSION = '0.2.0-rc.2';
const CONTENT_MARKER = 'synthetic-client-content-not-for-diagnostics';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-plugin-patch-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

/** One installed plugin-page copy below `parent` (a module root or a nested node_modules). */
function writeCopy(parent: string, version = VERSION): string {
  const dir = join(parent, ...PACKAGE_DIR);
  writeJson(join(dir, 'package.json'), { name: PACKAGE_DIR.join('/'), version });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'client.js'), `export const marker = '${CONTENT_MARKER}';\n`);
  return dir;
}

function moduleRoot(dshVersion = VERSION): string {
  const root = join(ownedRoot(), 'node_modules');
  writeJson(join(root, '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: dshVersion,
  });
  return root;
}

/** Every entry below `root` with its kind and exact bytes or link target, in a stable order. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries[key] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[key] = `dir:${(stat.mode & 0o7777).toString(8)}`;
        walk(path, `${key}/`);
      } else {
        const bytes = readFileSync(path).toString('base64');
        entries[key] = `file:${(stat.mode & 0o7777).toString(8)}:${bytes}`;
      }
    }
  };
  walk(root, '');
  return entries;
}

function run(root: string | undefined) {
  return spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectRefusal(root: string, check: string): void {
  const before = snapshot(root);

  const result = run(root);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`patch-plugin-manager: refused: ${check}\n`);
  expect(snapshot(root)).toEqual(before);
}

it('refuses a different DSH package version without writing', () => {
  const root = moduleRoot('0.2.0-rc.3');
  writeCopy(root);

  expectRefusal(root, 'dsh-version');
});

it('refuses a module root without the DSH package', () => {
  const root = join(ownedRoot(), 'node_modules');
  writeCopy(root);

  expectRefusal(root, 'dsh-version');
});

it('refuses a module root without an installed plugin-page copy', () => {
  const root = moduleRoot();

  expectRefusal(root, 'copy-count');
});

it('refuses two installed copies, one top-level and one nested', () => {
  const root = moduleRoot();
  writeCopy(root);
  writeCopy(join(root, '@deepseek-ai', 'dsh', 'node_modules'));

  expectRefusal(root, 'copy-count');
});

it('refuses a different plugin-page package version', () => {
  const root = moduleRoot();
  writeCopy(root, '0.2.0-rc.3');

  expectRefusal(root, 'plugin-manager-version');
});

it('refuses an input hash other than the reviewed published file', () => {
  const root = moduleRoot();
  writeCopy(root);

  expectRefusal(root, 'input-sha256');
});

it('does not count a copy reachable only through a symbolic link', () => {
  const root = moduleRoot();
  const outside = writeCopy(join(ownedRoot(), 'outside'));
  symlinkSync(outside, join(root, ...PACKAGE_DIR), 'dir');

  expectRefusal(root, 'copy-count');
});

it('does not descend into a symbolically linked scope directory', () => {
  const root = moduleRoot();
  const nested = join(root, '@deepseek-ai', 'dsh', 'node_modules');
  mkdirSync(nested, { recursive: true });
  const scope = join(writeCopy(join(ownedRoot(), 'linked')), '..');
  symlinkSync(scope, join(nested, '@deepseek-ai'), 'dir');

  expectRefusal(root, 'copy-count');
});

it('refuses to run without a module root argument', () => {
  const result = run(undefined);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('patch-plugin-manager: refused: usage\n');
});

it('never prints file contents in a refusal', () => {
  const root = moduleRoot();
  writeCopy(root);

  const result = run(root);

  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain(CONTENT_MARKER);
  expect(`${result.stdout}${result.stderr}`).not.toContain(root);
});

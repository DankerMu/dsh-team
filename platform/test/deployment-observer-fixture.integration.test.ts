import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { removeRetiredObservationRoot } from './deployment-observer-fixture.ts';

const CHANGED = 'Deployment observer root changed before cleanup';
const UNRETIRED = 'Deployment observation has not retired';

let parent: string;

beforeEach(async () => {
  // Never the production `/tmp/dsh-team-observer-` prefix: this suite owns only its own parent.
  parent = await realpath(await mkdtemp(join(tmpdir(), 'observer-retention-')));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

async function ownedRoot(name = 'root') {
  const directory = join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'evidence.json'), '{}', { mode: 0o600 });
  const info = await lstat(directory);
  return {
    directory,
    ownedRoot: true,
    rootIdentity: { device: info.dev, inode: info.ino, owner: info.uid },
    retired: true,
  };
}

it('removes a retired owned 0700 root whose captured identity is unchanged', async () => {
  const observation = await ownedRoot();

  await removeRetiredObservationRoot(observation);

  await expect(lstat(observation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves a custody-owned root in place', async () => {
  const observation = { ...(await ownedRoot()), ownedRoot: false };

  await removeRetiredObservationRoot(observation);

  expect((await lstat(observation.directory)).isDirectory()).toBe(true);
});

it('refuses an owned root whose observation has not retired', async () => {
  const observation = { ...(await ownedRoot()), retired: false };

  await expect(removeRetiredObservationRoot(observation)).rejects.toThrow(UNRETIRED);

  expect((await lstat(join(observation.directory, 'evidence.json'))).isFile()).toBe(true);
});

it('refuses a root replaced by a different directory at the same path', async () => {
  const observation = await ownedRoot();
  // Create the replacement while the original exists so its inode is necessarily distinct.
  const replacement = join(parent, 'replacement');
  await mkdir(replacement, { mode: 0o700 });
  await rm(observation.directory, { recursive: true });
  await rename(replacement, observation.directory);
  expect((await lstat(observation.directory)).ino).not.toBe(observation.rootIdentity.inode);

  await expect(removeRetiredObservationRoot(observation)).rejects.toThrow(CHANGED);

  expect((await lstat(observation.directory)).isDirectory()).toBe(true);
});

it('refuses a root whose mode is no longer private', async () => {
  const observation = await ownedRoot();
  await chmod(observation.directory, 0o755);

  await expect(removeRetiredObservationRoot(observation)).rejects.toThrow(CHANGED);

  expect((await lstat(join(observation.directory, 'evidence.json'))).isFile()).toBe(true);
});

it('refuses a symbolic link at the root path without following it', async () => {
  const target = await ownedRoot('target');
  const link = join(parent, 'link');
  await symlink(target.directory, link);
  const info = await lstat(link);
  // The link's own identity: only type (and link mode) can distinguish it from a root.
  const observation = {
    ...target,
    directory: link,
    rootIdentity: { device: info.dev, inode: info.ino, owner: info.uid },
  };

  await expect(removeRetiredObservationRoot(observation)).rejects.toThrow(CHANGED);

  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect((await lstat(join(target.directory, 'evidence.json'))).isFile()).toBe(true);
});

it('refuses a non-directory at the root path', async () => {
  const file = join(parent, 'file');
  await writeFile(file, 'evidence', { mode: 0o700 });
  await chmod(file, 0o700);
  const info = await lstat(file);
  const observation = {
    directory: file,
    ownedRoot: true,
    rootIdentity: { device: info.dev, inode: info.ino, owner: info.uid },
    retired: true,
  };

  await expect(removeRetiredObservationRoot(observation)).rejects.toThrow(CHANGED);

  expect((await lstat(file)).isFile()).toBe(true);
});

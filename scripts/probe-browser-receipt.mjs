/** Atomic private lifecycle receipt storage, shared by host and private browser owners. */
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname } from 'node:path';

export async function writeReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    const file = await open(temporary, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    if (platform() === 'linux') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readReceipt(path) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 16384
  )
    throw new Error('browser receipt identity invalid');
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  if (
    receipt.version !== 1 ||
    typeof receipt.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(receipt.nonce)
  )
    throw new Error('browser receipt identity invalid');
  return receipt;
}

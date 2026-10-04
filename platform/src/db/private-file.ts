import { chmodSync, closeSync, constants, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_FILE_MODE = 0o600;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function preparePrivateDatabaseFile(filename: string): void {
  if (filename === ':memory:') {
    return;
  }

  mkdirSync(dirname(filename), { recursive: true });

  try {
    if (!statSync(filename).isFile()) {
      return;
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
    const fd = openSync(filename, constants.O_CREAT | constants.O_WRONLY, PRIVATE_FILE_MODE);
    closeSync(fd);
  }

  chmodSync(filename, PRIVATE_FILE_MODE);
}

export function tightenSqliteFiles(filename: string): void {
  if (filename === ':memory:') {
    return;
  }

  chmodSync(filename, PRIVATE_FILE_MODE);
  for (const sidecar of [`${filename}-wal`, `${filename}-shm`]) {
    try {
      if (statSync(sidecar).isFile()) {
        chmodSync(sidecar, PRIVATE_FILE_MODE);
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}

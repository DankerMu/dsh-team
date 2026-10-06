import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const USER_ID = /^[a-z0-9]{12}$/;
const DIRECTORY_MODE = 0o700;
const TEMP_MODE = 0o600;
const FILE_MODE = 0o444;

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error('managed-config filesystem operation failed', { cause: error });
}

export async function writeManagedConfig(
  directory: string,
  userId: string,
  content: string,
): Promise<string> {
  if (!USER_ID.test(userId)) {
    throw new Error('user id must be 12 lowercase ASCII letters or digits');
  }
  const root = resolve(directory);
  const destination = resolve(root, `${userId}.patch.yml`);
  const created = await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  if (created !== undefined) {
    await chmod(root, DIRECTORY_MODE);
  }
  const temporary = resolve(root, `.${userId}.${randomBytes(16).toString('hex')}`);
  let handle: FileHandle | undefined;
  let owned = false;
  let published = false;
  let primary: Error | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      TEMP_MODE,
    );
    owned = true;
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.chmod(FILE_MODE);
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    published = true;
  } catch (error) {
    primary = asError(error);
  }
  const cleanup: Error[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanup.push(asError(error));
    }
  }
  if (owned && !published) {
    try {
      await unlink(temporary);
    } catch (error) {
      cleanup.push(asError(error));
    }
  }
  if (primary !== undefined) {
    if (cleanup.length > 0) {
      throw new AggregateError([primary, ...cleanup]);
    }
    throw primary;
  }
  return destination;
}

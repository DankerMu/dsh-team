import { ok } from 'node:assert';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateManagedConfig, writeManagedConfig } from './index.ts';
import type { ManagedConfigInput, ManagedConfigResult } from './index.ts';

const USER_ID = 'abc123def456';
const SENTINEL_ID = 'zzzzzzzzzzzz';
const OTHER_ID = 'mnopqrstuvwx';
const OLD_DOCUMENT = 'previous-complete-overlay\n';
const SENTINEL_DOCUMENT = 'other-user-sentinel\n';
const COLLISION_BYTES = 'preexisting-temp-sentinel\n';

const INPUT: ManagedConfigInput = {
  modelSettings: {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DMXAPI_KEY',
    apiKeyConfigured: true,
    models: [{ name: 'alpha' }],
    defaultModel: 'alpha',
  },
  defaultPermissionTier: 'yolo',
  presets: [{ id: 'preset-office', config: { plugins: [] } }],
  localePatch: [{ id: 'zh-locale', name: '@dsh-team/zh-locale' }],
};

const OTHER_INPUT: ManagedConfigInput = {
  ...INPUT,
  modelSettings: {
    baseURL: 'http://10.0.0.8:9/v1',
    apiKeyEnv: 'DMXAPI_KEY',
    apiKeyConfigured: true,
    models: [{ name: 'omega', contextWindow: 128000 }],
    defaultModel: 'omega',
  },
};

function configuredDocument(input: ManagedConfigInput): string {
  const generated: ManagedConfigResult = generateManagedConfig(input);
  ok(generated.outcome === 'configured');
  return generated.content;
}

function expectAcquiredHandlesClosed(): void {
  expect(fsFault.openHandles).toEqual([]);
  expect(fsFault.closedHandles.length).toBeGreaterThan(0);
  for (const handle of fsFault.closedHandles) {
    expect(handle.fd).toBe(-1);
  }
}

async function waitForCheckpoint(
  checkpoint: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  const winner = await Promise.race([
    checkpoint.then(() => 'ready' as const),
    operation.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ]);
  if (winner === 'settled') {
    throw new Error('writer settled before the held filesystem checkpoint');
  }
}

type PrepublicationFault = 'write' | 'chmod' | 'close' | 'rename';

type NodeFsPromises = typeof FsPromises;

const fsFault = vi.hoisted(() => {
  function ioError(syscall: string): NodeJS.ErrnoException {
    const error = new Error(`${syscall} failed`) as NodeJS.ErrnoException;
    error.code = 'EIO';
    error.syscall = syscall;
    return error;
  }
  return {
    calls: [] as string[],
    failOn: undefined as PrepublicationFault | undefined,
    error: undefined as NodeJS.ErrnoException | undefined,
    cleanupError: undefined as NodeJS.ErrnoException | undefined,
    failUnlink: false,
    failCleanupClose: false,
    primaryCloseSpent: false,
    closedHandles: [] as FileHandle[],
    openHandles: [] as FileHandle[],
    exclusiveNames: [] as string[],
    collideExclusive: false,
    collisionPath: undefined as string | undefined,
    collisionError: undefined as Error | undefined,
    holdOpen: undefined as ((path: string, handle: FileHandle) => Promise<void>) | undefined,
    partialBytes: undefined as Buffer | undefined,
    partialLength: 8,
    ioError,
  };
});

function resetFsFault(): void {
  fsFault.calls = [];
  fsFault.failOn = undefined;
  fsFault.error = undefined;
  fsFault.cleanupError = undefined;
  fsFault.failUnlink = false;
  fsFault.failCleanupClose = false;
  fsFault.primaryCloseSpent = false;
  fsFault.closedHandles = [];
  fsFault.openHandles = [];
  fsFault.exclusiveNames = [];
  fsFault.collideExclusive = false;
  fsFault.collisionPath = undefined;
  fsFault.collisionError = undefined;
  fsFault.holdOpen = undefined;
  fsFault.partialBytes = undefined;
}

async function closeTrackedHandles(): Promise<void> {
  const leftover = fsFault.openHandles.splice(0);
  const failures: Error[] = [];
  for (const handle of leftover) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error('failed to close harness-owned file handle', { cause: error }),
      );
    }
  }
  const firstFailure = failures[0];
  if (failures.length === 1 && firstFailure !== undefined) {
    throw firstFailure;
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'failed to close harness-owned file handles');
  }
}

function markHandleClosed(handle: FileHandle): void {
  fsFault.openHandles = fsFault.openHandles.filter((openHandle) => openHandle !== handle);
  fsFault.closedHandles.push(handle);
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<NodeFsPromises>();
  return {
    ...actual,
    async mkdir(path: string, options?: { recursive?: boolean; mode?: number }) {
      fsFault.calls.push('mkdir');
      return actual.mkdir(path, options);
    },
    async chmod(path: string, mode: number) {
      fsFault.calls.push('chmod');
      return actual.chmod(path, mode);
    },
    async open(...args: Parameters<NodeFsPromises['open']>): Promise<FileHandle> {
      const path = String(args[0]);
      fsFault.calls.push('open');
      if (fsFault.collideExclusive) {
        writeFileSync(path, COLLISION_BYTES, { mode: 0o600 });
        chmodSync(path, 0o600);
        fsFault.collisionPath = path;
        try {
          return await actual.open(...args);
        } catch (error) {
          if (error instanceof Error) {
            fsFault.collisionError = error;
          }
          throw error;
        }
      }
      fsFault.exclusiveNames.push(path);
      const handle = await actual.open(...args);
      fsFault.openHandles.push(handle);
      return {
        ...handle,
        async writeFile(...writeArgs: Parameters<FileHandle['writeFile']>) {
          fsFault.calls.push('write');
          const data = writeArgs[0];
          if (
            fsFault.failOn === 'write' &&
            (typeof data === 'string' || data instanceof Uint8Array)
          ) {
            const encoded = Buffer.from(data);
            const partial = encoded.subarray(0, Math.min(fsFault.partialLength, encoded.length));
            await handle.write(partial);
            fsFault.partialBytes = readFileSync(path);
            fsFault.error = fsFault.ioError('write');
            throw fsFault.error;
          }
          await handle.writeFile(...writeArgs);
          if (fsFault.holdOpen !== undefined) {
            await fsFault.holdOpen(path, handle);
          }
        },
        async chmod(...chmodArgs: Parameters<FileHandle['chmod']>) {
          fsFault.calls.push('fchmod');
          if (fsFault.failOn === 'chmod') {
            fsFault.error = fsFault.ioError('fchmod');
            throw fsFault.error;
          }
          return handle.chmod(...chmodArgs);
        },
        async close() {
          fsFault.calls.push('close');
          if (fsFault.failOn === 'close' && !fsFault.primaryCloseSpent) {
            fsFault.primaryCloseSpent = true;
            fsFault.error = fsFault.ioError('close');
            throw fsFault.error;
          }
          await handle.close();
          markHandleClosed(handle);
          if (fsFault.failCleanupClose) {
            fsFault.cleanupError = fsFault.ioError('cleanup-close');
            throw fsFault.cleanupError;
          }
        },
      };
    },
    async rename(from: string, to: string) {
      fsFault.calls.push('rename');
      if (fsFault.failOn === 'rename') {
        fsFault.error = fsFault.ioError('rename');
        throw fsFault.error;
      }
      return actual.rename(from, to);
    },
    async unlink(path: string) {
      fsFault.calls.push('unlink');
      if (fsFault.failUnlink) {
        fsFault.cleanupError = fsFault.ioError('unlink');
        throw fsFault.cleanupError;
      }
      return actual.unlink(path);
    },
    async stat(path: string) {
      fsFault.calls.push('stat');
      return actual.stat(path);
    },
    async lstat(path: string) {
      fsFault.calls.push('lstat');
      return actual.lstat(path);
    },
    async readFile(path: string) {
      fsFault.calls.push('readFile');
      return actual.readFile(path);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      fsFault.calls.push('writeFile');
      return actual.writeFile(path, data);
    },
    async access(path: string) {
      fsFault.calls.push('access');
      return actual.access(path);
    },
    async truncate(path: string, len?: number) {
      fsFault.calls.push('truncate');
      return actual.truncate(path, len);
    },
  };
});

describe('writeManagedConfig', () => {
  let dir = '';

  function existingDocuments() {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    mkdirSync(managedRoot, { mode: 0o700 });
    chmodSync(managedRoot, 0o700);
    const destination = join(managedRoot, `${USER_ID}.patch.yml`);
    const sentinel = join(managedRoot, `${SENTINEL_ID}.patch.yml`);
    writeFileSync(destination, OLD_DOCUMENT);
    chmodSync(destination, 0o444);
    writeFileSync(sentinel, SENTINEL_DOCUMENT);
    chmodSync(sentinel, 0o644);
    return {
      managedRoot,
      destination,
      sentinel,
      oldMode: statSync(destination).mode,
      sentinelMode: statSync(sentinel).mode,
    };
  }

  beforeEach(() => {
    resetFsFault();
  });

  afterEach(async () => {
    await closeTrackedHandles();
    resetFsFault();
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('publishes a complete UTF-8 overlay as a read-only user patch and creates a missing 0700 managed root without changing an existing ancestor', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    chmodSync(dir, 0o750);
    const ancestorMode = statSync(dir).mode;
    const managedRoot = join(dir, 'managed-config');
    const document = configuredDocument(INPUT);

    const published = await writeManagedConfig(managedRoot, USER_ID, document);

    expect(published).toBe(resolve(managedRoot, `${USER_ID}.patch.yml`));
    expect(readFileSync(published)).toEqual(Buffer.from(document, 'utf8'));
    expect(statSync(published).mode & 0o777).toBe(0o444);
    expect(statSync(managedRoot).isDirectory()).toBe(true);
    expect(statSync(managedRoot).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode).toBe(ancestorMode);
  });

  it.each(['write', 'chmod', 'close', 'rename'] as const)(
    'rejects a %s fault, keeps the previous overlay and sentinel, and retains the error',
    async (failOn) => {
      const { managedRoot, destination, sentinel, oldMode, sentinelMode } = existingDocuments();
      const document = configuredDocument(INPUT);
      fsFault.failOn = failOn;

      const rejection = await writeManagedConfig(managedRoot, USER_ID, document).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBe(fsFault.error);
      expect(fsFault.error).toBeDefined();
      expect(fsFault.error?.syscall).toBe(failOn === 'chmod' ? 'fchmod' : failOn);
      expect(readFileSync(destination, 'utf8')).toBe(OLD_DOCUMENT);
      expect(statSync(destination).mode).toBe(oldMode);
      expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_DOCUMENT);
      expect(statSync(sentinel).mode).toBe(sentinelMode);
      expect(readdirSync(managedRoot).sort()).toEqual(
        [`${SENTINEL_ID}.patch.yml`, `${USER_ID}.patch.yml`].sort(),
      );
      if (failOn === 'write') {
        expect(fsFault.partialBytes).toEqual(
          Buffer.from(document, 'utf8').subarray(0, fsFault.partialLength),
        );
        expect(fsFault.partialBytes?.length).toBe(fsFault.partialLength);
        expect(fsFault.partialBytes).not.toEqual(Buffer.from(document, 'utf8'));
      }
      if (failOn === 'rename') {
        expect(fsFault.openHandles).toEqual([]);
        expect(fsFault.closedHandles).toHaveLength(1);
        const closed = fsFault.closedHandles[0];
        expect(closed?.fd).toBe(-1);
      } else {
        expectAcquiredHandlesClosed();
      }
    },
  );

  it('aggregates a rename fault with a subsequent unlink cleanup failure', async () => {
    const { managedRoot, destination, sentinel, oldMode, sentinelMode } = existingDocuments();
    const document = configuredDocument(INPUT);
    fsFault.failOn = 'rename';
    fsFault.failUnlink = true;

    const rejection = await writeManagedConfig(managedRoot, USER_ID, document).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AggregateError);
    const aggregated = rejection as AggregateError;
    expect(aggregated.errors).toEqual([fsFault.error, fsFault.cleanupError]);
    expect(fsFault.error?.syscall).toBe('rename');
    expect(fsFault.cleanupError?.syscall).toBe('unlink');
    expect(fsFault.openHandles).toEqual([]);
    expect(fsFault.closedHandles).toHaveLength(1);
    expect(fsFault.closedHandles[0]?.fd).toBe(-1);
    expect(readFileSync(destination, 'utf8')).toBe(OLD_DOCUMENT);
    expect(statSync(destination).mode).toBe(oldMode);
    expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_DOCUMENT);
    expect(statSync(sentinel).mode).toBe(sentinelMode);
  });

  it('aggregates a write fault with a subsequent close cleanup failure', async () => {
    const { managedRoot, destination, sentinel, oldMode, sentinelMode } = existingDocuments();
    const document = configuredDocument(INPUT);
    fsFault.failOn = 'write';
    fsFault.failCleanupClose = true;

    const rejection = await writeManagedConfig(managedRoot, USER_ID, document).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AggregateError);
    const aggregated = rejection as AggregateError;
    expect(aggregated.errors).toEqual([fsFault.error, fsFault.cleanupError]);
    expect(fsFault.error?.syscall).toBe('write');
    expect(fsFault.cleanupError?.syscall).toBe('cleanup-close');
    expect(fsFault.closedHandles).toHaveLength(1);
    expect(fsFault.closedHandles[0]?.fd).toBe(-1);
    expect(fsFault.openHandles).toEqual([]);
    expect(fsFault.calls.filter((call) => call === 'close')).toEqual(['close']);
    expect(fsFault.partialBytes).toEqual(
      Buffer.from(document, 'utf8').subarray(0, fsFault.partialLength),
    );
    expect(readFileSync(destination, 'utf8')).toBe(OLD_DOCUMENT);
    expect(statSync(destination).mode).toBe(oldMode);
    expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_DOCUMENT);
    expect(statSync(sentinel).mode).toBe(sentinelMode);
  });

  it.each([
    '../aaaaaaaaaa',
    'ABCDEFGHIJKL',
    'abc123def45',
    'abc123def4567',
    'abc123def45.',
    'abc123/ef456',
    'abc123%2f456',
    'abc123 def56',
    'abc123de\0f45',
    '',
    'abc123def456\n',
  ])('rejects %j before any filesystem operation', async (userId) => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const sibling = join(dir, 'keep.txt');
    writeFileSync(sibling, 'keep');
    const managedRoot = join(dir, 'managed-config');
    const document = configuredDocument(INPUT);

    await expect(writeManagedConfig(managedRoot, userId, document)).rejects.toThrow(
      'user id must be 12 lowercase ASCII letters or digits',
    );
    expect(fsFault.calls).toEqual([]);
    expect(existsSync(managedRoot)).toBe(false);
    expect(readFileSync(sibling, 'utf8')).toBe('keep');
  });

  it('does not delete a preexisting exclusive-create collision and leaves the old destination unchanged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    mkdirSync(managedRoot, { mode: 0o700 });
    chmodSync(managedRoot, 0o700);
    const destination = join(managedRoot, `${USER_ID}.patch.yml`);
    writeFileSync(destination, OLD_DOCUMENT);
    chmodSync(destination, 0o444);
    fsFault.collideExclusive = true;
    const document = configuredDocument(INPUT);

    const rejection = await writeManagedConfig(managedRoot, USER_ID, document).then(
      () => undefined,
      (error: unknown) => error,
    );
    const collided = fsFault.collisionPath;
    expect(collided).toEqual(expect.stringMatching(new RegExp(`\\.${USER_ID}\\.[0-9a-f]+$`)));
    expect(rejection).toBe(fsFault.collisionError);
    expect(
      fsFault.collisionError !== undefined &&
        'code' in fsFault.collisionError &&
        fsFault.collisionError.code === 'EEXIST',
    ).toBe(true);
    expect(collided).toBeDefined();
    if (collided === undefined) {
      throw new Error('exclusive-create collision path was not recorded');
    }
    expect(readFileSync(collided, 'utf8')).toBe(COLLISION_BYTES);
    expect(statSync(collided).mode & 0o777).toBe(0o600);
    expect(readFileSync(destination, 'utf8')).toBe(OLD_DOCUMENT);
    expect(statSync(destination).mode & 0o777).toBe(0o444);
    expect(fsFault.calls.filter((call) => call === 'unlink')).toEqual([]);
  });

  it('holds an unpublished 0600 temp while a sibling failure preserves it, then publishes after release', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    mkdirSync(managedRoot, { mode: 0o700 });
    chmodSync(managedRoot, 0o700);
    const destination = join(managedRoot, `${USER_ID}.patch.yml`);
    const sibling = join(managedRoot, `${SENTINEL_ID}.patch.yml`);
    writeFileSync(sibling, SENTINEL_DOCUMENT);
    chmodSync(sibling, 0o644);
    const document = configuredDocument(INPUT);
    const other = configuredDocument(OTHER_INPUT);
    let heldPath = '';
    let resumeHeld: (() => void) | undefined;
    const heldReady = new Promise<void>((resolveHeld) => {
      fsFault.holdOpen = async (path) => {
        if (readFileSync(path, 'utf8') !== document) {
          return;
        }
        heldPath = path;
        resolveHeld();
        await new Promise<void>((release) => {
          resumeHeld = release;
        });
      };
    });

    const held = writeManagedConfig(managedRoot, USER_ID, document);
    try {
      await waitForCheckpoint(heldReady, held);
      expect(statSync(heldPath).mode & 0o777).toBe(0o600);
      fsFault.failOn = 'rename';
      fsFault.holdOpen = undefined;
      const siblingRejection = await writeManagedConfig(managedRoot, SENTINEL_ID, other).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(siblingRejection).toBe(fsFault.error);
      expect(readFileSync(heldPath)).toEqual(Buffer.from(document, 'utf8'));
      expect(statSync(heldPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(sibling, 'utf8')).toBe(SENTINEL_DOCUMENT);
      expect(existsSync(destination)).toBe(false);
      fsFault.failOn = undefined;
      resumeHeld?.();
      expect(await held).toBe(resolve(destination));
      expect(readFileSync(destination)).toEqual(Buffer.from(document, 'utf8'));
      expect(statSync(destination).mode & 0o777).toBe(0o444);
      expect(existsSync(heldPath)).toBe(false);
    } finally {
      resumeHeld?.();
      await held.then(
        () => undefined,
        () => undefined,
      );
    }
  });

  it('keeps an initially absent destination absent after a rename fault', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    mkdirSync(managedRoot, { mode: 0o700 });
    chmodSync(managedRoot, 0o700);
    const destination = join(managedRoot, `${USER_ID}.patch.yml`);
    const document = configuredDocument(INPUT);
    fsFault.failOn = 'rename';

    const rejection = await writeManagedConfig(managedRoot, USER_ID, document).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBe(fsFault.error);
    expect(fsFault.openHandles).toEqual([]);
    expect(fsFault.closedHandles).toHaveLength(1);
    expect(fsFault.closedHandles[0]?.fd).toBe(-1);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(managedRoot)).toEqual([]);
  });

  it('replaces a destination symlink without writing through to the external target', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    mkdirSync(managedRoot, { mode: 0o700 });
    chmodSync(managedRoot, 0o700);
    const outside = join(dir, 'external.yml');
    writeFileSync(outside, SENTINEL_DOCUMENT);
    chmodSync(outside, 0o644);
    const destination = join(managedRoot, `${USER_ID}.patch.yml`);
    symlinkSync(outside, destination);
    const document = configuredDocument(INPUT);

    const published = await writeManagedConfig(managedRoot, USER_ID, document);

    expect(published).toBe(resolve(destination));
    expect(statSync(published).isFile()).toBe(true);
    expect(lstatSync(published).isSymbolicLink()).toBe(false);
    expect(readFileSync(published)).toEqual(Buffer.from(document, 'utf8'));
    expect(statSync(published).mode & 0o777).toBe(0o444);
    expect(readFileSync(outside, 'utf8')).toBe(SENTINEL_DOCUMENT);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it('publishes independent users to distinct files without mixing content', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    const first = configuredDocument(INPUT);
    const second = configuredDocument(OTHER_INPUT);

    const [publishedFirst, publishedSecond] = await Promise.all([
      writeManagedConfig(managedRoot, USER_ID, first),
      writeManagedConfig(managedRoot, OTHER_ID, second),
    ]);

    expect(first).not.toBe(second);
    expect(publishedFirst).toBe(resolve(managedRoot, `${USER_ID}.patch.yml`));
    expect(publishedSecond).toBe(resolve(managedRoot, `${OTHER_ID}.patch.yml`));
    expect(readFileSync(publishedFirst)).toEqual(Buffer.from(first, 'utf8'));
    expect(readFileSync(publishedSecond)).toEqual(Buffer.from(second, 'utf8'));
    expect(readFileSync(publishedFirst, 'utf8')).not.toContain('omega');
    expect(readFileSync(publishedSecond, 'utf8')).not.toContain('alpha');
    expect(statSync(publishedFirst).mode & 0o777).toBe(0o444);
    expect(statSync(publishedSecond).mode & 0o777).toBe(0o444);
    expect(new Set(fsFault.exclusiveNames).size).toBe(2);
  });

  it('lets the last successful overlapping write for one user replace a complete previous document', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-team-managed-config-'));
    const managedRoot = join(dir, 'managed-config');
    const first = configuredDocument(INPUT);
    const second = configuredDocument(OTHER_INPUT);
    let releaseSecond: (() => void) | undefined;
    const secondHeld = new Promise<void>((resolveHeld) => {
      fsFault.holdOpen = async (path) => {
        if (readFileSync(path, 'utf8') !== second) {
          return;
        }
        resolveHeld();
        await new Promise<void>((release) => {
          releaseSecond = release;
        });
      };
    });

    const firstWrite = writeManagedConfig(managedRoot, USER_ID, first);
    const secondWrite = writeManagedConfig(managedRoot, USER_ID, second);
    const settled = Promise.allSettled([firstWrite, secondWrite]);
    try {
      await waitForCheckpoint(secondHeld, secondWrite);
      expect(await firstWrite).toBe(resolve(managedRoot, `${USER_ID}.patch.yml`));
      expect(readFileSync(resolve(managedRoot, `${USER_ID}.patch.yml`))).toEqual(
        Buffer.from(first, 'utf8'),
      );
      expect(readFileSync(resolve(managedRoot, `${USER_ID}.patch.yml`), 'utf8')).not.toContain(
        'omega',
      );
      releaseSecond?.();
      expect(await secondWrite).toBe(resolve(managedRoot, `${USER_ID}.patch.yml`));
      expect(readFileSync(resolve(managedRoot, `${USER_ID}.patch.yml`))).toEqual(
        Buffer.from(second, 'utf8'),
      );
      expect(readFileSync(resolve(managedRoot, `${USER_ID}.patch.yml`), 'utf8')).not.toContain(
        'alpha',
      );
      expect(statSync(resolve(managedRoot, `${USER_ID}.patch.yml`)).mode & 0o777).toBe(0o444);
    } finally {
      releaseSecond?.();
      await settled;
    }
  });
});

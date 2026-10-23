import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import { unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { execBrowser } from './browser-runtime-fixture.ts';
import { rescueChrome, writeReceipt } from '../../scripts/probe-browser-runtime.mjs';
import { processBirth } from '../../scripts/probe-browser-native.mjs';
import type { BrowserExecTarget } from '../../scripts/probe-browser-exec.mjs';
import {
  SUBMISSION_JOURNAL,
  SUBMISSION_PENDING,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import { record } from './container-start-docker-fixture.ts';
import { ordinarySubmission, withAuditReceipt } from './trusted-docker-audit-fixture.ts';
import type { AuditContext } from './trusted-docker-audit-fixture.ts';

const execution = vi.hoisted<{
  child: ChildProcess.ChildProcess | undefined;
  closed: boolean;
  docker:
    ((args: readonly string[]) => { status: number; stdout: string; stderr: string }) | undefined;
  publicationFailure: { journal: string; state: string; error: Error } | undefined;
  succeeds: boolean;
  missingExecutable: string | undefined;
}>(() => ({
  child: undefined,
  closed: false,
  docker: undefined,
  publicationFailure: undefined,
  succeeds: false,
  missingExecutable: undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      const failure = execution.publicationFailure;
      if (failure !== undefined) {
        const expected = actual.statSync(failure.journal);
        const found = actual.fstatSync(descriptor);
        if (found.dev === expected.dev && found.ino === expected.ino) {
          const last = actual.readFileSync(failure.journal, 'utf8').trimEnd().split('\n').at(-1);
          if (last && record(JSON.parse(last)).state === failure.state) throw failure.error;
        }
      }
      actual.fsyncSync(descriptor);
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawnSync(binary: string, args: readonly string[], options?: ChildProcess.SpawnSyncOptions) {
      if (binary !== 'docker') return actual.spawnSync(binary, args, options);
      if (!execution.docker) throw new Error('Unexpected Docker process in browser exec control');
      return execution.docker(args);
    },
    spawn(binary: string, args: readonly string[]) {
      if (binary !== 'docker' || args[0] !== 'exec')
        throw new Error('Unexpected external process in browser exec control');
      const child = actual.spawn(
        execution.missingExecutable ?? process.execPath,
        [
          '-e',
          execution.succeeds
            ? 'process.stdout.write("ready\\n")'
            : 'process.stdin.resume();process.stdout.write("ready\\n")',
        ],
        { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] },
      );
      execution.child = child;
      child.once('close', () => {
        execution.closed = true;
      });
      return child;
    },
  };
});

async function prepareExecReceipt(
  pointer: string,
  receipt: Record<string, unknown>,
): Promise<BrowserExecTarget> {
  const receiptFile = receipt.receiptFile;
  const sockets = receipt.socketDirectory;
  if (typeof receiptFile !== 'string' || typeof sockets !== 'string')
    throw new Error('Canonical browser receipt paths missing');
  await mkdir(sockets, { mode: 0o700 });
  const identity = await stat(sockets);
  Object.assign(receipt, {
    containerId: 'c'.repeat(64),
    networkId: 'd'.repeat(64),
    state: 'running',
    privateUid: process.getuid?.(),
    privateNodeVersion: 'v24.13.1',
    socketIdentity: { device: String(identity.dev), inode: String(identity.ino) },
  });
  await writeReceipt(receiptFile, receipt);
  await writeReceipt(pointer, receipt);
  return { receiptFile, containerId: String(receipt.containerId) };
}

async function closeIssuedClient(): Promise<void> {
  const child = execution.child;
  if (child && !execution.closed) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  execution.child = undefined;
}

async function withBoundExec(
  run: (context: AuditContext & { target: BrowserExecTarget }) => Promise<void>,
): Promise<void> {
  await withAuditReceipt(async (context) => {
    const target = await prepareExecReceipt(context.pointer, context.receipt);
    const previousJournal = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    const previousPointers = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
    execution.closed = false;
    execution.child = undefined;
    try {
      process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(
        dirname(context.journal),
        SUBMISSION_JOURNAL,
      );
      process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = dirname(context.pointer);
      await run({ ...context, target });
    } finally {
      if (previousJournal === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousJournal;
      if (previousPointers === undefined) delete process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
      else process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = previousPointers;
      await closeIssuedClient();
      execution.publicationFailure = undefined;
      execution.succeeds = false;
      execution.missingExecutable = undefined;
    }
  });
}

it('joins the actual exec client close before reporting a protocol callback failure', async () => {
  await withAuditReceipt(async ({ pointer, receipt, journal }) => {
    const target = await prepareExecReceipt(pointer, receipt);
    const previousJournal = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    const previousPointers = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
    const failure = new Error('Owned protocol callback rejected');
    execution.closed = false;
    execution.child = undefined;
    let progress = '';
    try {
      process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(dirname(journal), SUBMISSION_JOURNAL);
      process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = dirname(pointer);
      const result = execBrowser(target, 'unused controlled protocol', (line) => {
        progress = line;
        throw failure;
      });
      await expect(result).rejects.toBe(failure);
      expect(progress).toBe('ready');
      expect(execution.closed).toBe(true);
    } finally {
      if (previousJournal === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousJournal;
      if (previousPointers === undefined) delete process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
      else process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = previousPointers;
      await closeIssuedClient();
    }
  });
});

it.each([
  {
    name: 'keeps a fully published failed browser exec unknown while independently retiring its execution capability',
    live: 'none',
  },
  {
    name: 'refuses browser exec capability retirement while its captured driver remains live',
    live: 'driver',
  },
  {
    name: 'refuses browser exec capability retirement while its captured acquisition producer remains live',
    live: 'producer',
  },
])('$name', async ({ live }) => {
  await withAuditReceipt(async ({ pointer, receipt, journal, command, assess }) => {
    const directory = dirname(journal);
    const submissions = join(directory, SUBMISSION_JOURNAL);
    const previousJournal = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    const previousPointers = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
    const id = 'c'.repeat(64);
    const networkId = 'd'.repeat(64);
    if (live !== 'none') {
      const identity = { pid: process.pid, birth: await processBirth(process.pid) };
      if (live === 'driver') receipt.driver = identity;
      else record(receipt.acquisition).producer = identity;
    }
    const target = await prepareExecReceipt(pointer, receipt);
    const receiptFile = target.receiptFile;
    const networkConfig = record(receipt.networkConfig);
    const container = {
      Id: id,
      Name: `/${String(receipt.containerName)}`,
      Image: receipt.imageId,
      Config: {
        Image: receipt.imageId,
        Labels: {
          'dsh-team.test-run': receipt.runId,
          'dsh-team.browser-nonce': receipt.nonce,
          'dsh-team.role': 'verification-browser',
        },
      },
      State: { Running: true, Status: 'running' },
      HostConfig: { NetworkMode: networkId },
      NetworkSettings: {
        Networks: {
          [String(receipt.networkName)]: {
            NetworkID: networkId,
            Gateway: '',
            IPv6Gateway: '',
            GlobalIPv6Address: '',
          },
        },
      },
    };
    let containerPresent = true;
    let networkPresent = true;
    const mutations: string[][] = [];
    execution.closed = false;
    execution.child = undefined;
    execution.docker = (args) => {
      const [kind, operation, target] = args;
      if (operation === 'inspect') {
        const expected =
          kind === 'container'
            ? [id, receipt.containerName]
            : kind === 'network'
              ? [networkId, receipt.networkName]
              : [];
        if (!expected.includes(target))
          throw new Error('Inspection escaped captured browser authority');
        const present = kind === 'container' ? containerPresent : networkPresent;
        if (!present)
          return {
            status: 1,
            stdout: '',
            stderr: `Error response from daemon: No such ${String(kind)}: ${String(target)}`,
          };
        const object =
          kind === 'container'
            ? container
            : {
                Id: networkId,
                Name: receipt.networkName,
                Scope: 'local',
                Driver: networkConfig.driver,
                Internal: networkConfig.internal,
                EnableIPv6: networkConfig.enableIPv6,
                Options: networkConfig.options,
                Labels: {
                  'dsh-team.test-run': receipt.runId,
                  'dsh-team.browser-nonce': receipt.nonce,
                  'dsh-team.role': 'verification-browser-network',
                },
                Containers: containerPresent ? { [id]: { Name: receipt.containerName } } : {},
              };
        return { status: 0, stdout: JSON.stringify([object]), stderr: '' };
      }
      mutations.push([...args]);
      if (kind === 'stop') {
        expect(args).toEqual(['stop', '--time', '8', id]);
        container.State = { Running: false, Status: 'exited' };
      } else if (kind === 'rm') {
        expect(args).toEqual(['rm', id]);
        expect(container.State.Running).toBe(false);
        containerPresent = false;
      } else {
        expect(args).toEqual(['network', 'rm', networkId]);
        expect(containerPresent).toBe(false);
        networkPresent = false;
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = submissions;
      process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = dirname(pointer);
      const failure = new Error('Owned browser exec operation remains unknown');
      let progress = '';
      await expect(
        execBrowser(target, 'unused controlled protocol', (line) => {
          progress = line;
          // Match the canonical active-rescue control's temporary identity-adoption state.
          writeFileSync(
            receiptFile,
            JSON.stringify({
              ...receipt,
              containerId: null,
              networkId: null,
              state: 'pending-identity',
            }),
          );
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(progress).toBe('ready');
      expect(execution.closed).toBe(true);
      expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([]);

      // Fully published client failure is still not daemon-operation settlement.
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).toThrow();
      const published = (await readFile(submissions, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => record(JSON.parse(line)));
      expect(published).toHaveLength(2);
      const submitted = published[0];
      const outcome = published[1];
      if (!submitted || !outcome) throw new Error('Tracked browser exec outcome missing');
      expect(submitted.state).toBe('submitted');
      expect(outcome.id).toBe(submitted.id);
      expect(outcome.state).not.toBe('submitted');
      expect(outcome.state).not.toBe('settled');
      expect(await assess()).toMatchObject({ state: 'unconfirmed', browserExec: null });

      // Exercise canonical ownership checks and removal, not a fabricated stopped pointer.
      await rescueChrome(receiptFile);
      expect(mutations).toEqual([
        ['stop', '--time', '8', id],
        ['rm', id],
        ['network', 'rm', networkId],
      ]);
      expect(containerPresent).toBe(false);
      expect(networkPresent).toBe(false);
      const stopped = record(JSON.parse(await readFile(pointer, 'utf8')));
      expect(stopped.state).toBe('stopped');
      expect(stopped.containerId).toBe(id);
      expect(stopped.acquisition).toEqual(receipt.acquisition);
      const beforeAssessment = await readFile(submissions);
      const pendingBefore = await readdir(join(directory, SUBMISSION_PENDING));
      expect(pendingBefore).toEqual([]);
      const inspected: string[][] = [];
      const assessment = await assess(true, (args, timeout) => {
        inspected.push([...args]);
        return command(args, timeout);
      });
      if (live === 'none') {
        expect(inspected).toContainEqual(['container', 'inspect', id]);
        expect(assessment).toEqual({
          state: 'confirmed',
          browserExec: {
            operationOutcome: 'unknown',
            executionCapability: 'retired',
            submissions: 1,
            sha256: createHash('sha256')
              .update(JSON.stringify([submitted.id]))
              .digest('hex'),
          },
        });
        for (const diagnostic of ['failed', 'ambiguous', 'foreign-absence']) {
          expect(
            await assess(true, (args, timeout) => {
              if (args.join(' ') === `container inspect ${id}`)
                return {
                  status: 1,
                  stdout: '',
                  stderr:
                    diagnostic === 'foreign-absence'
                      ? `Error response from daemon: No such container: ${'e'.repeat(64)}`
                      : diagnostic,
                };
              return command(args, timeout);
            }),
          ).toEqual({ state: 'unconfirmed', browserExec: null });
        }
        await writeReceipt(pointer, { ...stopped, runId: 'changed-after-exec' });
        expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
        await writeReceipt(pointer, stopped);
      } else {
        expect(assessment).toEqual({ state: 'unconfirmed', browserExec: null });
        expect(inspected).not.toContainEqual(['container', 'inspect', id]);
      }
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).toThrow();
      expect(await readFile(submissions)).toEqual(beforeAssessment);
      expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual(pendingBefore);
      if (live === 'none') {
        execution.closed = false;
        const retiredFailure = new Error('Owned exec against retired immutable target');
        await expect(
          execBrowser(target, 'unused retired-target protocol', () => {
            // Canonical rescue already retired the target; the retained pointer outlives this file.
            unlinkSync(target.receiptFile);
            throw retiredFailure;
          }),
        ).rejects.toBe(retiredFailure);
        expect(execution.closed).toBe(true);
        const attempts = (await readFile(submissions, 'utf8'))
          .trimEnd()
          .split('\n')
          .map((line) => record(JSON.parse(line)))
          .filter((row) => row.state === 'submitted' && Object.hasOwn(row, 'browserExec'))
          .map((row) => String(row.id))
          .sort();
        expect(attempts).toHaveLength(2);
        expect(await assess()).toEqual({
          state: 'confirmed',
          browserExec: {
            operationOutcome: 'unknown',
            executionCapability: 'retired',
            submissions: 2,
            sha256: createHash('sha256').update(JSON.stringify(attempts)).digest('hex'),
          },
        });
        const ordinary = ordinarySubmission(journal, true);
        expect(ordinary.status, ordinary.stderr).toBe(0);
        expect(ordinary.stdout).toBe('submission-accepted\n');
        expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
      }
    } finally {
      if (previousJournal === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousJournal;
      if (previousPointers === undefined) delete process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
      else process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY = previousPointers;
      await closeIssuedClient();
      execution.docker = undefined;
    }
  });
});

it('retains a visible unknown outcome and its fence when outcome fsync fails', async () => {
  await withBoundExec(async ({ target, journal, assess }) => {
    const directory = dirname(journal);
    execution.publicationFailure = {
      journal: join(directory, SUBMISSION_JOURNAL),
      state: 'client-closed-unknown',
      error: new Error('Owned exec outcome publication fsync failure'),
    };
    const failure = new Error('Owned original exec protocol failure');
    await expect(
      execBrowser(target, 'unused controlled protocol', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(execution.closed).toBe(true);
    const rows = (await readFile(execution.publicationFailure.journal, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    expect(rows.at(-1)).toMatchObject({
      state: 'client-closed-unknown',
      client: { failure: 'callback' },
    });
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toHaveLength(1);
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).toThrow();
    let inspected = false;
    expect(
      await assess(true, () => {
        inspected = true;
        throw new Error('Publication uncertainty must stop assessment before resource inspection');
      }),
    ).toEqual({ state: 'unconfirmed', browserExec: null });
    expect(inspected).toBe(false);
  });
});

it('rejects successful exec when its settled publication fails after the visible row', async () => {
  await withBoundExec(async ({ target, journal, assess }) => {
    const directory = dirname(journal);
    const failure = new Error('Owned successful exec publication failure');
    execution.succeeds = true;
    execution.publicationFailure = {
      journal: join(directory, SUBMISSION_JOURNAL),
      state: 'settled',
      error: failure,
    };
    await expect(execBrowser(target, 'unused controlled protocol')).rejects.toBe(failure);
    expect(execution.closed).toBe(true);
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toHaveLength(1);
    const rows = (await readFile(execution.publicationFailure.journal, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    expect(rows.at(-1)?.state).toBe('settled');
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).toThrow();
    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it('publishes actual exec closure but refuses retirement after retained authority changes', async () => {
  await withBoundExec(async ({ target, receipt, pointer, journal, assess }) => {
    const failure = new Error('Owned original exec rejection');
    await expect(
      execBrowser(target, 'unused controlled protocol', () => {
        writeFileSync(
          target.receiptFile,
          JSON.stringify({ ...receipt, runId: 'changed-during-exec' }),
        );
        writeFileSync(
          pointer,
          JSON.stringify({ ...receipt, runId: 'changed-during-exec', state: 'stopped' }),
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(execution.closed).toBe(true);
    const directory = dirname(journal);
    const rows = (await readFile(join(directory, SUBMISSION_JOURNAL), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    expect(rows.map((row) => row.state)).toEqual(['submitted', 'client-closed-unknown']);
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([]);
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).toThrow();
    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it.each([true, false])(
  'preserves successful bound exec behavior with custody=%s',
  async (custodied) => {
    await withBoundExec(async ({ target, journal }) => {
      if (!custodied) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      execution.succeeds = true;
      expect(await execBrowser(target, 'unused controlled protocol')).toBe('ready\n');
      expect(execution.closed).toBe(true);
      const directory = dirname(journal);
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).not.toThrow();
      const text = await readFile(join(directory, SUBMISSION_JOURNAL), 'utf8');
      if (custodied) {
        const rows = text
          .trimEnd()
          .split('\n')
          .map((line) => record(JSON.parse(line)));
        expect(rows.map((row) => row.state)).toEqual(['submitted', 'settled']);
      } else expect(text).toBe('');
      expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([]);
    });
  },
);

it.each(['name', 'foreign-id', 'foreign-pointer', 'missing-pointer', 'unknown-acquisition'])(
  'refuses %s browser authority before spawning an exec client',
  async (fault) => {
    await withBoundExec(async ({ target, receipt, pointer, journal }) => {
      let supplied = target;
      if (fault === 'name') supplied = { ...target, containerId: String(receipt.containerName) };
      if (fault === 'foreign-id') supplied = { ...target, containerId: 'e'.repeat(64) };
      if (fault === 'foreign-pointer')
        await writeReceipt(pointer, { ...receipt, runId: 'foreign-owner' });
      if (fault === 'missing-pointer') await rm(pointer);
      if (fault === 'unknown-acquisition') {
        record(receipt.acquisition).state = 'uncertain';
        await writeReceipt(target.receiptFile, receipt);
      }
      await expect(execBrowser(supplied, 'must-not-dispatch')).rejects.toThrow();
      expect(execution.child).toBeUndefined();
      expect(await readFile(join(dirname(journal), SUBMISSION_JOURNAL), 'utf8')).toBe('');
    });
  },
);

it('joins an actual failed spawn before publishing its unknown browser exec outcome', async () => {
  await withBoundExec(async ({ target, journal }) => {
    const directory = dirname(journal);
    execution.missingExecutable = join(directory, 'missing-owned-exec');
    await expect(execBrowser(target, 'unused controlled protocol')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(execution.closed).toBe(true);
    const rows = (await readFile(join(directory, SUBMISSION_JOURNAL), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    expect(rows.at(-1)).toMatchObject({
      state: 'client-closed-unknown',
      client: { failure: 'spawn' },
    });
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([]);
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).toThrow();
  });
});

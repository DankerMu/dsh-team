import { join } from 'node:path';
import { createDockerCommands } from '../platform/test/docker-command.ts';
import {
  acquireDeploymentLock,
  deploymentPlatformRuns,
  ownedDeploymentPlatform,
  retireCleanupJournal,
} from '../platform/test/docker-cleanup.ts';
import { observeSubmissionWriters, readTrustedDockerJournal } from './trusted-docker-audit.mjs';
import { readInvocation } from './trusted-docker-record.mjs';
import {
  readVerificationSubmissionsForCleanup,
  readVerificationWritersBeforeRetirement,
} from './verification-submission-assessment.mjs';

/** Exact IDs of fixed platforms that a registering run still owns; inspection only. */
async function ownedPlatformIds(commandAsync, entries) {
  const ids = new Set();
  for (const runId of deploymentPlatformRuns(entries)) {
    try {
      const platform = await ownedDeploymentPlatform(commandAsync, runId);
      if (platform !== undefined) ids.add(platform.id);
    } catch {
      // A foreign or unreadable platform grants no exemption; its writer must then be absent.
    }
  }
  return ids;
}

/**
 * Called only after the owner itself signalled its group and the group, its producers and
 * browser producers settled. Before any mutation every observer writer must be dead or absent,
 * except a run's own exactly bound deployment platform, and the invocation digest must still
 * match. Retirement removes only exact journal registrations; failures are returned, never
 * thrown, and the read-only assessment alone decides cleanup confirmation afterwards.
 * @param {{invocation: string, root: string}} request
 * @param {string} directory
 * @param {string} digest
 * @returns {Promise<unknown[]>}
 */
export async function retireCancelledJournal(request, directory, digest) {
  const failures = [];
  try {
    const entries = await readTrustedDockerJournal(directory);
    const { command, commandAsync } = createDockerCommands(
      request.root,
      join(directory, 'docker'),
      true,
    );
    const writers = readVerificationWritersBeforeRetirement(directory);
    const exempt = await ownedPlatformIds(commandAsync, entries);
    await observeSubmissionWriters(writers, command, new Set(), exempt);
    if ((await readInvocation(request.invocation)).digest !== digest)
      throw new Error('Trusted Docker identity changed before retirement');
    await retireCleanupJournal(
      entries,
      {
        command,
        commandAsync,
        acquireLock: acquireDeploymentLock,
        requireSettled: () => {
          readVerificationSubmissionsForCleanup(directory);
        },
      },
      failures,
    );
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

import { cliSubmissionCall } from './verification-submission-storage.mjs';
import { beginVerificationSubmission } from './verification-submissions.mjs';

/** @typedef {{ file: string, args: readonly string[] }} DockerExecution */

/**
 * Fixed production selection; controlled process fixtures replace only this transport seam.
 * @param {readonly string[]} args
 * @returns {DockerExecution}
 */
export function selectDockerExecution(args) {
  return { file: 'docker', args };
}

function submission(execution) {
  // The controlled Node subprocess fixtures never dispatch to Docker. Unknown executables
  // remain conservative; this is not an environment-driven executable override.
  if (execution.file === process.execPath) return undefined;
  const args = execution.args;
  const verb = ['container', 'image', 'network', 'volume'].includes(args[0] ?? '')
    ? args[1]
    : args[0];
  if (
    execution.file === 'docker' &&
    ['inspect', 'ls', 'list', 'logs', 'version', 'info', 'wait', 'events'].includes(verb ?? '')
  )
    return undefined;
  return beginVerificationSubmission(cliSubmissionCall(args));
}

function completeResult(result, complete, acceptedStatus) {
  if (result.error === undefined && result.status === 0) complete?.();
  // Only an explicitly declared, normally exited CLI status is an answered outcome.
  else if (
    acceptedStatus !== undefined &&
    result.error === undefined &&
    !result.signal &&
    result.status === acceptedStatus
  )
    complete?.();
  return result;
}

/**
 * Publish before the selected external process boundary, retaining its original result.
 * A caller may declare one expected nonzero exit status that it independently verifies.
 * @template {{ status: number | null, error?: unknown, signal?: string | null }} T
 * @param {DockerExecution} execution
 * @param {(execution: DockerExecution) => T} dispatch
 * @param {number} [acceptedStatus]
 * @returns {T}
 */
export function runDockerCommand(execution, dispatch, acceptedStatus) {
  const complete = submission(execution);
  return completeResult(dispatch(execution), complete, acceptedStatus);
}

/**
 * The caller's existing collector owns timeouts, streams, killing and actual child closure.
 * @template {{ status: number | null, error?: unknown }} T
 * @param {DockerExecution} execution
 * @param {(execution: DockerExecution) => Promise<T>} dispatch
 * @returns {Promise<T>}
 */
export async function runDockerCommandAsync(execution, dispatch) {
  const complete = submission(execution);
  return completeResult(await dispatch(execution), complete);
}

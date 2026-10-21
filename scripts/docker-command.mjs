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
  return beginVerificationSubmission();
}

function completeResult(result, complete) {
  if (result.error === undefined && result.status === 0) complete?.();
  return result;
}

/**
 * Publish before the selected external process boundary, retaining its original result.
 * @template {{ status: number | null, error?: unknown }} T
 * @param {DockerExecution} execution
 * @param {(execution: DockerExecution) => T} dispatch
 * @returns {T}
 */
export function runDockerCommand(execution, dispatch) {
  const complete = submission(execution);
  return completeResult(dispatch(execution), complete);
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

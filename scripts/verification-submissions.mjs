import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import {
  BROWSER_EXEC_AUTHORITY,
  SUBMISSION_JOURNAL,
  captureAuthority,
  createPrivate,
  pathIdentity,
  readPrivate,
  requireBrowserExecClient,
  reserveSubmission,
  sameIdentity,
  submissionCompletion,
  submissionPublication,
  syncDirectory,
} from './verification-submission-storage.mjs';

/**
 * Only the canonical browser helper supplies a validated, captured receipt authority.
 * @param {import('./probe-browser-exec.mjs').BrowserExecAuthority} authority
 * @returns {(client: import('./verification-submission-storage.mjs').BrowserExecClientOutcome) => void}
 */
export function beginVerificationBrowserExec(authority) {
  const path = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  if (!path) return () => undefined;
  const directory = dirname(dirname(path));
  if (
    !isAbsolute(path) ||
    path !== join(directory, SUBMISSION_JOURNAL) ||
    authority?.version !== 1 ||
    typeof authority.pointer !== 'string' ||
    Object.keys(authority).sort().join(',') !==
      'browser,directoryIdentity,pointer,receiptFile,version'
  )
    throw new Error('Browser exec custody authority unavailable');
  const captured = captureAuthority(directory);
  sameIdentity(
    pathIdentity(join(directory, BROWSER_EXEC_AUTHORITY), true),
    captured.authority.browserExec,
  );
  const text = JSON.stringify(authority);
  const digest = createHash('sha256').update(text).digest('hex');
  const reservation = reserveSubmission(directory, { browserExec: digest }, undefined, {
    browserExec: digest,
  });
  const grantPath = join(directory, BROWSER_EXEC_AUTHORITY, `${reservation.id}.json`);
  const grantText = `${JSON.stringify({
    version: 1,
    id: reservation.id,
    invocation: captured.authority.invocation,
    authority,
  })}\n`;
  const grantIdentity = createPrivate(grantPath, grantText);
  syncDirectory(join(directory, BROWSER_EXEC_AUTHORITY));
  captureAuthority(directory, captured);
  sameIdentity(
    pathIdentity(join(directory, BROWSER_EXEC_AUTHORITY), true),
    captured.authority.browserExec,
  );
  const publish = submissionPublication(directory, reservation);
  return (client) => {
    requireBrowserExecClient(client);
    if (readPrivate(grantPath, grantIdentity) !== grantText)
      throw new Error('Browser exec captured authority changed');
    if (client.exitCode === 0 && client.signal === null && client.failure === null)
      publish('settled');
    else publish('client-closed-unknown', { client });
  };
}

/**
 * Publish before dispatch; no arguments, output or cleanup authority are retained.
 * @returns {() => void}
 */
export function beginVerificationSubmission() {
  const path = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  if (!path) return () => undefined;
  const directory = dirname(dirname(path));
  if (!isAbsolute(path) || path !== join(directory, SUBMISSION_JOURNAL))
    throw new Error('Verification submission journal path is not canonical');
  return submissionCompletion(directory, reserveSubmission(directory));
}

function isObservation(method, endpoint) {
  return (
    method === 'GET' ||
    method === 'HEAD' ||
    (method === 'POST' && /^\/containers\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\/wait$/.test(endpoint))
  );
}

function isDefinitiveRejection(method, endpoint, statusCode) {
  return (
    (method === 'POST' && endpoint === '/networks/create' && statusCode === 403) ||
    (method === 'POST' &&
      /^\/containers\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\/stop$/.test(endpoint) &&
      statusCode === 304) ||
    (method === 'DELETE' &&
      /^\/(?:containers|networks|volumes)\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(endpoint) &&
      statusCode === 404)
  );
}

/**
 * Share the original client's JSON boundary without importing a runtime client or its error class.
 * @template {{ json(method: string, path: string, body?: unknown, signal?: AbortSignal, maxBytes?: number): Promise<unknown> }} T
 * @param {T} client
 * @param {new (statusCode: number) => Error & { statusCode: number }} DockerHttpError
 * @param {() => (() => void)} [submit]
 */
export function trackVerificationDockerClient(
  client,
  DockerHttpError,
  submit = beginVerificationSubmission,
) {
  return {
    ...client,
    /**
     * @param {string} method
     * @param {string} path
     * @param {unknown} [body]
     * @param {AbortSignal} [signal]
     * @param {number} [maxBytes]
     */
    async json(method, path, body, signal, maxBytes) {
      // Do not decode or normalize a path into a different authorized endpoint.
      const query = path.indexOf('?');
      const endpoint = query === -1 ? path : path.slice(0, query);
      if (isObservation(method, endpoint)) return client.json(method, path, body, signal, maxBytes);
      const complete = submit();
      let document;
      try {
        document = await client.json(method, path, body, signal, maxBytes);
      } catch (error) {
        if (
          error instanceof DockerHttpError &&
          isDefinitiveRejection(method, endpoint, error.statusCode)
        ) {
          try {
            complete();
          } catch {
            // The durable exact marker (or invalid authority) keeps assessment unconfirmed.
            // Preserve the original canonical rejection; never substitute a publication error.
          }
        }
        throw error;
      }
      complete();
      return document;
    },
  };
}

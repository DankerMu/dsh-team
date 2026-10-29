const FAST_EXIT_STAGE = 'started container inspection';
const FAST_EXIT_MESSAGE = `Container startup failed during ${FAST_EXIT_STAGE}`;

/**
 * Docker readiness acceptance: true only for the plain startup error produced when the started
 * container has already exited at its post-start inspection. Docker-layer failures (start
 * status, cleanup, unconfirmed network or home helper) have a different shape and stay false.
 */
export function isBadOverlayFastExit(error: unknown): boolean {
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return false;
  if (error.message !== FAST_EXIT_MESSAGE) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const fields = new Map<string, unknown>(Object.entries(cause));
  return (
    fields.get('stage') === FAST_EXIT_STAGE &&
    fields.get('cleanupFailed') === false &&
    fields.get('networkUnconfirmed') === false &&
    fields.get('dockerStatus') === undefined
  );
}

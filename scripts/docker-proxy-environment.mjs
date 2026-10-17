/** Verification Docker clients only; values may contain credentials and must never be logged. */
export function dockerProxyEnvironment() {
  return {
    ...(process.env.HTTP_PROXY === undefined ? {} : { HTTP_PROXY: process.env.HTTP_PROXY }),
    ...(process.env.HTTPS_PROXY === undefined ? {} : { HTTPS_PROXY: process.env.HTTPS_PROXY }),
    ...(process.env.NO_PROXY === undefined ? {} : { NO_PROXY: process.env.NO_PROXY }),
  };
}

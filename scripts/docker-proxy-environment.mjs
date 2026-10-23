import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const INVALID = 'Trusted host Docker proxy configuration invalid';
const MAX_BYTES = 16_384;

/** @param {string} value */
function loopbackProxy(value) {
  if (value === '') return true;
  if (!/^https?:\/\/(?:[^/?#]*@)?(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) return false;
  try {
    return ['127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {{HTTP_PROXY?: string, HTTPS_PROXY?: string, NO_PROXY?: string}}
 */
function proxyFields(text) {
  const value = /** @type {unknown} */ (JSON.parse(text));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(INVALID);
  /** @type {{HTTP_PROXY?: string, HTTPS_PROXY?: string, NO_PROXY?: string}} */
  const result = {};
  for (const [name, selected] of Object.entries(value)) {
    if (name !== 'HTTP_PROXY' && name !== 'HTTPS_PROXY' && name !== 'NO_PROXY')
      throw new Error(INVALID);
    if (typeof selected !== 'string' || /[\0\r\n]/.test(selected)) throw new Error(INVALID);
    if (name !== 'NO_PROXY' && !loopbackProxy(selected)) throw new Error(INVALID);
    result[name] = selected;
  }
  return result;
}

/** @param {number} descriptor @param {number} uid */
function readProxyFields(descriptor, uid) {
  const info = fstatSync(descriptor);
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.size > MAX_BYTES)
    throw new Error(INVALID);
  const bytes = Buffer.allocUnsafe(MAX_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(descriptor, bytes, length, bytes.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length > MAX_BYTES) throw new Error(INVALID);
  return proxyFields(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
}

/** @param {number} uid */
function hostProxyEnvironment(uid) {
  let descriptor;
  try {
    descriptor = openSync(
      join(homedir(), '.config/dsh-team/docker-proxy.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    // Project the failed open below without retaining a private filesystem error.
  }
  if (descriptor === undefined) throw new Error(INVALID);
  /** @type {ReturnType<typeof proxyFields> | undefined} */
  let selected;
  try {
    selected = readProxyFields(descriptor, uid);
  } catch {
    // Project rejection only after closure; raw config/parse errors are not retained.
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      selected = undefined;
    }
  }
  if (selected === undefined) throw new Error(INVALID);
  return selected;
}

/** Verification Docker clients only; values may contain credentials and must never be logged. */
export function dockerProxyEnvironment() {
  const invocation = process.env.DSH_TEAM_CI_INVOCATION;
  if (invocation !== undefined) {
    const uid = process.getuid?.();
    if (
      platform() !== 'linux' ||
      uid === undefined ||
      uid === 0 ||
      !/^[a-f0-9-]{36}$/.test(invocation)
    )
      throw new Error(INVALID);
    return hostProxyEnvironment(uid);
  }
  return {
    ...(process.env.HTTP_PROXY === undefined ? {} : { HTTP_PROXY: process.env.HTTP_PROXY }),
    ...(process.env.HTTPS_PROXY === undefined ? {} : { HTTPS_PROXY: process.env.HTTPS_PROXY }),
    ...(process.env.NO_PROXY === undefined ? {} : { NO_PROXY: process.env.NO_PROXY }),
  };
}

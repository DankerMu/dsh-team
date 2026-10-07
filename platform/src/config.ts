import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

export interface PlatformConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly dataDir: string;
  readonly managedConfigDir: string;
  readonly dockerSocketPath: string;
  readonly publicUrl: string;
  readonly authority: string;
  readonly cookieSecure: boolean;
  readonly trustedProxies: readonly string[];
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '8080';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_DATA_DIR = './data';
const MAX_PORT = 65535;

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > MAX_PORT) {
    throw new Error(
      `PLATFORM_PORT must be an integer between 1 and ${String(MAX_PORT)}, got "${raw}"`,
    );
  }
  return port;
}

function parseLogLevel(raw: string): LogLevel {
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new Error(`PLATFORM_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
  }
  return level;
}

function isInvalidPath(raw: string): boolean {
  return raw.trim() === '' || raw.includes('\0');
}

function parseDataDir(raw: string): string {
  if (isInvalidPath(raw)) {
    throw new Error(`PLATFORM_DATA_DIR must be a nonempty path, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function parseManagedConfigDir(raw: string): string {
  if (isInvalidPath(raw)) {
    throw new Error('PLATFORM_MANAGED_CONFIG_DIR must be a nonempty path');
  }
  return raw;
}

function parseDockerSocket(raw: string): string {
  if (isInvalidPath(raw) || !isAbsolute(raw)) {
    throw new Error('PLATFORM_DOCKER_SOCKET must be an absolute nonempty path without NUL');
  }
  return raw;
}

function rejectPublicUrl(): never {
  throw new Error('PLATFORM_PUBLIC_URL must be an absolute HTTP(S) origin');
}

function rejectRawPublicUrl(raw: string): void {
  const framed = /^(https?):\/\/([^/]+)(\/)?$/i.exec(raw);
  const authority = framed?.[2];
  if (framed === null || authority === undefined || authority.endsWith(':')) {
    rejectPublicUrl();
  }
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 32 || code === 127) {
      rejectPublicUrl();
    }
  }
  if (/[\s\\?#@]/.test(raw)) {
    rejectPublicUrl();
  }
}

function parsePublicUrl(raw: string | undefined): URL {
  if (raw === undefined) {
    throw new Error('PLATFORM_PUBLIC_URL is required');
  }
  rejectRawPublicUrl(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    rejectPublicUrl();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    url.port === '0' ||
    url.hostname === ''
  ) {
    rejectPublicUrl();
  }
  return url;
}

function parseCookieSecure(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    return true;
  }
  throw new Error('PLATFORM_COOKIE_SECURE must be exactly true or false');
}

function parseTrustedProxies(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const members = raw.split(',');
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]?.trim() ?? '';
    if (member === '' || isIP(member) === 0) {
      throw new Error('PLATFORM_TRUSTED_PROXIES must be a comma-separated list of IP addresses');
    }
    members[index] = member;
  }
  return members;
}

/**
 * Resolve the platform configuration from environment variables.
 * Invalid values throw at startup; they are never replaced by a default.
 */
export function loadConfig(env: NodeJS.ProcessEnv): PlatformConfig {
  const publicOrigin = parsePublicUrl(env.PLATFORM_PUBLIC_URL);
  const dataDir = parseDataDir(env.PLATFORM_DATA_DIR ?? DEFAULT_DATA_DIR);
  const managedConfigDir =
    env.PLATFORM_MANAGED_CONFIG_DIR === undefined
      ? resolve(dataDir, 'managed-config')
      : resolve(parseManagedConfigDir(env.PLATFORM_MANAGED_CONFIG_DIR));
  return {
    host: env.PLATFORM_HOST ?? DEFAULT_HOST,
    port: parsePort(env.PLATFORM_PORT ?? DEFAULT_PORT),
    logLevel: parseLogLevel(env.PLATFORM_LOG_LEVEL ?? DEFAULT_LOG_LEVEL),
    dataDir,
    managedConfigDir,
    dockerSocketPath: parseDockerSocket(env.PLATFORM_DOCKER_SOCKET ?? '/var/run/docker.sock'),
    publicUrl: publicOrigin.origin,
    authority: publicOrigin.host,
    cookieSecure: parseCookieSecure(env.PLATFORM_COOKIE_SECURE),
    trustedProxies: parseTrustedProxies(env.PLATFORM_TRUSTED_PROXIES),
  };
}

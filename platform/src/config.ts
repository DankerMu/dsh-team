import { accessSync, constants, statSync } from 'node:fs';
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
  readonly userImage: string;
  readonly seccompProfilePath: string;
  readonly subnetPool: string;
  readonly upstreamMode: 'network' | 'published-loopback';
  readonly platformContainerName: string;
  readonly publicUrl: string;
  readonly authority: string;
  readonly cookieSecure: boolean;
  readonly trustedProxies: readonly string[];
  /** Absent: employee instances get no fonts bind (blank values count as unset). */
  readonly instanceFontsDir?: string;
  /** `null`: the bundled Document Server is unconfigured and Office is unavailable. */
  readonly documentServer: {
    readonly containerName: string;
    readonly jwtSecret: string;
  } | null;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '8080';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_DATA_DIR = './data';
const MAX_PORT = 65535;

function parseHost(raw: string): string {
  if (isIP(raw) !== 0) return raw;
  const hostname = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  if (
    hostname.length > 253 ||
    /^[\d.]+$/.test(hostname) ||
    !hostname.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  )
    throw new Error('PLATFORM_HOST must be an IP address or DNS hostname');
  return raw;
}

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

function parseUserImage(raw: string): string {
  if (isInvalidPath(raw) || /\s/.test(raw)) {
    throw new Error(
      'PLATFORM_USER_IMAGE must be a nonempty image reference without whitespace or NUL',
    );
  }
  return raw;
}

function parseSeccompProfile(raw: string): string {
  if (isInvalidPath(raw)) {
    throw new Error('PLATFORM_SECCOMP_PROFILE must be a nonempty path without NUL');
  }
  return resolve(raw);
}

function parseUpstreamMode(raw: string): PlatformConfig['upstreamMode'] {
  if (raw !== 'network' && raw !== 'published-loopback')
    throw new Error('PLATFORM_UPSTREAM_MODE must be exactly network or published-loopback');
  return raw;
}

function parseContainerName(variable: string, raw: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(raw) || /^[a-fA-F0-9]{12,64}$/.test(raw))
    throw new Error(`${variable} must be a Docker container name, not an ID or path`);
  return raw;
}

const DOCUMENT_SERVER_CONTAINER_NAME = 'DOCUMENT_SERVER_CONTAINER_NAME';
const DOCUMENT_SERVER_JWT_SECRET = 'DOCUMENT_SERVER_JWT_SECRET';

/** Both inputs absent means unconfigured; an empty value is never treated as absent. */
function parseDocumentServer(
  containerName: string | undefined,
  jwtSecret: string | undefined,
): PlatformConfig['documentServer'] {
  if (containerName === undefined && jwtSecret === undefined) return null;
  const empty = [
    ...(containerName === '' ? [DOCUMENT_SERVER_CONTAINER_NAME] : []),
    ...(jwtSecret === '' ? [DOCUMENT_SERVER_JWT_SECRET] : []),
  ];
  if (empty.length > 0) throw new Error(`${empty.join(' and ')} must not be empty`);
  if (jwtSecret === undefined)
    throw new Error(
      `${DOCUMENT_SERVER_JWT_SECRET} is required when ${DOCUMENT_SERVER_CONTAINER_NAME} is set`,
    );
  if (containerName === undefined)
    throw new Error(
      `${DOCUMENT_SERVER_CONTAINER_NAME} is required when ${DOCUMENT_SERVER_JWT_SECRET} is set`,
    );
  return {
    containerName: parseContainerName(DOCUMENT_SERVER_CONTAINER_NAME, containerName),
    jwtSecret,
  };
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

/** Blank is unset; otherwise an absolute readable directory, reported without its value. */
function parseInstanceFontsDir(raw: string | undefined): Pick<PlatformConfig, 'instanceFontsDir'> {
  if (raw === undefined || raw.trim() === '') return {};
  if (!raw.includes('\0') && isAbsolute(raw)) {
    try {
      if (statSync(raw).isDirectory()) {
        accessSync(raw, constants.R_OK | constants.X_OK);
        return { instanceFontsDir: raw };
      }
    } catch {
      // The filesystem error names the path; the fixed message below never does.
    }
  }
  throw new Error('PLATFORM_INSTANCE_FONTS_DIR must be an absolute readable directory');
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
    host: parseHost(env.PLATFORM_HOST ?? DEFAULT_HOST),
    port: parsePort(env.PLATFORM_PORT ?? DEFAULT_PORT),
    logLevel: parseLogLevel(env.PLATFORM_LOG_LEVEL ?? DEFAULT_LOG_LEVEL),
    dataDir,
    managedConfigDir,
    dockerSocketPath: parseDockerSocket(env.PLATFORM_DOCKER_SOCKET ?? '/var/run/docker.sock'),
    userImage: parseUserImage(env.PLATFORM_USER_IMAGE ?? 'dsh-team-user:local'),
    seccompProfilePath: parseSeccompProfile(
      env.PLATFORM_SECCOMP_PROFILE ?? 'images/seccomp/dsh-user.json',
    ),
    subnetPool: env.PLATFORM_SUBNET_POOL ?? '172.30.0.0/16',
    upstreamMode: parseUpstreamMode(env.PLATFORM_UPSTREAM_MODE ?? 'network'),
    platformContainerName: parseContainerName(
      'PLATFORM_CONTAINER_NAME',
      env.PLATFORM_CONTAINER_NAME ?? 'dsh-team-platform',
    ),
    publicUrl: publicOrigin.origin,
    authority: publicOrigin.host,
    cookieSecure: parseCookieSecure(env.PLATFORM_COOKIE_SECURE),
    trustedProxies: parseTrustedProxies(env.PLATFORM_TRUSTED_PROXIES),
    ...parseInstanceFontsDir(env.PLATFORM_INSTANCE_FONTS_DIR),
    // Last, so a verbatim .env.example copy reports its empty JWT only after every other field.
    documentServer: parseDocumentServer(
      env.DOCUMENT_SERVER_CONTAINER_NAME,
      env.DOCUMENT_SERVER_JWT_SECRET,
    ),
  };
}

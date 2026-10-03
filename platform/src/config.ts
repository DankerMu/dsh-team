const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

export interface PlatformConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '8080';
const DEFAULT_LOG_LEVEL = 'info';
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

/**
 * Resolve the platform configuration from environment variables.
 * Invalid values throw at startup; they are never replaced by a default.
 */
export function loadConfig(env: NodeJS.ProcessEnv): PlatformConfig {
  return {
    host: env.PLATFORM_HOST ?? DEFAULT_HOST,
    port: parsePort(env.PLATFORM_PORT ?? DEFAULT_PORT),
    logLevel: parseLogLevel(env.PLATFORM_LOG_LEVEL ?? DEFAULT_LOG_LEVEL),
  };
}

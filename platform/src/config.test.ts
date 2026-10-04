import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('uses local defaults when no variable is set', () => {
    const config = loadConfig({});

    expect(config).toEqual({ host: '127.0.0.1', port: 8080, logLevel: 'info', dataDir: './data' });
  });

  it('reads host, port and log level from the environment', () => {
    const config = loadConfig({
      PLATFORM_HOST: '0.0.0.0',
      PLATFORM_PORT: '9090',
      PLATFORM_LOG_LEVEL: 'debug',
    });

    expect(config).toEqual({ host: '0.0.0.0', port: 9090, logLevel: 'debug', dataDir: './data' });
  });

  it.each(['0', '65536', '-1', '80.5', 'abc', ''])('rejects port "%s"', (port) => {
    expect(() => loadConfig({ PLATFORM_PORT: port })).toThrow(/PLATFORM_PORT must be an integer/);
  });

  it('accepts the boundary ports 1 and 65535', () => {
    expect(loadConfig({ PLATFORM_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ PLATFORM_PORT: '65535' }).port).toBe(65535);
  });

  it('rejects an unknown log level and names the variable', () => {
    expect(() => loadConfig({ PLATFORM_LOG_LEVEL: 'verbose' })).toThrow(
      /PLATFORM_LOG_LEVEL must be one of .* got "verbose"/,
    );
  });

  it('maps PLATFORM_DATA_DIR to dataDir', () => {
    const config = loadConfig({ PLATFORM_DATA_DIR: '/srv/dsh-team' });

    expect(config.dataDir).toBe('/srv/dsh-team');
  });

  it.each(['', '   '])('rejects blank PLATFORM_DATA_DIR "%s" and names the variable', (dataDir) => {
    expect(() => loadConfig({ PLATFORM_DATA_DIR: dataDir })).toThrow(/PLATFORM_DATA_DIR/);
  });

  it('rejects PLATFORM_DATA_DIR containing NUL and names the variable', () => {
    expect(() => loadConfig({ PLATFORM_DATA_DIR: 'data\0dir' })).toThrow(/PLATFORM_DATA_DIR/);
  });
});

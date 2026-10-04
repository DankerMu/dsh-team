import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const REQUIRED_PUBLIC_URL = {
  PLATFORM_PUBLIC_URL: 'http://example.com',
} as const;

describe('loadConfig', () => {
  it('uses local defaults when the required public URL is provided', () => {
    const config = loadConfig(REQUIRED_PUBLIC_URL);

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      dataDir: './data',
    });
  });

  it('reads host, port and log level from the environment', () => {
    const config = loadConfig({
      ...REQUIRED_PUBLIC_URL,
      PLATFORM_HOST: '0.0.0.0',
      PLATFORM_PORT: '9090',
      PLATFORM_LOG_LEVEL: 'debug',
    });

    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 9090,
      logLevel: 'debug',
      dataDir: './data',
    });
  });

  it.each(['0', '65536', '-1', '80.5', 'abc', ''])('rejects port "%s"', (port) => {
    expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_PORT: port })).toThrow(
      /PLATFORM_PORT/,
    );
  });

  it('accepts the boundary ports 1 and 65535', () => {
    expect(loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_PORT: '65535' }).port).toBe(65535);
  });

  it('rejects an unknown log level and names the variable', () => {
    expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_LOG_LEVEL: 'verbose' })).toThrow(
      /PLATFORM_LOG_LEVEL/,
    );
  });

  it('maps PLATFORM_DATA_DIR to dataDir', () => {
    const config = loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_DATA_DIR: '/srv/dsh-team' });

    expect(config.dataDir).toBe('/srv/dsh-team');
  });

  it.each(['', '   '])('rejects blank PLATFORM_DATA_DIR "%s" and names the variable', (dataDir) => {
    expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_DATA_DIR: dataDir })).toThrow(
      /PLATFORM_DATA_DIR/,
    );
  });

  it('rejects PLATFORM_DATA_DIR containing NUL and names the variable', () => {
    expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_DATA_DIR: 'data\0dir' })).toThrow(
      /PLATFORM_DATA_DIR/,
    );
  });

  it('rejects a missing public URL and names the variable', () => {
    expect(() => loadConfig({})).toThrow(/PLATFORM_PUBLIC_URL/);
  });

  it.each([
    ['http://example.com', 'http://example.com', 'example.com'],
    ['http://example.com/', 'http://example.com', 'example.com'],
    ['http://example.com:80', 'http://example.com', 'example.com'],
    ['http://example.com:8080', 'http://example.com:8080', 'example.com:8080'],
    ['https://example.com', 'https://example.com', 'example.com'],
    ['https://example.com/', 'https://example.com', 'example.com'],
    ['https://example.com:443', 'https://example.com', 'example.com'],
    ['https://example.com:8443', 'https://example.com:8443', 'example.com:8443'],
    ['http://EXAMPLE.com', 'http://example.com', 'example.com'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080', '127.0.0.1:8080'],
    ['http://[::1]', 'http://[::1]', '[::1]'],
    ['http://[::1]:80', 'http://[::1]', '[::1]'],
    ['http://[::1]:8080', 'http://[::1]:8080', '[::1]:8080'],
    ['https://[2001:db8::1]/', 'https://[2001:db8::1]', '[2001:db8::1]'],
    ['https://[2001:db8::1]:8443', 'https://[2001:db8::1]:8443', '[2001:db8::1]:8443'],
  ] as const)('canonicalizes %s to origin %s and authority %s', (raw, publicUrl, authority) => {
    const config = loadConfig({ PLATFORM_PUBLIC_URL: raw });

    expect(config).toMatchObject({ publicUrl, authority });
  });

  it.each([
    '',
    '   ',
    'example.com',
    'ftp://example.com',
    'http://',
    'http://example.com:0',
    'http://example.com:65536',
    'http://example.com:abc',
    'http://@example.com',
    'http://:@example.com',
    'http://example.com/path',
    'http://example.com/a/..',
    'http://example.com?',
    'http://example.com#',
    'http://example.com?q=1',
    'http://example.com#frag',
    'http://example.com\\foo',
    ' http://example.com',
    'http://example.com ',
    'http://exam ple.com',
    'http://example.com\n',
    'http://example.com\t',
    'http://example.com\0',
    'http://[::1',
  ])('rejects invalid public URL %j and names the variable', (raw) => {
    expect(() => loadConfig({ PLATFORM_PUBLIC_URL: raw })).toThrow(/PLATFORM_PUBLIC_URL/);
  });

  it('rejects credentials in the public URL without echoing the secret', () => {
    const env = { PLATFORM_PUBLIC_URL: 'http://user:s3cret@example.com' };

    expect(() => loadConfig(env)).toThrow(/PLATFORM_PUBLIC_URL/);
    expect(() => loadConfig(env)).not.toThrow(/s3cret/);
  });

  it('defaults cookieSecure to false when PLATFORM_COOKIE_SECURE is absent', () => {
    const config = loadConfig(REQUIRED_PUBLIC_URL);

    expect(config).toMatchObject({ cookieSecure: false });
  });

  it('keeps cookieSecure false for an HTTPS origin when the setting is absent', () => {
    const config = loadConfig({ PLATFORM_PUBLIC_URL: 'https://example.com' });

    expect(config).toMatchObject({ cookieSecure: false });
  });

  it.each([
    ['http://example.com', 'true', true],
    ['https://example.com', 'false', false],
  ] as const)(
    'reads cookieSecure independently of scheme for %s with setting %s',
    (publicUrl, cookieSecure, expected) => {
      const config = loadConfig({
        PLATFORM_PUBLIC_URL: publicUrl,
        PLATFORM_COOKIE_SECURE: cookieSecure,
      });

      expect(config).toMatchObject({ cookieSecure: expected });
    },
  );

  it.each(['', '1', '0', 'TRUE', 'False', 'yes', ' ', ' true '])(
    'rejects invalid PLATFORM_COOKIE_SECURE %j and names the variable',
    (raw) => {
      expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_COOKIE_SECURE: raw })).toThrow(
        /PLATFORM_COOKIE_SECURE/,
      );
    },
  );

  it('rejects PLATFORM_COOKIE_SECURE without echoing the supplied value', () => {
    const env = { ...REQUIRED_PUBLIC_URL, PLATFORM_COOKIE_SECURE: 'not-a-boolean-sentinel' };

    expect(() => loadConfig(env)).toThrow(/PLATFORM_COOKIE_SECURE/);
    expect(() => loadConfig(env)).not.toThrow(/not-a-boolean-sentinel/);
  });

  it('defaults trustedProxies to an empty list when PLATFORM_TRUSTED_PROXIES is absent', () => {
    const config = loadConfig(REQUIRED_PUBLIC_URL);

    expect(config).toMatchObject({ trustedProxies: [] });
  });

  it.each(['', '   ', '\t'])(
    'treats blank PLATFORM_TRUSTED_PROXIES %j as no trusted proxy',
    (raw) => {
      const config = loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_TRUSTED_PROXIES: raw });

      expect(config).toMatchObject({ trustedProxies: [] });
    },
  );

  it('parses comma-separated IPv4 and IPv6 literals in order without deduplicating', () => {
    const config = loadConfig({
      ...REQUIRED_PUBLIC_URL,
      PLATFORM_TRUSTED_PROXIES: ' 192.0.2.10 , 2001:db8::1, 192.0.2.10 ',
    });

    expect(config).toMatchObject({
      trustedProxies: ['192.0.2.10', '2001:db8::1', '192.0.2.10'],
    });
  });

  it.each([
    '192.0.2.10,,198.51.100.1',
    ',192.0.2.10',
    '192.0.2.10,',
    '192.0.2.10, ,198.51.100.1',
    'proxy.example.com',
    '192.0.2.0/24',
    '2001:db8::/32',
    '*',
    '999.0.0.1',
    'gggg::1',
    '[2001:db8::1]',
  ])('rejects invalid PLATFORM_TRUSTED_PROXIES %j and names the variable', (raw) => {
    expect(() => loadConfig({ ...REQUIRED_PUBLIC_URL, PLATFORM_TRUSTED_PROXIES: raw })).toThrow(
      /PLATFORM_TRUSTED_PROXIES/,
    );
  });

  it('rejects PLATFORM_TRUSTED_PROXIES without echoing the supplied value', () => {
    const env = { ...REQUIRED_PUBLIC_URL, PLATFORM_TRUSTED_PROXIES: 'not-an-ip-sentinel' };

    expect(() => loadConfig(env)).toThrow(/PLATFORM_TRUSTED_PROXIES/);
    expect(() => loadConfig(env)).not.toThrow(/not-an-ip-sentinel/);
  });
});

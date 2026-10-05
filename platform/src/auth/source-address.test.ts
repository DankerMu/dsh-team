import { describe, expect, it } from 'vitest';
import { createSourceAddressResolver } from './index.ts';

const PEER = '127.0.0.1';
const CLIENT = '198.51.100.7';
const PROXY = '192.0.2.10';
const SPOOF = '203.0.113.1';
const LOOPBACK_MAPPED = '::ffff:127.0.0.1';
const CLIENT_MAPPED = '::ffff:198.51.100.7';
const IPV6 = '2001:db8::1';
const IPV6_EXPANDED = '2001:0db8:0000:0000:0000:0000:0000:0001';
const IPV6_CLIENT = '2001:db8::2';
const SCOPED_ETH0 = 'fe80::1%eth0';
const SCOPED_ETH0_EXPANDED = 'FE80:0:0:0:0:0:0:1%eth0';
const SCOPED_ETH1 = 'fe80::1%eth1';
const SCOPED_ETH1_EXPANDED = 'FE80:0:0:0:0:0:0:1%eth1';
const SCOPED_BARE = 'fe80::1';
const MAPPED_SCOPED = '::ffff:192.0.2.10%eth0';
const MAPPED_SCOPED_CANONICAL = '::ffff:192.0.2.10%eth0';

function request(
  ip: string,
  forwardedFor?: string | readonly string[],
): {
  ip: string;
  headers: { 'x-forwarded-for'?: string | string[] };
} {
  const headers: { 'x-forwarded-for'?: string | string[] } = {};
  if (typeof forwardedFor === 'string') {
    headers['x-forwarded-for'] = forwardedFor;
  } else if (forwardedFor !== undefined) {
    headers['x-forwarded-for'] = [...forwardedFor];
  }
  return { ip, headers };
}

describe('createSourceAddressResolver', () => {
  it.each([
    ['an empty trust list', [] as const],
    ['a trust list that does not include the peer', [PROXY] as const],
  ])('returns the socket peer for %s despite X-Forwarded-For', (_label, trusted) => {
    expect(createSourceAddressResolver(trusted)(request(PEER, CLIENT))).toBe(PEER);
  });

  it.each([
    ['omitted', undefined],
    ['blank', '  '],
    ['an array', [CLIENT]],
  ] as const)(
    'returns the socket peer when a trusted peer sends %s X-Forwarded-For',
    (_label, forwardedFor) => {
      expect(createSourceAddressResolver([PEER])(request(PEER, forwardedFor))).toBe(PEER);
    },
  );

  it.each([
    ['a hostname', 'proxy.example.com'],
    ['a port', '127.0.0.1:80'],
    ['brackets', '[::1]'],
    ['an unknown marker', 'unknown'],
    ['an empty rightmost entry', `${CLIENT},`],
    ['an empty entry before the untrusted hop', `${CLIENT}, ,${PROXY}`],
  ])('returns the socket peer when a trusted hop encounters %s', (_label, forwardedFor) => {
    expect(createSourceAddressResolver([PEER, PROXY])(request(PEER, forwardedFor))).toBe(PEER);
  });

  it('falls back to the socket peer when a trusted suffix is preceded by a leading empty XFF entry', () => {
    const resolve = createSourceAddressResolver([PEER, PROXY]);
    expect(resolve(request(PEER, `,${PROXY}`))).toBe(PEER);
    expect(resolve(request(PEER, ','))).toBe(PEER);
  });

  it('ignores a malformed prefix left of the first untrusted client', () => {
    expect(
      createSourceAddressResolver([PEER, PROXY])(request(PEER, `unknown, ${CLIENT}, ${PROXY}`)),
    ).toBe(CLIENT);
  });

  it('returns the first untrusted hop and ignores a spoofed address to its left', () => {
    expect(
      createSourceAddressResolver([PEER, PROXY])(request(PEER, `${SPOOF}, ${CLIENT}, ${PROXY}`)),
    ).toBe(CLIENT);
  });

  it('returns the leftmost address when every forwarded hop is trusted', () => {
    expect(
      createSourceAddressResolver([PEER, PROXY, CLIENT, SPOOF])(
        request(PEER, `${SPOOF}, ${CLIENT}, ${PROXY}`),
      ),
    ).toBe(SPOOF);
  });

  it('selects a spaced untrusted client after a trusted hop', () => {
    expect(
      createSourceAddressResolver([PEER, PROXY])(request(PEER, ` ${CLIENT} , ${PROXY} `)),
    ).toBe(CLIENT);
  });

  it('treats equivalent IPv4-mapped IPv6 spellings as the same trusted host', () => {
    const resolveMappedPeer = createSourceAddressResolver([LOOPBACK_MAPPED]);
    expect(createSourceAddressResolver([PEER])(request(LOOPBACK_MAPPED, CLIENT))).toBe(CLIENT);
    expect(resolveMappedPeer(request(PEER, CLIENT))).toBe(CLIENT);
    expect(resolveMappedPeer(request(PEER, CLIENT_MAPPED))).toBe(CLIENT);
  });

  it('returns compressed lowercase IPv6 for equivalent spellings', () => {
    const resolveIpv6 = createSourceAddressResolver([IPV6]);
    expect(resolveIpv6(request(IPV6_EXPANDED, IPV6_CLIENT))).toBe(IPV6_CLIENT);
    expect(resolveIpv6(request('2001:DB8::1', IPV6_EXPANDED))).toBe(IPV6);
  });

  it('does not treat IPv4-compatible mapped forms as dotted IPv4 or as trusted loopback', () => {
    const compatible = '::ffff:0:127.0.0.1';
    const canonical = '::ffff:0:7f00:1';
    // Native isIP accepts this as IPv6; it is not IPv4-mapped ::ffff:<dotted-quad>, so it stays a distinct identity.
    expect(createSourceAddressResolver([PEER])(request(compatible, CLIENT))).toBe(canonical);
    expect(createSourceAddressResolver([PEER])(request(PEER, compatible))).toBe(canonical);
  });

  it('trusts equivalent IPv6 spellings that retain the same zone identifier', () => {
    expect(createSourceAddressResolver([SCOPED_ETH0])(request(SCOPED_ETH0_EXPANDED, CLIENT))).toBe(
      CLIENT,
    );
  });

  it.each([
    ['a mismatched zone', SCOPED_ETH1_EXPANDED, SCOPED_ETH1],
    ['a missing zone', SCOPED_BARE, SCOPED_BARE],
  ])('returns the peer with its own scope when config %eth0 meets %s', (_label, peer, expected) => {
    expect(createSourceAddressResolver([SCOPED_ETH0])(request(peer, CLIENT))).toBe(expected);
  });

  it('does not let an unscoped config trust a scoped peer', () => {
    expect(createSourceAddressResolver([SCOPED_BARE])(request(SCOPED_ETH0, CLIENT))).toBe(
      SCOPED_ETH0,
    );
  });

  it('returns the canonical scoped peer when a matching scoped hop has no X-Forwarded-For', () => {
    expect(createSourceAddressResolver([SCOPED_ETH0])(request(SCOPED_ETH0_EXPANDED))).toBe(
      SCOPED_ETH0,
    );
  });

  it('does not collapse a scoped IPv4-mapped value into unscoped IPv4 trust', () => {
    // Scoped mapped IPv6 must remain a valid IP literal; dotted IPv4 plus %zone is not.
    expect(createSourceAddressResolver([PROXY])(request(MAPPED_SCOPED, CLIENT))).toBe(
      MAPPED_SCOPED_CANONICAL,
    );
  });

  it('falls back to the socket peer when a visited X-Forwarded-For hop carries a zone identifier', () => {
    expect(
      createSourceAddressResolver([PEER, SCOPED_ETH0])(request(PEER, `${CLIENT}, ${SCOPED_ETH0}`)),
    ).toBe(PEER);
  });

  it('ignores a scoped prefix left of the first untrusted client', () => {
    expect(
      createSourceAddressResolver([PEER, PROXY])(
        request(PEER, `${SCOPED_ETH0}, ${CLIENT}, ${PROXY}`),
      ),
    ).toBe(CLIENT);
  });

  it('does not share trust configuration across resolver instances', () => {
    const input = request(PEER, CLIENT);

    expect(createSourceAddressResolver([PEER])(input)).toBe(CLIENT);
    expect(createSourceAddressResolver([])(input)).toBe(PEER);
  });

  it('propagates an invalid socket peer', () => {
    expect(() => createSourceAddressResolver([])(request('not-an-ip'))).toThrow(Error);
  });

  it('propagates invalid trusted proxy configuration', () => {
    expect(() => createSourceAddressResolver(['not-an-ip'])).toThrow(Error);
  });
});

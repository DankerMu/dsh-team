import { BlockList, isIP, SocketAddress } from 'node:net';

const MAPPED_PREFIX = '::ffff:';

interface ParsedAddress {
  readonly canonical: string;
  readonly family: 'ipv4' | 'ipv6';
}

export type SourceAddressResolver = (request: {
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}) => string;

function parseAddress(raw: string): ParsedAddress | undefined {
  const kind = isIP(raw);
  if (kind === 0) {
    return undefined;
  }
  const family = kind === 4 ? 'ipv4' : 'ipv6';
  const address = new SocketAddress({ address: raw, family }).address;
  if (family === 'ipv6' && address.startsWith(MAPPED_PREFIX)) {
    const mapped = address.slice(MAPPED_PREFIX.length);
    if (isIP(mapped) === 4) {
      return { canonical: mapped, family: 'ipv4' };
    }
  }
  return { canonical: address, family };
}

/** Compiles trusted proxy literals into a source-address resolver for auth audits. */
export function createSourceAddressResolver(
  trustedProxies: readonly string[],
): SourceAddressResolver {
  const trusted = new BlockList();
  for (const member of trustedProxies) {
    const parsed = parseAddress(member);
    if (parsed === undefined) {
      throw new Error('Invalid trusted proxy address');
    }
    trusted.addAddress(parsed.canonical, parsed.family);
  }

  return (request) => {
    const peer = parseAddress(request.ip);
    if (peer === undefined) {
      throw new Error('Invalid socket peer address');
    }
    if (!trusted.check(peer.canonical, peer.family)) {
      return peer.canonical;
    }
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.trim() === '') {
      return peer.canonical;
    }
    let cursor = forwarded.length;
    for (;;) {
      const comma = forwarded.lastIndexOf(',', cursor - 1);
      const parsed = parseAddress(forwarded.slice(comma + 1, cursor).trim());
      if (parsed === undefined) {
        return peer.canonical;
      }
      if (!trusted.check(parsed.canonical, parsed.family)) {
        return parsed.canonical;
      }
      if (comma === -1) {
        return parsed.canonical;
      }
      cursor = comma;
    }
  };
}

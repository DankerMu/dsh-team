import { isIP, SocketAddress } from 'node:net';

const MAPPED_PREFIX = '::ffff:';

export type SourceAddressResolver = (request: {
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}) => string;

function parseAddress(raw: string): string | undefined {
  const kind = isIP(raw);
  if (kind === 0) {
    return undefined;
  }
  const family = kind === 4 ? 'ipv4' : 'ipv6';
  const address = new SocketAddress({ address: raw, family }).address;
  const zoneStart = raw.lastIndexOf('%');
  if (zoneStart !== -1) {
    return `${address}${raw.slice(zoneStart)}`;
  }
  if (family === 'ipv6' && address.startsWith(MAPPED_PREFIX)) {
    const mapped = address.slice(MAPPED_PREFIX.length);
    if (isIP(mapped) === 4) {
      return mapped;
    }
  }
  return address;
}

/** Compiles trusted proxy literals into a source-address resolver for auth audits. */
export function createSourceAddressResolver(
  trustedProxies: readonly string[],
): SourceAddressResolver {
  const trusted = new Set<string>();
  for (const member of trustedProxies) {
    const parsed = parseAddress(member);
    if (parsed === undefined) {
      throw new Error('Invalid trusted proxy address');
    }
    trusted.add(parsed);
  }

  return (request) => {
    const peer = parseAddress(request.ip);
    if (peer === undefined) {
      throw new Error('Invalid socket peer address');
    }
    if (!trusted.has(peer)) {
      return peer;
    }
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.trim() === '') {
      return peer;
    }
    let cursor = forwarded.length;
    for (;;) {
      const comma = forwarded.lastIndexOf(',', cursor - 1);
      const token = forwarded.slice(comma + 1, cursor).trim();
      if (token.includes('%')) {
        return peer;
      }
      const parsed = parseAddress(token);
      if (parsed === undefined) {
        return peer;
      }
      if (!trusted.has(parsed)) {
        return parsed;
      }
      if (comma === -1) {
        return parsed;
      }
      cursor = comma;
    }
  };
}

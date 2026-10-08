import { isIP } from 'node:net';

interface Ipv4Range {
  readonly address: number;
  readonly prefix: number;
  readonly start: number;
  readonly end: number;
}

const SUBNET_SIZE = 16;
const POOL_KEY = 'PLATFORM_SUBNET_POOL';

function invalidCidr(field: string): never {
  throw new Error(`${field} must be a valid CIDR`);
}

function parseCidr(raw: string, field: string): Ipv4Range | null {
  const match = /^([^\s/%]+)\/(0|[1-9]\d{0,2})$/.exec(raw);
  const addressText = match?.[1];
  const prefixText = match?.[2];
  if (addressText === undefined || prefixText === undefined) invalidCidr(field);
  const family = isIP(addressText);
  const prefix = Number(prefixText);
  if (family === 0 || prefix > (family === 4 ? 32 : 128)) invalidCidr(field);
  if (family === 6) return null;
  const address = addressText.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  return { address, prefix, start, end: start + size };
}

function parsePool(pool: string): Ipv4Range {
  const range = parseCidr(pool, POOL_KEY);
  if (range === null || range.prefix > 28 || range.address !== range.start) {
    throw new Error(`${POOL_KEY} must be a canonical IPv4 network with prefix /0 through /28`);
  }
  return range;
}

/** Geometric capacity only: Docker occupancy is consulted later, during allocation. */
export function validateSubnetPool(pool: string, maxRunningInstances: number): void {
  const range = parsePool(pool);
  const capacity = (range.end - range.start) / SUBNET_SIZE;
  if (capacity < maxRunningInstances) {
    throw new Error(
      `${POOL_KEY} provides ${String(capacity)} /28 subnets, fewer than maxRunningInstances=${String(maxRunningInstances)}`,
    );
  }
}

/** Select from a fresh Docker IPAM snapshot; this function does not reserve the result. */
export function allocateSubnet(pool: string, occupiedSubnets: readonly string[]): string {
  const range = parsePool(pool);
  const occupied: Ipv4Range[] = [];
  for (const cidr of occupiedSubnets) {
    const blocked = parseCidr(cidr, 'Occupied subnet');
    if (blocked !== null && blocked.end > range.start && blocked.start < range.end) {
      occupied.push(blocked);
    }
  }
  occupied.sort((left, right) => left.start - right.start);
  let candidate = range.start;
  for (const blocked of occupied) {
    if (blocked.end <= candidate) continue;
    if (candidate + SUBNET_SIZE <= blocked.start) break;
    candidate = Math.ceil(blocked.end / SUBNET_SIZE) * SUBNET_SIZE;
    if (candidate >= range.end) break;
  }
  if (candidate >= range.end) {
    throw new Error('Subnet pool exhausted: no free /28 subnet');
  }
  const address = [24, 16, 8, 0].map((bits) => Math.floor(candidate / 2 ** bits) % 256).join('.');
  return `${address}/28`;
}

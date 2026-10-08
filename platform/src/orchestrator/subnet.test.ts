import { describe, expect, it } from 'vitest';
import { allocateSubnet, validateSubnetPool } from './index.ts';

const POOL = '172.30.0.0/26';

const INVALID_POOLS = [
  '',
  ' 172.30.0.0/16',
  '172.30.0.0/16 ',
  '172.30.0.1/16',
  '172.030.0.0/16',
  '172.30.0/16',
  '2886729728/16',
  '256.0.0.0/16',
  '172.30.0.0',
  '172.30.0.0/+16',
  '172.30.0.0/016',
  '172.30.0.0/16.0',
  '172.30.0.0/-1',
  '172.30.0.0/29',
  '172.30.0.0/33',
  '::/0',
];

describe('allocateSubnet', () => {
  it('allocates successive snapshots until exhaustion and reuses a released subnet', () => {
    const occupied: string[] = [];

    for (const expected of [
      '172.30.0.0/28',
      '172.30.0.16/28',
      '172.30.0.32/28',
      '172.30.0.48/28',
    ]) {
      const selected = allocateSubnet(POOL, occupied);
      expect(selected).toBe(expected);
      occupied.push(selected);
    }
    expect(() => allocateSubnet(POOL, occupied)).toThrow(/Subnet pool exhausted/);
    occupied.splice(1, 1);
    expect(allocateSubnet(POOL, occupied)).toBe('172.30.0.16/28');
  });

  it('uses only the supplied immutable snapshot, without hidden reservations', () => {
    const occupied = Object.freeze(['172.30.0.48/28', '172.30.0.0/28']);

    expect(allocateSubnet(POOL, occupied)).toBe('172.30.0.16/28');
    expect(allocateSubnet(POOL, occupied)).toBe('172.30.0.16/28');
    expect(occupied).toEqual(['172.30.0.48/28', '172.30.0.0/28']);
  });

  it.each([
    ['0.0.0.0/0', [], '0.0.0.0/28'],
    ['0.0.0.0/0', ['0.0.0.0/1'], '128.0.0.0/28'],
    ['255.255.255.224/27', ['255.255.255.224/28'], '255.255.255.240/28'],
    ['255.255.255.240/28', [], '255.255.255.240/28'],
    ['200.0.0.0/27', ['200.0.0.0/28'], '200.0.0.16/28'],
  ] as const)(
    'selects the first free subnet of %s without signed overflow or enumerating the pool',
    (pool, occupied, expected) => {
      expect(allocateSubnet(pool, occupied)).toBe(expected);
    },
  );

  it.each([
    ['172.30.0.0/28', ['172.30.0.15/32']],
    ['255.255.255.240/28', ['255.255.255.255/32']],
    ['0.0.0.0/0', ['0.0.0.1/0']],
    [POOL, ['172.30.0.63/24']],
  ] as const)('reports exhaustion for %s without wrapping or falling back', (pool, occupied) => {
    expect(() => allocateSubnet(pool, occupied)).toThrow(/Subnet pool exhausted/);
  });

  it.each([
    [['172.30.0.7/27'], '172.30.0.32/28'],
    [['172.30.0.9/29'], '172.30.0.16/28'],
    [['172.30.0.0/28', '172.30.0.16/32'], '172.30.0.32/28'],
    [['172.30.0.33/32', '172.30.0.0/28', '172.30.0.19/30', '172.30.0.0/28'], '172.30.0.48/28'],
    [['172.29.255.240/28', '172.30.0.64/28', '192.168.0.0/16'], '172.30.0.0/28'],
    [['::/0', '2001:db8::1234/64', '::ffff:172.30.0.0/128'], '172.30.0.0/28'],
  ] as const)('excludes overlapping ranges in snapshot %j', (occupied, expected) => {
    expect(allocateSubnet(POOL, occupied)).toBe(expected);
  });

  it.each(INVALID_POOLS)(
    'rejects noncanonical or unusable pool %j naming its config key',
    (pool) => {
      expect(() => allocateSubnet(pool, [])).toThrow(/PLATFORM_SUBNET_POOL/);
    },
  );

  it.each([
    '',
    'garbage',
    '172.30.0.0',
    '172.30.0.0/33',
    '172.030.0.0/28',
    '172.30.0.0/028',
    '172.30.0.0/+28',
    ' 172.30.0.0/28',
    '172.30.0.0/28 ',
    '2001:db8::/129',
    '2001:db8::/064',
    '2001:db8::/x',
    '2001:zzzz::/64',
    'fe80::1%eth0/64',
  ])('rejects malformed occupied CIDR %j even after a pool-covering entry', (cidr) => {
    expect(() => allocateSubnet(POOL, ['172.30.0.0/24', cidr])).toThrow(/Occupied subnet/);
  });
});

describe('validateSubnetPool', () => {
  it.each([
    ['172.30.0.0/28', 1],
    ['172.30.0.0/27', 2],
    ['172.30.0.0/16', 4096],
    ['0.0.0.0/0', 268435456],
  ] as const)(
    'accepts the exact capacity of %s and rejects one additional running instance',
    (pool, capacity) => {
      expect(() => {
        validateSubnetPool(pool, capacity);
      }).not.toThrow();
      expect(() => {
        validateSubnetPool(pool, capacity + 1);
      }).toThrow(/PLATFORM_SUBNET_POOL.*maxRunningInstances/);
    },
  );

  it.each(INVALID_POOLS)('rejects invalid startup pool %j', (pool) => {
    expect(() => {
      validateSubnetPool(pool, 1);
    }).toThrow(/PLATFORM_SUBNET_POOL/);
  });
});

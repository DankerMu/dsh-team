import { expect, it } from 'vitest';
import { normalizeInspectMounts } from './container-start-docker-fixture.ts';

const HOME = Object.freeze({
  Type: 'volume',
  Name: 'dsh-team-home-abcdefghijkl',
  Source: '/var/lib/docker/volumes/dsh-team-home-abcdefghijkl/_data',
  Destination: '/data/home',
  Driver: 'local',
  Mode: 'z',
  RW: true,
  Propagation: '',
});
const WORK = Object.freeze({
  Type: 'volume',
  Name: 'dsh-team-work-abcdefghijkl',
  Source: '/var/lib/docker/volumes/dsh-team-work-abcdefghijkl/_data',
  Destination: '/data/work',
  Driver: 'local',
  Mode: 'z',
  RW: true,
  Propagation: '',
});
const OVERLAY = Object.freeze({
  Type: 'bind',
  Source: '/owned/managed/abcdefghijkl.patch.yml',
  Destination: '/managed/patch.yml',
  Mode: 'ro',
  RW: false,
  Propagation: 'rprivate',
});
const IDENTITY = {
  Id: 'b'.repeat(64),
  Name: '/dsh-team-u-abcdefghijkl',
  Image: `sha256:${'a'.repeat(64)}`,
  Config: { User: '1001', Hostname: 'u-abcdefghijkl', Labels: { 'dsh-team.user': 'abcdefghijkl' } },
  State: { Running: true, Pid: 1234, StartedAt: '2026-10-08T10:00:00Z' },
  HostConfig: { NetworkMode: 'e'.repeat(64), Privileged: false },
  NetworkSettings: {
    Networks: {
      'dsh-team-net-abcdefghijkl': {
        NetworkID: 'e'.repeat(64),
        EndpointID: 'c'.repeat(64),
        IPAddress: '172.30.0.2',
        Aliases: ['u-abcdefghijkl'],
      },
    },
    Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49173' }] },
  },
};
// Independent literal ordering by destination; every record retains all supplied Docker attributes.
const EXPECTED = { ...IDENTITY, Mounts: [HOME, WORK, OVERLAY] };

it('identical complete mount inventories compare equal when Docker changes their order without mutating the snapshot', () => {
  const observed = { ...IDENTITY, Mounts: Object.freeze([OVERLAY, HOME, WORK]) };

  const normalized = normalizeInspectMounts(observed);

  expect(normalized).toEqual(EXPECTED);
  expect(observed.Mounts).toEqual([OVERLAY, HOME, WORK]);
});

it.each([
  ['changed source', [{ ...HOME, Source: '/var/lib/docker/volumes/foreign/_data' }, WORK, OVERLAY]],
  ['changed readonly flag', [HOME, WORK, { ...OVERLAY, RW: true }]],
  ['missing member', [HOME, OVERLAY]],
] as const)(
  'sibling preservation rejects %s despite incidental mount ordering',
  (_case, mounts) => {
    const observed = { ...IDENTITY, Mounts: mounts };

    const normalized = normalizeInspectMounts(observed);

    expect(normalized).not.toEqual(EXPECTED);
  },
);

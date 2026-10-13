import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { admitVpsIdentity } from './ci-vps-identity.ts';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = 1_800_000_000;
  const approved = {
    repository: 'DankerMu/dsh-team',
    repositoryId: '123',
    ownerId: '456',
    actorId: '456',
    sha: 'a'.repeat(40),
    workflowSha: 'a'.repeat(40),
    ref: 'refs/heads/codex/model-proof',
    workflowRef: 'DankerMu/dsh-team/.github/workflows/model.yml@refs/heads/codex/model-proof',
    audience: 'dsh-team-vps-test-invocation',
    expiresAt: now + 600,
  };
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: approved.audience,
    repository: approved.repository,
    repository_id: approved.repositoryId,
    repository_owner_id: approved.ownerId,
    actor_id: approved.actorId,
    sha: approved.sha,
    workflow_sha: approved.workflowSha,
    ref: approved.ref,
    workflow_ref: approved.workflowRef,
    event_name: 'push',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    run_id: '789',
    run_attempt: '1',
  };
  const token = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const encoded = [
      { alg: 'RS256', kid: 'owned-rsa', ...header },
      { ...claims, ...overrides },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.');
    return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
  };
  const keys = [
    { ...publicKey.export({ format: 'jwk' }), kid: 'owned-rsa', alg: 'RS256', use: 'sig' },
  ];
  return { now, approved, token, keys };
}

it('admits the actual signed approved workflow and source identity', () => {
  const f = fixture();
  expect(admitVpsIdentity(f.token(), f.approved, f.keys, f.now)).toEqual({
    runId: '789',
    runAttempt: '1',
  });
});

it.each([
  ['iss', 'https://untrusted.invalid'],
  ['aud', 'another-invocation'],
  ['repository', 'attacker/fork'],
  ['repository_id', '999'],
  ['repository_owner_id', '999'],
  ['actor_id', '999'],
  ['sha', 'b'.repeat(40)],
  ['workflow_sha', 'b'.repeat(40)],
  ['ref', 'refs/pull/1/merge'],
  ['workflow_ref', 'DankerMu/dsh-team/.github/workflows/other.yml@refs/heads/main'],
  ['event_name', 'pull_request'],
  ['exp', 1_800_000_000],
  ['iat', 1_800_000_001],
  ['nbf', 1_800_000_001],
  ['exp', '1800000300'],
  ['run_id', '../foreign'],
  ['run_attempt', '0'],
])('rejects a genuinely signed but unapproved %s', (field, value) => {
  const f = fixture();
  const token = f.token({ [field]: value });
  expect(() => admitVpsIdentity(token, f.approved, f.keys, f.now)).toThrow();
});

it('rejects expired operator approval even when the identity is still current', () => {
  const f = fixture();
  expect(() =>
    admitVpsIdentity(f.token(), { ...f.approved, expiresAt: f.now }, f.keys, f.now),
  ).toThrow();
});

it('rejects forged signatures without leaking the bearer in diagnostics', () => {
  const f = fixture();
  const valid = f.token();
  const signatureStart = valid.lastIndexOf('.') + 1;
  const forged = valid.slice(0, signatureStart) + Buffer.alloc(256).toString('base64url');
  let message = '';
  try {
    admitVpsIdentity(forged, f.approved, f.keys, f.now);
  } catch (error) {
    if (error instanceof Error) message = error.message;
  }
  expect(message.includes(forged)).toBe(false);
  expect(() => admitVpsIdentity(forged, f.approved, f.keys, f.now)).toThrow();
  expect(admitVpsIdentity(valid, f.approved, f.keys, f.now)).toEqual({
    runId: '789',
    runAttempt: '1',
  });
});

it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: 'foreign' }, { crit: ['unknown'] }])(
  'rejects unsupported or unknown signing headers %j',
  (header) => {
    const f = fixture();
    expect(() => admitVpsIdentity(f.token({}, header), f.approved, f.keys, f.now)).toThrow();
  },
);

it('rejects ambiguous signing keys and oversized identity envelopes', () => {
  const f = fixture();
  expect(() => admitVpsIdentity(f.token(), f.approved, [...f.keys, ...f.keys], f.now)).toThrow();
  expect(() => admitVpsIdentity('x'.repeat(16_385), f.approved, f.keys, f.now)).toThrow();
});

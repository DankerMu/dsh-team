import { createPublicKey, verify } from 'node:crypto';

export interface VpsApproval {
  readonly repository: string;
  readonly repositoryId: string;
  readonly ownerId: string;
  readonly actorId: string;
  readonly sha: string;
  readonly workflowSha: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly audience: string;
  readonly expiresAt: number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid CI identity object');
  // The object boundary has been checked; individual fields remain unknown.
  return value as Record<string, unknown>;
}

function decode(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid CI identity encoding');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('Noncanonical CI identity');
  return object(JSON.parse(bytes.toString('utf8')));
}

function identityClaims(claims: Record<string, unknown>, approval: VpsApproval, now: number) {
  const expected = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: approval.audience,
    repository: approval.repository,
    repository_id: approval.repositoryId,
    repository_owner_id: approval.ownerId,
    actor_id: approval.actorId,
    sha: approval.sha,
    workflow_sha: approval.workflowSha,
    ref: approval.ref,
    workflow_ref: approval.workflowRef,
    event_name: 'push',
  };
  if (Object.entries(expected).some(([name, value]) => claims[name] !== value))
    throw new Error('Unapproved CI identity');
  for (const name of ['iat', 'nbf', 'exp']) {
    if (!Number.isSafeInteger(claims[name])) throw new Error('Invalid CI identity lifetime');
  }
  if (
    typeof claims.iat !== 'number' ||
    typeof claims.nbf !== 'number' ||
    typeof claims.exp !== 'number' ||
    claims.iat > now ||
    claims.nbf > now ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    !Number.isSafeInteger(approval.expiresAt) ||
    approval.expiresAt <= now
  )
    throw new Error('Expired CI identity');
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value))
      throw new Error('Invalid CI run identity');
    return value;
  };
  return { runId: id(claims.run_id), runAttempt: id(claims.run_attempt) };
}

function signingKey(keys: readonly unknown[], kid: string) {
  const matches = keys.map(object).filter((key) => key.kid === kid);
  const key = matches[0];
  if (
    matches.length !== 1 ||
    key?.kty !== 'RSA' ||
    key.use !== 'sig' ||
    key.alg !== 'RS256' ||
    typeof key.n !== 'string' ||
    typeof key.e !== 'string'
  )
    throw new Error('Untrusted CI signing key');
  return createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
}

/** Authenticate before checkout/install: caller supplies only operator-approved state and trusted JWKS. */
export function admitVpsIdentity(
  token: string,
  approval: VpsApproval,
  keys: readonly unknown[],
  now = Math.floor(Date.now() / 1000),
): { runId: string; runAttempt: string } {
  try {
    if (token.length > 16_384) throw new Error('Oversized CI identity');
    const parts = token.split('.');
    const [headerPart, payloadPart, signaturePart] = parts;
    if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart)
      throw new Error('Invalid CI identity envelope');
    const header = decode(headerPart);
    const claims = decode(payloadPart);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined)
      throw new Error('Unsupported CI identity algorithm');
    const publicKey = signingKey(keys, header.kid);
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        publicKey,
        Buffer.from(signaturePart, 'base64url'),
      )
    )
      throw new Error('Invalid CI signature');
    return identityClaims(claims, approval, now);
  } catch {
    // Parsing/crypto diagnostics may contain bearer material; expose only this fixed rejection.
    throw new Error('CI invocation identity rejected');
  }
}

import { describe, expect, it } from 'vitest';
import { verifyDockerEvidence } from './docker-evidence.ts';
import type { DockerEvidenceInput, DockerStatusEvidence } from './docker-evidence.ts';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const OWNER_SUCCESS = {
  context: 'dsh-team/docker',
  state: 'success',
  creator: { login: 'DankerMu' },
} satisfies DockerStatusEvidence;

function pullRequestEvidence(
  statuses: readonly DockerStatusEvidence[],
  sha = HEAD_SHA,
): DockerEvidenceInput {
  return {
    target: { kind: 'pull-request', headSha: HEAD_SHA },
    evidence: { sha, statuses },
  };
}

describe('trusted Docker evidence', () => {
  it('accepts the repository owner latest successful Docker status on the exact PR head', () => {
    const input = pullRequestEvidence([
      { context: 'unrelated/check', state: 'failure', creator: { login: 'another-user' } },
      OWNER_SUCCESS,
    ]);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(true);
  });

  it('rejects absent evidence', () => {
    const input: DockerEvidenceInput = {
      target: { kind: 'pull-request', headSha: HEAD_SHA },
      evidence: null,
    };

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('rejects evidence without the Docker status context', () => {
    const input = pullRequestEvidence([{ ...OWNER_SUCCESS, context: 'unrelated/check' }]);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it.each(['error', 'failure', 'pending'] as const)(
    'rejects a latest %s Docker status',
    (state) => {
      const input = pullRequestEvidence([{ ...OWNER_SUCCESS, state }]);

      const accepted = verifyDockerEvidence(input);

      expect(accepted).toBe(false);
    },
  );

  it('rejects successful evidence authored by anyone other than DankerMu', () => {
    const input = pullRequestEvidence([{ ...OWNER_SUCCESS, creator: { login: 'another-user' } }]);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('rejects owner success on another SHA rather than substituting it for PR head evidence', () => {
    const input = pullRequestEvidence([OWNER_SUCCESS], OTHER_SHA);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('rejects a newer failure rather than reviving an older owner success', () => {
    const input = pullRequestEvidence([{ ...OWNER_SUCCESS, state: 'failure' }, OWNER_SUCCESS]);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('rejects a newer untrusted success rather than selecting an older trusted author', () => {
    const input = pullRequestEvidence([
      { ...OWNER_SUCCESS, creator: { login: 'another-user' } },
      OWNER_SUCCESS,
    ]);

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('accepts squash evidence only for an associated merged PR with exact merge SHA and equal tree', () => {
    const input: DockerEvidenceInput = {
      target: {
        kind: 'main-push',
        commitSha: OTHER_SHA,
        treeSha: '3333333333333333333333333333333333333333',
        associatedPullRequests: [
          {
            merged: true,
            mergeCommitSha: OTHER_SHA,
            headSha: HEAD_SHA,
            headTreeSha: '3333333333333333333333333333333333333333',
          },
        ],
      },
      evidence: { sha: HEAD_SHA, statuses: [OWNER_SUCCESS] },
    };

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(true);
  });

  it.each([
    {
      label: 'unmerged PR',
      merged: false,
      mergeCommitSha: OTHER_SHA,
      headSha: HEAD_SHA,
      headTreeSha: OTHER_SHA,
    },
    {
      label: 'another merge commit',
      merged: true,
      mergeCommitSha: HEAD_SHA,
      headSha: HEAD_SHA,
      headTreeSha: OTHER_SHA,
    },
    {
      label: 'different tree',
      merged: true,
      mergeCommitSha: OTHER_SHA,
      headSha: HEAD_SHA,
      headTreeSha: HEAD_SHA,
    },
    {
      label: 'replayed evidence from another head',
      merged: true,
      mergeCommitSha: OTHER_SHA,
      headSha: OTHER_SHA,
      headTreeSha: OTHER_SHA,
    },
  ])('rejects squash evidence for $label', (pr) => {
    const input: DockerEvidenceInput = {
      target: {
        kind: 'main-push',
        commitSha: OTHER_SHA,
        treeSha: OTHER_SHA,
        associatedPullRequests: [pr],
      },
      evidence: { sha: HEAD_SHA, statuses: [OWNER_SUCCESS] },
    };

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });

  it('rejects squash evidence without a merged PR association even if owner evidence exists', () => {
    const input: DockerEvidenceInput = {
      target: {
        kind: 'main-push',
        commitSha: OTHER_SHA,
        treeSha: OTHER_SHA,
        associatedPullRequests: [],
      },
      evidence: { sha: HEAD_SHA, statuses: [OWNER_SUCCESS] },
    };

    const accepted = verifyDockerEvidence(input);

    expect(accepted).toBe(false);
  });
});

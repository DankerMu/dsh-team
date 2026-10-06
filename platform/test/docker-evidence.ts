/** Selected fields from GitHub responses after validation at the API boundary. */
export interface DockerStatusEvidence {
  readonly context: string;
  readonly state: 'error' | 'failure' | 'pending' | 'success';
  readonly creator: { readonly login: string } | null;
}

export interface DockerCommitEvidence {
  /** Exact commit queried by the API adapter; status entries themselves have no SHA. */
  readonly sha: string;
  /** Complete status list in GitHub REST's newest-first order, across all authors. */
  readonly statuses: readonly DockerStatusEvidence[];
}

interface DockerAssociatedPullRequest {
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  readonly headTreeSha: string;
}

type DockerEvidenceTarget =
  | { readonly kind: 'pull-request'; readonly headSha: string }
  | {
      readonly kind: 'main-push';
      readonly commitSha: string;
      readonly treeSha: string;
      readonly associatedPullRequests: readonly DockerAssociatedPullRequest[];
    };

export interface DockerEvidenceInput {
  readonly target: DockerEvidenceTarget;
  readonly evidence: DockerCommitEvidence | null;
}

export function verifyDockerEvidence(input: DockerEvidenceInput): boolean {
  const { target, evidence } = input;
  if (evidence === null) {
    return false;
  }
  if (target.kind === 'pull-request') {
    if (evidence.sha !== target.headSha) {
      return false;
    }
  } else if (
    !target.associatedPullRequests.some(
      (pr) =>
        pr.merged &&
        pr.mergeCommitSha === target.commitSha &&
        pr.headSha === evidence.sha &&
        pr.headTreeSha === target.treeSha,
    )
  ) {
    return false;
  }
  const latest = evidence.statuses.find((status) => status.context === 'dsh-team/docker');
  return latest?.state === 'success' && latest.creator?.login === 'DankerMu';
}

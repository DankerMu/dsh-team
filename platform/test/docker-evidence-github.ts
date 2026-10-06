import { verifyDockerEvidence } from './docker-evidence.ts';
import type { DockerCommitEvidence, DockerStatusEvidence } from './docker-evidence.ts';

/** External read-only API boundary. Paginated results are gh --paginate --slurp pages. */
export type GitHubRead = (endpoint: string, paginate: boolean) => unknown;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a GitHub object');
  }
  // The object check excludes null and arrays; dynamic JSON keys remain unknown.
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Expected a nonempty GitHub string');
  }
  return value;
}

function sha(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{40}$/.test(result)) {
    throw new Error('Expected a full GitHub commit or tree SHA');
  }
  return result;
}

function pages(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Expected paginated GitHub arrays');
  }
  const entries: unknown[] = [];
  const allPages: readonly unknown[] = value;
  for (const page of allPages) {
    if (!Array.isArray(page)) {
      throw new Error('Expected a GitHub array page');
    }
    const values: readonly unknown[] = page;
    entries.push(...values);
  }
  return entries;
}

function status(value: unknown): DockerStatusEvidence {
  const item = record(value);
  const state = item.state;
  if (state !== 'success' && state !== 'error' && state !== 'failure' && state !== 'pending') {
    throw new Error('Expected a GitHub commit status state');
  }
  return {
    context: text(item.context),
    state,
    creator: item.creator === null ? null : { login: text(record(item.creator).login) },
  };
}

function commitTree(api: GitHubRead, repo: string, commitSha: string): string {
  const commit = record(api(`repos/${repo}/commits/${commitSha}`, false));
  if (sha(commit.sha) !== commitSha) {
    throw new Error('GitHub returned a different commit');
  }
  return sha(record(record(commit.commit).tree).sha);
}

function evidence(api: GitHubRead, repo: string, headSha: string): DockerCommitEvidence {
  const response = api(`repos/${repo}/commits/${headSha}/statuses?per_page=100`, true);
  return { sha: headSha, statuses: pages(response).map(status) };
}

export interface DockerEvidenceAcceptance {
  readonly mode: 'direct-head' | 'tree-equivalent';
  readonly headSha: string;
}

export function checkGitHubDockerEvidence(
  eventName: string,
  repository: string,
  eventValue: unknown,
  api: GitHubRead,
): DockerEvidenceAcceptance {
  if (!/^DankerMu\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Expected a repository owned by DankerMu');
  }
  const event = record(eventValue);
  if (text(record(event.repository).full_name) !== repository) {
    throw new Error('GitHub event repository does not match the requested repository');
  }
  if (eventName === 'pull_request') {
    const headSha = sha(record(record(event.pull_request).head).sha);
    if (
      verifyDockerEvidence({
        target: { kind: 'pull-request', headSha },
        evidence: evidence(api, repository, headSha),
      })
    ) {
      return { mode: 'direct-head', headSha };
    }
    throw new Error('Missing trusted latest successful Docker evidence on the exact PR head');
  }
  if (eventName !== 'push' || event.ref !== 'refs/heads/main') {
    throw new Error('Docker evidence supports only pull_request or main push events');
  }
  return checkMainPush(api, repository, sha(event.after));
}

function checkMainPush(
  api: GitHubRead,
  repository: string,
  commitSha: string,
): DockerEvidenceAcceptance {
  const treeSha = commitTree(api, repository, commitSha);
  const associated = pages(
    api(`repos/${repository}/commits/${commitSha}/pulls?per_page=100`, true),
  );
  for (const value of associated) {
    const number = record(value).number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
      throw new Error('Expected a positive GitHub PR number');
    }
    const pr = record(api(`repos/${repository}/pulls/${String(number)}`, false));
    if (typeof pr.merged !== 'boolean') {
      throw new Error('Expected a GitHub PR merged flag');
    }
    const mergeCommitSha = pr.merge_commit_sha === null ? null : sha(pr.merge_commit_sha);
    if (text(record(record(pr.base).repo).full_name) !== repository) {
      throw new Error('Associated PR belongs to a different repository');
    }
    const headSha = sha(record(pr.head).sha);
    if (!pr.merged || mergeCommitSha !== commitSha) {
      continue;
    }
    const headTreeSha = commitTree(api, repository, headSha);
    if (treeSha !== headTreeSha) {
      continue;
    }
    if (
      verifyDockerEvidence({
        target: {
          kind: 'main-push',
          commitSha,
          treeSha,
          associatedPullRequests: [{ merged: pr.merged, mergeCommitSha, headSha, headTreeSha }],
        },
        evidence: evidence(api, repository, headSha),
      })
    ) {
      return { mode: 'tree-equivalent', headSha };
    }
  }
  throw new Error('Missing merged PR with exact merge SHA, equal tree and trusted head evidence');
}

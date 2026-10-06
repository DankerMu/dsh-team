import { describe, expect, it } from 'vitest';
import { checkGitHubDockerEvidence } from './docker-evidence-github.ts';
import type { GitHubRead } from './docker-evidence-github.ts';

const REPO = 'DankerMu/dsh-team';
const HEAD = '1111111111111111111111111111111111111111';
const PUSH = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';
const SUCCESS = { context: 'dsh-team/docker', state: 'success', creator: { login: 'DankerMu' } };
const PR_EVENT = { repository: { full_name: REPO }, pull_request: { head: { sha: HEAD } } };
const PUSH_EVENT = { repository: { full_name: REPO }, ref: 'refs/heads/main', after: PUSH };

function apiFixture(overrides: Readonly<Record<string, unknown>> = {}): GitHubRead {
  const responses: Readonly<Record<string, unknown>> = {
    [`repos/${REPO}/commits/${HEAD}/statuses?per_page=100`]: [[SUCCESS]],
    [`repos/${REPO}/commits/${HEAD}`]: { sha: HEAD, commit: { tree: { sha: TREE } } },
    [`repos/${REPO}/commits/${PUSH}`]: { sha: PUSH, commit: { tree: { sha: TREE } } },
    [`repos/${REPO}/commits/${PUSH}/pulls?per_page=100`]: [[{ number: 25 }]],
    [`repos/${REPO}/pulls/25`]: {
      merged: true,
      merge_commit_sha: PUSH,
      head: { sha: HEAD },
      base: { repo: { full_name: REPO } },
    },
    ...overrides,
  };
  return (endpoint) => {
    if (!(endpoint in responses)) throw new Error(`Unexpected GitHub read ${endpoint}`);
    return responses[endpoint];
  };
}

describe('GitHub Docker evidence boundary', () => {
  it('accepts direct head evidence beyond the first status page without using synthetic merge SHA', () => {
    const unrelated = Array.from({ length: 100 }, () => ({ ...SUCCESS, context: 'other/check' }));
    const api = apiFixture({
      [`repos/${REPO}/commits/${HEAD}/statuses?per_page=100`]: [unrelated, [SUCCESS]],
    });
    const event = { ...PR_EVENT, after: PUSH };

    const accepted = checkGitHubDockerEvidence('pull_request', REPO, event, api);

    expect(accepted).toEqual({ mode: 'direct-head', headSha: HEAD });
  });

  it('reports tree-equivalent reuse rather than direct execution of a squash commit', () => {
    const api = apiFixture();

    const accepted = checkGitHubDockerEvidence('push', REPO, PUSH_EVENT, api);

    expect(accepted).toEqual({ mode: 'tree-equivalent', headSha: HEAD });
  });

  it('finds an exact merged association on later pages rather than requiring the first PR', () => {
    const api = apiFixture({
      [`repos/${REPO}/commits/${PUSH}/pulls?per_page=100`]: [[], [{ number: 25 }]],
    });

    const accepted = checkGitHubDockerEvidence('push', REPO, PUSH_EVENT, api);

    expect(accepted).toEqual({ mode: 'tree-equivalent', headSha: HEAD });
  });

  it.each([
    {
      label: 'missing association',
      endpoint: `repos/${REPO}/commits/${PUSH}/pulls?per_page=100`,
      value: [[]],
    },
    {
      label: 'unequal tree',
      endpoint: `repos/${REPO}/commits/${HEAD}`,
      value: { sha: HEAD, commit: { tree: { sha: PUSH } } },
    },
    {
      label: 'unmerged association',
      endpoint: `repos/${REPO}/pulls/25`,
      value: {
        merged: false,
        merge_commit_sha: PUSH,
        head: { sha: HEAD },
        base: { repo: { full_name: REPO } },
      },
    },
    {
      label: 'another merge SHA',
      endpoint: `repos/${REPO}/pulls/25`,
      value: {
        merged: true,
        merge_commit_sha: HEAD,
        head: { sha: HEAD },
        base: { repo: { full_name: REPO } },
      },
    },
  ])('rejects squash reuse with $label', ({ endpoint, value }) => {
    const api = apiFixture({ [endpoint]: value });

    const verify = () => checkGitHubDockerEvidence('push', REPO, PUSH_EVENT, api);

    expect(verify).toThrow('Missing merged PR');
  });

  it.each([
    { label: 'no statuses', value: [[]] },
    { label: 'untrusted publisher', value: [[{ ...SUCCESS, creator: { login: 'another-user' } }]] },
    { label: 'missing publisher', value: [[{ ...SUCCESS, creator: null }]] },
    { label: 'newer failure', value: [[{ ...SUCCESS, state: 'failure' }, SUCCESS]] },
  ])('rejects exact-head evidence with $label', ({ value }) => {
    const api = apiFixture({ [`repos/${REPO}/commits/${HEAD}/statuses?per_page=100`]: value });

    const verify = () => checkGitHubDockerEvidence('pull_request', REPO, PR_EVENT, api);

    expect(verify).toThrow('Missing trusted latest successful Docker evidence');
  });

  it.each([
    null,
    {},
    [SUCCESS],
    [[{ ...SUCCESS, state: 'unknown' }]],
    [[{ ...SUCCESS, creator: {} }]],
  ])('rejects malformed GitHub status response %j', (value) => {
    const api = apiFixture({ [`repos/${REPO}/commits/${HEAD}/statuses?per_page=100`]: value });

    const verify = () => checkGitHubDockerEvidence('pull_request', REPO, PR_EVENT, api);

    expect(verify).toThrow('Expected');
  });

  it.each([
    { name: 'pull_request', event: { repository: { full_name: REPO } } },
    { name: 'pull_request', event: { ...PR_EVENT, pull_request: { head: { sha: 'short' } } } },
    { name: 'pull_request', event: { ...PR_EVENT, repository: { full_name: 'another/repo' } } },
    { name: 'push', event: { ...PUSH_EVENT, ref: 'refs/heads/feature' } },
    { name: 'push', event: { ...PUSH_EVENT, after: undefined } },
    { name: 'pull_request_target', event: PR_EVENT },
  ])('rejects unsupported or incomplete event $name/$event', ({ name, event }) => {
    const api = apiFixture();

    const verify = () => checkGitHubDockerEvidence(name, REPO, event, api);

    expect(verify).toThrow();
  });

  it('rejects another commit returned for the pushed SHA', () => {
    const api = apiFixture({
      [`repos/${REPO}/commits/${PUSH}`]: { sha: HEAD, commit: { tree: { sha: TREE } } },
    });

    const verify = () => checkGitHubDockerEvidence('push', REPO, PUSH_EVENT, api);

    expect(verify).toThrow('GitHub returned a different commit');
  });

  it('fails closed when the GitHub read fails rather than synthesizing evidence', () => {
    const api: GitHubRead = () => {
      throw new Error('GitHub API unavailable');
    };

    const verify = () => checkGitHubDockerEvidence('pull_request', REPO, PR_EVENT, api);

    expect(verify).toThrow('GitHub API unavailable');
  });
});

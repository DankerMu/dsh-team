import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkGitHubDockerEvidence } from './docker-evidence-github.ts';

try {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !repository || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required');
  }
  const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  const accepted = checkGitHubDockerEvidence(eventName, repository, event, (endpoint, paginate) => {
    const result = spawnSync(
      'gh',
      ['api', '--method', 'GET', endpoint, ...(paginate ? ['--paginate', '--slurp'] : [])],
      {
        encoding: 'utf8',
        // API pagination is bounded by elapsed time/output, never truncated to a first page.
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `GitHub read failed for ${endpoint}: ${result.error?.message ?? ''}\n${result.stderr}`,
      );
    }
    const response: unknown = JSON.parse(result.stdout);
    return response;
  });
  process.stdout.write(`Docker evidence accepted: ${accepted.mode} head=${accepted.headSha}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Docker evidence verification failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

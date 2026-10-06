import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('./verify-docker-evidence.ts', import.meta.url));
const HEAD = '1111111111111111111111111111111111111111';
const SUCCESS = { context: 'dsh-team/docker', state: 'success', creator: { login: 'DankerMu' } };

function runGate(
  options: {
    event?: unknown;
    response?: unknown;
    missingEnvironment?: boolean;
    failGitHub?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-team-docker-evidence-'));
  try {
    const eventPath = join(directory, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify(
        options.event ?? {
          repository: { full_name: 'DankerMu/dsh-team' },
          pull_request: { head: { sha: HEAD } },
        },
      ),
    );
    const response = JSON.stringify(options.response ?? [[SUCCESS]]);
    // Controlled external gh executable, not a mock of the verifier or its policy.
    const body =
      options.failGitHub === true
        ? "printf '%s\\n' 'GitHub API unavailable' >&2\nexit 1\n"
        : `printf '%s' '${response.replaceAll("'", "'\\''")}'\n`;
    writeFileSync(join(directory, 'gh'), `#!/bin/sh\n${body}`, { mode: 0o700 });
    return spawnSync(process.execPath, [entrypoint], {
      cwd: directory,
      env:
        options.missingEnvironment === true
          ? {}
          : {
              PATH: directory,
              GITHUB_EVENT_NAME: 'pull_request',
              GITHUB_REPOSITORY: 'DankerMu/dsh-team',
              GITHUB_EVENT_PATH: eventPath,
            },
      encoding: 'utf8',
      // Child API work is fixture-only; a hung executable must not stall local integration.
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe('executable Docker evidence gate', () => {
  it('exits zero only after accepting exact-head owner evidence and reports its binding', () => {
    const options = {};

    const result = runGate(options);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`Docker evidence accepted: direct-head head=${HEAD}\n`);
  });

  it('exits nonzero with a required-context diagnostic when CI environment is missing', () => {
    const options = { missingEnvironment: true };

    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'GITHUB_EVENT_NAME, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required',
    );
  });

  it('exits nonzero rather than authorizing an event missing the PR head', () => {
    const options = { event: { repository: { full_name: 'DankerMu/dsh-team' } } };

    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Expected a GitHub object');
  });

  it('exits nonzero and preserves the failed external GitHub read diagnostic', () => {
    const options = { failGitHub: true };

    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GitHub read failed');
    expect(result.stderr).toContain('GitHub API unavailable');
  });

  it('exits nonzero on malformed API data instead of treating an invalid response as proof', () => {
    const options = { response: [[{ ...SUCCESS, state: 'invalid' }]] };

    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Expected a GitHub commit status state');
  });

  it('exits nonzero for missing evidence without publishing success output', () => {
    const options = { response: [[]] };

    const result = runGate(options);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Missing trusted latest successful Docker evidence');
  });
});

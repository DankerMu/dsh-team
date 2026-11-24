import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { caseSpawn } from './trusted-docker-fixture.ts';

const entrypoint = fileURLToPath(new URL('./verify-docker-evidence.ts', import.meta.url));
const HEAD = '1111111111111111111111111111111111111111';
const SUCCESS = { context: 'dsh-team/docker', state: 'success', creator: { login: 'DankerMu' } };
// One cold node verifier plus one stand-in gh under a loaded host; unloaded each case takes
// well under 1s, while the earlier inner 5s timeout equalled the inherited case budget.
const GATE_CASE_MS = 15_000;
// After the verifier: the temporary-directory removal and the assertions.
const GATE_RESERVE_MS = 2_000;
// Above the reserve, so the hanging gh is cut about 1s in, well before its own 8s sleep ends.
const HANG_CASE_MS = 3_000;

function runGate(
  options: {
    event?: unknown;
    response?: unknown;
    missingEnvironment?: boolean;
    failGitHub?: boolean;
    hangGitHub?: boolean;
  } = {},
  // Created at entry, so the setup below already spends the case budget.
  { spawn } = caseSpawn(GATE_CASE_MS, GATE_RESERVE_MS),
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
    // Controlled external gh executable, not a mock of the verifier or its policy. The hanging
    // one names sleep absolutely because PATH is this directory alone; once the verifier is
    // killed, that orphaned sleep exits by itself within 8s and writes nothing.
    const body =
      options.hangGitHub === true
        ? 'exec /bin/sleep 8\n'
        : options.failGitHub === true
          ? "printf '%s\\n' 'GitHub API unavailable' >&2\nexit 1\n"
          : `printf '%s' '${response.replaceAll("'", "'\\''")}'\n`;
    writeFileSync(join(directory, 'gh'), `#!/bin/sh\n${body}`, { mode: 0o700 });
    // The case deadline cuts a hung child with SIGKILL and names the phase, never a null status.
    return spawn('docker evidence gate', process.execPath, [entrypoint], {
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
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe('executable Docker evidence gate', { timeout: GATE_CASE_MS }, () => {
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

  it(
    'a hung GitHub read is cut at the case deadline and names its phase',
    { timeout: HANG_CASE_MS },
    () => {
      let outcome: unknown;
      try {
        outcome = runGate({ hangGitHub: true }, caseSpawn(HANG_CASE_MS, GATE_RESERVE_MS));
      } catch (error) {
        outcome = error;
      }

      // A returned result shows in the diff, so a missed cut prints its null status, not a phase.
      expect(outcome).toMatchObject({
        message: expect.stringMatching(
          /^docker evidence gate: killed at the case deadline after \d+ms; descendants: not observed$/,
        ) as unknown,
      });
    },
  );
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { createDockerCommands } from './docker-command.ts';
import { startStandIn } from './install-dialog-fixture.ts';
import { freshSubmissionAssessment } from './trusted-docker-audit-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const cleanup: string[] = [];
afterEach(() => {
  delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('settles every exec submission while the stand-in is still starting', async () => {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-call-')));
  cleanup.push(custody);
  initializeVerificationSubmissions(custody);
  process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(custody, SUBMISSION_JOURNAL);
  let made = '';
  let polls = 0;
  // `docker exec --user 1001 [-d] <container> cmd...` on the host: the exec answers cmd's status;
  // -d answers 0 at once and the stand-in renames its ready marker in only after the first poll.
  const { commandAsync } = createDockerCommands('unused', 'unused', true, (args) => {
    const command = args.slice(args[3] === '-d' ? 5 : 4);
    if (args[3] === '-d') {
      setTimeout(() => {
        writeFileSync(`${made}/ready`, 'http://127.0.0.1:4873/');
      }, 0);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.includes(`${made}/ready`)) polls += 1;
    const run = spawnSync(command[0] ?? '', command.slice(1), { encoding: 'utf8' });
    if (command[0] === 'mktemp') cleanup.push((made = run.stdout.trim()));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  });

  const lifecycle = { commandAsync } as unknown as UserImageLifecycle;
  expect(await startStandIn(lifecycle, 'dsh-team-test-start')).toBe(made);
  expect(polls).toBeGreaterThan(1);
  expect(freshSubmissionAssessment(custody)).toBe('{"state":"confirmed"}\n');
});

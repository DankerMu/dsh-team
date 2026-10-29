import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { assessTrustedDockerCleanup } from '../../scripts/trusted-docker-audit.mjs';
import { writeReceipt } from '../../scripts/probe-browser-receipt.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { record } from './container-start-docker-fixture.ts';
import type { DockerCommand } from './docker-command.ts';

export interface AuditContext {
  pointer: string;
  receipt: Record<string, unknown>;
  temporary: string;
  journal: string;
  command: DockerCommand;
  assess: (
    settled?: boolean,
    external?: DockerCommand,
  ) => Promise<{ state: string; browserExec: unknown; unsettled?: unknown }>;
}

/** A separate process sees only durable evidence, never this process's memory. */
export function freshSubmissionAssessment(directory: string): string {
  const module = new URL('../../scripts/verification-submission-assessment.mjs', import.meta.url)
    .href;
  const assessor = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {requireVerificationSubmissionsSettled} from ${JSON.stringify(module)};
let state='confirmed';
try {requireVerificationSubmissionsSettled(${JSON.stringify(directory)});}
catch {state='unconfirmed';}
process.stdout.write(JSON.stringify({state})+'\\n');`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: tmpdir() },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(assessor.error).toBeUndefined();
  expect(assessor.signal).toBeNull();
  expect(assessor.status, assessor.stderr).toBe(0);
  expect(assessor.stderr).toBe('');
  return assessor.stdout;
}

export function ordinarySubmission(journal: string, interrupted: boolean, exitCode = 0) {
  const cleanupModule = new URL('./docker-cleanup.ts', import.meta.url).href;
  const commandModule = new URL('./docker-command.ts', import.meta.url).href;
  const runId = randomUUID();
  const name = `dsh-team-submission-${runId}`;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {registerCleanupTarget} from ${JSON.stringify(cleanupModule)};
import {createDockerCommands} from ${JSON.stringify(commandModule)};
registerCleanupTarget([],${JSON.stringify(runId)},{kind:'network',name:${JSON.stringify(name)}});
const {command}=createDockerCommands(process.cwd(),process.cwd(),false,()=>{
  process.stdout.write('submission-accepted\\n');
  return ${interrupted ? "{status:null,stdout:'',stderr:'',error:Object.assign(new Error('transport-lost'),{code:'ETIMEDOUT'})}" : "{status:0,stdout:'owned-network-id\\n',stderr:''}"};
});
command(['network','create',${JSON.stringify(name)}],1000);
process.exitCode=${String(exitCode)};`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        DSH_TEAM_CI_RESOURCE_JOURNAL: journal,
        DSH_TEAM_VERIFICATION_SUBMISSIONS: join(journal, '..', SUBMISSION_JOURNAL),
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
}

export async function withAuditReceipt(run: (context: AuditContext) => Promise<void> | void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-team-custody-audit-')));
  try {
    const directory = join(root, 'custody');
    const temporary = join(root, 'temporary');
    await mkdir(directory, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(join(directory, 'resources.jsonl'), '', { mode: 0o600 });
    initializeVerificationSubmissions(directory);
    const browser = join(temporary, `dsh-browser-command-${randomUUID()}`);
    await mkdir(browser, { mode: 0o700 });
    const profile = join(browser, 'profile');
    await mkdir(profile, { mode: 0o700 });
    const receiptFile = join(browser, 'chrome.receipt.json');
    const imageId = `sha256:${'a'.repeat(64)}`;
    const input = {
      profile,
      receiptFile,
      runtime: {
        kind: 'docker-isolated-network',
        imageId,
        chromeSha256: 'b'.repeat(64),
        runId: 'owned-audit-fixture',
      },
    };
    // Canonical registration runs in a real short-lived owner; no browser/Engine is started.
    const module = new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url).href;
    const cleanupModule = new URL('./docker-cleanup.ts', import.meta.url).href;
    const runId = randomUUID();
    const target = { kind: 'network', name: `dsh-team-audit-${runId}` };
    const registered = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {registerChrome} from ${JSON.stringify(module)};
import {registerCleanupTarget} from ${JSON.stringify(cleanupModule)};
registerCleanupTarget([],${JSON.stringify(runId)},${JSON.stringify(target)});
await registerChrome(${JSON.stringify(input)});`,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          LANG: 'C',
          DSH_TEAM_CI_RESOURCE_JOURNAL: join(directory, 'resources.jsonl'),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(registered.status, registered.stderr).toBe(0);
    const raw: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
    const registeredReceipt = record(raw);
    const receipt: Record<string, unknown> = {
      ...registeredReceipt,
      receiptFile,
      state: 'stopped',
      acquisition: { state: 'settled', producer: registeredReceipt.driver },
      socketDirectory: join(temporary, `retired-sockets-${String(registeredReceipt.nonce)}`),
    };
    const pointer = join(browser, `${String(receipt.nonce)}.launch.json`);
    await writeReceipt(pointer, receipt);
    const invocation = randomUUID();
    await writeReceipt(join(browser, 'image.json'), {
      invocation,
      imageId,
      tag: `dsh-team-browser-runtime-${invocation}`,
      cleanup: { image: 'confirmed', browserResources: 'confirmed' },
    });
    const identity = await stat(temporary);
    const request = {
      root,
      temporary,
      temporaryDevice: String(identity.dev),
      temporaryInode: String(identity.ino),
    };
    const command: DockerCommand = (args) => {
      if (args[1] === 'inspect')
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such ${String(args[0])}: ${String(args.at(-1))}`,
        };
      if (args[1] === 'ls') return { status: 0, stdout: '', stderr: '' };
      throw new Error('Cleanup assessment must not mutate Docker resources');
    };
    await run({
      pointer,
      receipt,
      temporary,
      journal: join(directory, 'resources.jsonl'),
      command,
      assess: (settled = true, external = command) =>
        assessTrustedDockerCleanup(request, directory, settled, external),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

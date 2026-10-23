import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { writeReceipt } from '../../scripts/probe-browser-receipt.mjs';
import { liveProcessBirth, processBirth } from '../../scripts/probe-browser-native.mjs';
import {
  SUBMISSION_JOURNAL,
  SUBMISSION_AUTHORITY,
  SUBMISSION_PENDING,
} from '../../scripts/verification-submission-storage.mjs';
import { record } from './container-start-docker-fixture.ts';
import type { DockerCommand } from './docker-command.ts';
import { ordinarySubmission, withAuditReceipt } from './trusted-docker-audit-fixture.ts';

function freshSubmissionAssessment(directory: string): string {
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

it.each(['driver', 'producer'])(
  'refuses missing browser %s authority despite empty resource observations',
  async (missing) => {
    await withAuditReceipt(async ({ pointer, receipt, assess }) => {
      expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });
      if (missing === 'driver') delete receipt.driver;
      else delete record(receipt.acquisition).producer;
      await writeReceipt(pointer, receipt);

      expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    });
  },
);

it('refuses a started browser receipt that omits its socket retirement authority', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });
    delete receipt.socketDirectory;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it('accepts a never-started registration without invented producer or socket identities', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    receipt.acquisition = { state: 'not-started' };
    delete receipt.socketDirectory;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });
  });
});

it('refuses the invocation root itself as browser receipt authority', async () => {
  await withAuditReceipt(async ({ pointer, receipt, temporary, assess }) => {
    expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });
    receipt.receiptFile = temporary;
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it.each(['driver', 'producer'])(
  'preserves an actually live browser %s and reports cleanup unconfirmed',
  async (role) => {
    await withAuditReceipt(async ({ pointer, receipt, assess }) => {
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      const closed = Promise.withResolvers<undefined>();
      sentinel.once('close', () => {
        closed.resolve(undefined);
      });
      try {
        await once(sentinel, 'spawn');
        if (sentinel.pid === undefined) throw new Error('Missing live sentinel');
        const identity = { pid: sentinel.pid, birth: await processBirth(sentinel.pid) };
        if (role === 'driver') receipt.driver = identity;
        else record(receipt.acquisition).producer = identity;
        await writeReceipt(pointer, receipt);

        expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
        expect(await liveProcessBirth(identity.pid)).toBe(identity.birth);
      } finally {
        if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill('SIGTERM');
        await closed.promise;
      }
    });
  },
);

it('does not turn an unsettled command into cleanup confirmation from empty inventories', async () => {
  await withAuditReceipt(async ({ assess }) => {
    expect(await assess(false)).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it('does not confirm an interrupted ordinary submission from empty inventories after its client exits zero', async () => {
  await withAuditReceipt(async ({ journal, assess }) => {
    const completed = ordinarySubmission(journal, false);
    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toBe('submission-accepted\n');
    expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });

    const client = ordinarySubmission(journal, true);
    expect(client.status, client.stderr).toBe(0);
    expect(client.stdout).toBe('submission-accepted\n');

    const cleanup = await assess();

    expect(cleanup).toEqual({ state: 'unconfirmed', browserExec: null });
    const later = ordinarySubmission(journal, false);
    expect(later.status, later.stderr).toBe(0);
    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    expect(freshSubmissionAssessment(join(journal, '..'))).toBe('{"state":"unconfirmed"}\n');
  });
});

it('preserves confirmed retirement after a completed ordinary submission and nonzero overall command', async () => {
  await withAuditReceipt(async ({ journal, assess }) => {
    const client = ordinarySubmission(journal, false, 17);
    expect(client.status, client.stderr).toBe(17);
    expect(client.stdout).toBe('submission-accepted\n');

    const cleanup = await assess();

    expect(cleanup).toEqual({ state: 'confirmed', browserExec: null });
    expect(freshSubmissionAssessment(join(journal, '..'))).toBe('{"state":"confirmed"}\n');
  });
});

it.each([
  { exit: '137', declared: 137, status: 137, state: 'confirmed' },
  { exit: '0', declared: 137, status: 0, state: 'confirmed' },
  { exit: '137', declared: undefined, status: 137, state: 'unconfirmed' },
  { exit: '125', declared: 137, status: 125, state: 'unconfirmed' },
  { exit: 'signal', declared: 137, status: null, state: 'unconfirmed' },
  { exit: 'spawn-error', declared: 137, status: null, state: 'unconfirmed' },
  // Synthetic collector results: the declared status alone cannot mask a failed or signalled CLI.
  { exit: '137-with-error', declared: 137, status: 137, state: 'unconfirmed' },
  { exit: '137-with-signal', declared: 137, status: 137, state: 'unconfirmed' },
])(
  'settles a mutation exit $exit only when it is the caller-declared status $declared',
  async ({ exit, declared, status, state }) => {
    await withAuditReceipt(async ({ journal, assess }) => {
      const commandModule = new URL('./docker-command.ts', import.meta.url).href;
      const behavior =
        exit === 'signal' ? "process.kill(process.pid,'SIGKILL')" : `process.exit(${exit})`;
      const synthetic =
        exit === '137-with-error'
          ? "({status:137,stdout:'',stderr:'',error:Object.assign(new Error('x'),{code:'ETIMEDOUT'})})"
          : exit === '137-with-signal'
            ? "({status:137,stdout:'',stderr:'',signal:'SIGKILL'})"
            : undefined;
      // The bounded Web command seam used by the OOM pressure exec, with a real child outcome
      // (or a synthetic collector result for the 137-with-* rows).
      const writer = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {spawnSync} from 'node:child_process';
import {createDockerCommands} from ${JSON.stringify(commandModule)};
const file=${JSON.stringify(exit === 'spawn-error' ? '/dsh-team-absent-executable' : process.execPath)};
const {command}=createDockerCommands(process.cwd(),process.cwd(),true,(args,timeout)=>
  ${synthetic ?? `spawnSync(file,['-e',${JSON.stringify(behavior)}],{encoding:'utf8',timeout,killSignal:'SIGKILL'})`});
const result=command(['exec','owned-container','python3'],2000,${String(declared)});
process.stdout.write(JSON.stringify({status:result.status})+'\\n');`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpdir(),
            DSH_TEAM_VERIFICATION_SUBMISSIONS: join(journal, '..', SUBMISSION_JOURNAL),
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );

      expect(writer.error).toBeUndefined();
      expect(writer.status, writer.stderr).toBe(0);
      expect(JSON.parse(writer.stdout)).toEqual({ status });
      expect(await assess()).toEqual({ state, browserExec: null });
      expect(freshSubmissionAssessment(join(journal, '..'))).toBe(`${JSON.stringify({ state })}\n`);
    });
  },
);

it.each(['fsync', 'close', 'write', 'unlink', 'death'])(
  'rejects visible settlement after completion %s fails and its writer exits',
  async (fault) => {
    await withAuditReceipt(async ({ journal }) => {
      const module = new URL('../../scripts/verification-submissions.mjs', import.meta.url).href;
      const directory = join(journal, '..');
      const submissions = join(directory, SUBMISSION_JOURNAL);
      const writer = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {beginVerificationSubmission} from ${JSON.stringify(module)};
const complete=beginVerificationSubmission();
const original={fsyncSync:fs.fsyncSync,closeSync:fs.closeSync,writeSync:fs.writeSync,unlinkSync:fs.unlinkSync};
const failure=new Error('owned-completion-publication-failure');
const fault=${JSON.stringify(fault)};
const journal=${JSON.stringify(submissions)};
const journalIdentity=fs.statSync(journal);
let observed;
try {
  if(fault==='fsync') fs.fsyncSync=()=>{throw failure;};
  if(fault==='write') fs.writeSync=()=>{throw failure;};
  if(fault==='unlink') fs.unlinkSync=()=>{throw failure;};
  if(fault==='death') fs.unlinkSync=()=>{
    process.stdout.write('completion-death-failed\\n');
    process.exit(17);
  };
  if(fault==='close') fs.closeSync=(fd)=>{
    const info=fs.fstatSync(fd);
    if(info.dev===journalIdentity.dev&&info.ino===journalIdentity.ino&&
      info.size>journalIdentity.size) throw failure;
    return original.closeSync(fd);
  };
  syncBuiltinESMExports();
  try {complete();} catch(error) {observed=error;}
} finally {
  Object.assign(fs,original);
  syncBuiltinESMExports();
}
if(observed!==failure) throw new Error('Expected completion publication failure');
let replayRejected=false;
try{complete();}catch{replayRejected=true;}
if(!replayRejected)throw new Error('Failed completion was replayed');
process.stdout.write('completion-'+fault+'-failed\\n');
process.exitCode=17;`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpdir(),
            DSH_TEAM_VERIFICATION_SUBMISSIONS: submissions,
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(writer.error).toBeUndefined();
      expect(writer.signal).toBeNull();
      expect(writer.status, writer.stderr).toBe(17);
      expect(writer.stdout).toBe(`completion-${fault}-failed\n`);
      expect(writer.stderr).toBe('');
      const rows = (await readFile(submissions, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return record(value);
        });
      expect(rows).toEqual([
        { version: 1, id: rows[0]?.id, state: 'submitted' },
        ...(fault === 'write' ? [] : [{ version: 1, id: rows[0]?.id, state: 'settled' }]),
      ]);
      expect(rows[0]?.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      if (fault !== 'write') expect(rows[1]?.id).toBe(rows[0]?.id);

      // The writer has exited; a separate, unfaulted process must not trust its visible row.
      expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
    });
  },
);

it.each([
  'journal-replaced',
  'pending-replaced',
  'journal-symlink',
  'pending-symlink',
  'journal-mode',
  'pending-mode',
  'anchor-missing',
  'anchor-malformed',
  'anchor-changed',
  'marker-replaced',
  'marker-missing',
  'marker-malformed',
])('rejects changed submission authority %s in the writer and a fresh assessor', async (fault) => {
  await withAuditReceipt(async ({ journal, assess }) => {
    const directory = join(journal, '..');
    const module = new URL('../../scripts/verification-submissions.mjs', import.meta.url).href;
    const writer = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {beginVerificationSubmission} from ${JSON.stringify(module)};
import {SUBMISSION_JOURNAL,SUBMISSION_PENDING,SUBMISSION_AUTHORITY} from ${JSON.stringify(new URL('../../scripts/verification-submission-storage.mjs', import.meta.url).href)};
const directory=${JSON.stringify(directory)};
const journal=join(directory,SUBMISSION_JOURNAL);
const pending=join(directory,SUBMISSION_PENDING);
const anchor=join(directory,SUBMISSION_AUTHORITY);
const complete=beginVerificationSubmission();
const marker=join(pending,fs.readdirSync(pending)[0]);
const fault=${JSON.stringify(fault)};
if(fault==='journal-replaced'||fault==='journal-symlink'){
  fs.renameSync(journal,journal+'.retired');
  if(fault==='journal-replaced')fs.writeFileSync(journal,'',{mode:0o600,flag:'wx'});
  else fs.symlinkSync(journal+'.retired',journal);
}
if(fault==='pending-replaced'||fault==='pending-symlink'){
  fs.renameSync(pending,pending+'.retired');
  if(fault==='pending-replaced')fs.mkdirSync(pending,{mode:0o700});
  else fs.symlinkSync(pending+'.retired',pending);
}
if(fault==='journal-mode')fs.chmodSync(journal,0o400);
if(fault==='pending-mode')fs.chmodSync(pending,0o500);
if(fault==='anchor-missing')fs.unlinkSync(anchor);
if(fault==='anchor-malformed')fs.writeFileSync(anchor,'{');
if(fault==='anchor-changed'){
  const value=JSON.parse(fs.readFileSync(anchor,'utf8'));
  value.invocation=randomUUID();
  fs.writeFileSync(anchor,JSON.stringify(value)+'\\n');
}
if(fault==='marker-replaced'){
  fs.renameSync(marker,marker+'.retired');
  fs.writeFileSync(marker,'{}',{mode:0o600,flag:'wx'});
}
if(fault==='marker-missing')fs.unlinkSync(marker);
if(fault==='marker-malformed')fs.writeFileSync(marker,'{');
let rejected=false;
try{complete();}catch{rejected=true;}
if(!rejected)throw new Error('Changed submission authority was accepted');
process.stdout.write('authority-change-rejected\\n');`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: tmpdir(),
          DSH_TEAM_VERIFICATION_SUBMISSIONS: join(directory, SUBMISSION_JOURNAL),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    try {
      expect(writer.error).toBeUndefined();
      expect(writer.signal).toBeNull();
      expect(writer.status, writer.stderr).toBe(0);
      expect(writer.stdout).toBe('authority-change-rejected\n');
      expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
      expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    } finally {
      if (fault === 'pending-mode') await chmod(join(directory, SUBMISSION_PENDING), 0o700);
    }
  });
});

it.each(['journal', 'pending'])(
  'refuses substituted %s authority even when every visible row is settled',
  async (kind) => {
    await withAuditReceipt(async ({ journal, assess }) => {
      const directory = join(journal, '..');
      const writer = ordinarySubmission(journal, false);
      expect(writer.status, writer.stderr).toBe(0);
      expect(freshSubmissionAssessment(directory)).toBe('{"state":"confirmed"}\n');
      const path = join(directory, kind === 'journal' ? SUBMISSION_JOURNAL : SUBMISSION_PENDING);
      const contents = kind === 'journal' ? await readFile(path, 'utf8') : '';

      await rename(path, `${path}.retired`);
      if (kind === 'journal') await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
      else await mkdir(path, { mode: 0o700 });

      expect(freshSubmissionAssessment(directory)).toBe('{"state":"unconfirmed"}\n');
      expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    });
  },
);

it('rejects repeated initialization and completion without rewriting settled evidence', async () => {
  await withAuditReceipt(({ journal }) => {
    const directory = join(journal, '..');
    const module = new URL('../../scripts/verification-submissions.mjs', import.meta.url).href;
    const writer = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {beginVerificationSubmission} from ${JSON.stringify(module)};
import {initializeVerificationSubmissions} from ${JSON.stringify(new URL('../../scripts/verification-submission-storage.mjs', import.meta.url).href)};
assert.throws(()=>initializeVerificationSubmissions(${JSON.stringify(directory)}));
const complete=beginVerificationSubmission();
complete();
const evidence=readFileSync(process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS,'utf8');
assert.throws(complete);
assert.equal(readFileSync(process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS,'utf8'),evidence);
process.stdout.write('replay-rejected\\n');`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: tmpdir(),
          DSH_TEAM_VERIFICATION_SUBMISSIONS: join(directory, SUBMISSION_JOURNAL),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    expect(writer.error).toBeUndefined();
    expect(writer.signal).toBeNull();
    expect(writer.status, writer.stderr).toBe(0);
    expect(writer.stdout).toBe('replay-rejected\n');
    expect(freshSubmissionAssessment(directory)).toBe('{"state":"confirmed"}\n');
  });
});

it.each(['marker-create', 'success', 'qualified-rejection'])(
  'preserves canonical HTTP outcome and custody after publication failure at %s',
  async (fault) => {
    await withAuditReceipt(async ({ journal, assess }) => {
      const directory = join(journal, '..');
      const module = new URL('../../scripts/verification-submissions.mjs', import.meta.url).href;
      const clientModule = new URL('../src/orchestrator/index.ts', import.meta.url).href;
      const writer = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {trackVerificationDockerClient} from ${JSON.stringify(module)};
import {SUBMISSION_PENDING} from ${JSON.stringify(new URL('../../scripts/verification-submission-storage.mjs', import.meta.url).href)};
import {createDockerClient,DockerHttpError} from ${JSON.stringify(clientModule)};
const directory=${JSON.stringify(directory)};
const fault=${JSON.stringify(fault)};
const socket=join(directory,'..','e.sock');
const pending=join(directory,SUBMISSION_PENDING);
const original={openSync:fs.openSync,fsyncSync:fs.fsyncSync};
const failure=new Error('owned-publication-failure');
const requests=[];
const server=createServer((request,response)=>{
  requests.push([request.method,request.url]);
  request.resume();
  request.on('end',()=>{
    if(fault==='qualified-rejection'){
      response.writeHead(403);
      response.flushHeaders();
    }else response.end('{}');
  });
});
let originalError;
let dispatches=0;
try{
  server.listen(socket);
  await once(server,'listening');
  const raw=createDockerClient(socket);
  const client=trackVerificationDockerClient({
    ...raw,
    async json(...args){
      dispatches++;
      try{
        const document=await raw.json(...args);
        if(fault==='success'){
          fs.fsyncSync=()=>{throw failure;};
          syncBuiltinESMExports();
        }
        return document;
      }catch(error){
        originalError=error;
        if(fault==='qualified-rejection'){
          fs.fsyncSync=()=>{throw failure;};
          syncBuiltinESMExports();
        }
        throw error;
      }
    },
  },DockerHttpError);
  if(fault==='marker-create'){
    fs.openSync=(path,flags,...rest)=>{
      if(String(path).startsWith(pending+'/')&&(flags&fs.constants.O_CREAT)!==0)throw failure;
      return original.openSync(path,flags,...rest);
    };
    syncBuiltinESMExports();
  }
  let observed;
  try{await client.json('POST','/networks/create',{},AbortSignal.timeout(2000),128);}
  catch(error){observed=error;}
  assert.equal(dispatches,fault==='marker-create'?0:1);
  assert.deepEqual(requests,fault==='marker-create'?[]:[['POST','/networks/create']]);
  if(fault==='qualified-rejection'){
    assert(originalError instanceof DockerHttpError);
    assert.equal(originalError.statusCode,403);
    assert.equal(observed,originalError);
  }else assert.equal(observed,failure);
  process.stdout.write('publication-failure-preserved\\n');
  process.exitCode=17;
}finally{
  Object.assign(fs,original);
  syncBuiltinESMExports();
  server.closeAllConnections();
  if(server.listening){
    const closed=Promise.withResolvers();
    server.close(error=>error?closed.reject(error):closed.resolve());
    await closed.promise;
  }
}`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpdir(),
            DSH_TEAM_VERIFICATION_SUBMISSIONS: join(directory, SUBMISSION_JOURNAL),
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );

      expect(writer.error).toBeUndefined();
      expect(writer.signal).toBeNull();
      expect(writer.status, writer.stderr).toBe(17);
      expect(writer.stdout).toBe('publication-failure-preserved\n');
      expect(writer.stderr).toBe('');
      const state = fault === 'marker-create' ? 'confirmed' : 'unconfirmed';
      expect(freshSubmissionAssessment(directory)).toBe(`${JSON.stringify({ state })}\n`);
      expect(await assess()).toEqual({ state, browserExec: null });
    });
  },
);

it.each(['missing', 'malformed'])(
  'does not confirm ordinary cleanup with %s submission authority',
  async (fault) => {
    await withAuditReceipt(async ({ journal, assess }) => {
      expect(await assess()).toEqual({ state: 'confirmed', browserExec: null });
      const path = join(journal, '..', SUBMISSION_JOURNAL);
      if (fault === 'missing') await rm(path);
      else await writeFile(path, '{invalid-json\n', { mode: 0o600 });

      expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    });
  },
);

it.each(['journal', 'browser-receipt'])(
  'retains uncertainty for malformed %s evidence',
  async (kind) => {
    await withAuditReceipt(async ({ pointer, journal, assess }) => {
      await writeFile(kind === 'journal' ? journal : pointer, '{invalid-json', { mode: 0o600 });

      expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
    });
  },
);

it.each(['inspect-failed', 'inventory-nonempty'])(
  'does not infer retirement when %s',
  async (fault) => {
    await withAuditReceipt(async ({ assess, command }) => {
      const observed: DockerCommand = (args, timeout) => {
        if (fault === 'inspect-failed' && args[1] === 'inspect')
          return { status: 1, stdout: '', stderr: 'owned-observer-denied' };
        if (fault === 'inventory-nonempty' && args[1] === 'ls')
          return { status: 0, stdout: 'registered-resource-remains\n', stderr: '' };
        return command(args, timeout);
      };

      expect(await assess(true, observed)).toEqual({ state: 'unconfirmed', browserExec: null });
    });
  },
);

it.each(['retired', 'foreign-diagnostic', 'present'])(
  'observes the untagged browser image through its canonical latest reference when %s',
  async (fault) => {
    await withAuditReceipt(async ({ pointer, assess, command }) => {
      const raw: unknown = JSON.parse(await readFile(join(dirname(pointer), 'image.json'), 'utf8'));
      const image = record(raw);
      const reference = `${String(image.tag)}:latest`;
      const inspected: string[] = [];
      // Docker 29.1.3 names a missing untagged image by its normalised `:latest` reference.
      const observed: DockerCommand = (args, timeout) => {
        if (args[0] !== 'image' || args[1] !== 'inspect') return command(args, timeout);
        const target = String(args.at(-1));
        inspected.push(target);
        if (fault === 'present' && target === reference)
          return { status: 0, stdout: '[{}]\n', stderr: '' };
        const missing =
          fault === 'foreign-diagnostic' && target === reference
            ? `${String(image.tag)}-foreign:latest`
            : target.includes(':')
              ? target
              : `${target}:latest`;
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such image: ${missing}\n`,
        };
      };

      const state = fault === 'retired' ? 'confirmed' : 'unconfirmed';
      expect(await assess(true, observed)).toEqual({ state, browserExec: null });
      expect(inspected).toEqual([image.imageId, reference]);
    });
  },
);

it('does not turn an uncertain browser acquisition into retirement when its producer is absent', async () => {
  await withAuditReceipt(async ({ pointer, receipt, assess }) => {
    record(receipt.acquisition).state = 'uncertain';
    await writeReceipt(pointer, receipt);

    expect(await assess()).toEqual({ state: 'unconfirmed', browserExec: null });
  });
});

it.each(
  ['sync', 'async'].flatMap((mode) =>
    ['success', 'nonzero', 'observation', 'missing-authority'].map((outcome) => ({
      mode,
      outcome,
    })),
  ),
)(
  'tracks actual selected Docker dispatch before its $mode $outcome process',
  async ({ mode, outcome }) => {
    await withAuditReceipt(async ({ journal }) => {
      const directory = join(journal, '..');
      const binaries = join(directory, 'bin');
      const witness = join(directory, 'dispatched');
      const submissionsModule = new URL(
        '../../scripts/verification-submission-assessment.mjs',
        import.meta.url,
      ).href;
      const commandModule = new URL('../../scripts/docker-command.mjs', import.meta.url).href;
      await mkdir(binaries, { mode: 0o700 });
      await writeFile(
        join(binaries, 'docker'),
        `#!${process.execPath}
const {writeFileSync}=require('node:fs');
// This owned executable is the external Docker boundary, not a mocked ledger.
// This extensionless CommonJS process fixture must load the canonical ESM module dynamically.
void import(${JSON.stringify(submissionsModule)}).then(({requireVerificationSubmissionsSettled})=>{
  let pending=false;
  try{requireVerificationSubmissionsSettled(${JSON.stringify(directory)});}catch{pending=true;}
  const observation=process.argv[2]==='version';
  if(pending===observation)throw new Error('Submission publication did not precede dispatch');
  writeFileSync(${JSON.stringify(witness)},'dispatched',{mode:0o600});
  process.stdout.write(observation?'observed\\n':'pending\\n');
  process.exitCode=Number(process.argv[3]);
}).catch(error=>{console.error(error);process.exitCode=99;});`,
        { mode: 0o700, flag: 'wx' },
      );
      if (outcome === 'missing-authority')
        await rename(
          join(directory, SUBMISSION_AUTHORITY),
          join(directory, `${SUBMISSION_AUTHORITY}.retired`),
        );
      const writer = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {spawn,spawnSync} from 'node:child_process';
import {runDockerCommand,runDockerCommandAsync,selectDockerExecution} from ${JSON.stringify(commandModule)};
const mode=${JSON.stringify(mode)};
const args=[${JSON.stringify(outcome === 'observation' ? 'version' : 'opaque-mutation')},${JSON.stringify(outcome === 'nonzero' ? '17' : '0')}];
let dispatched=false;
const dispatch=execution=>{
  dispatched=true;
  const options={env:{PATH:${JSON.stringify(binaries)}},timeout:2000,killSignal:'SIGKILL'};
  if(mode==='sync')return spawnSync(execution.file,execution.args,{...options,encoding:'utf8'});
  const settled=Promise.withResolvers();
  const child=spawn(execution.file,execution.args,options);
  child.stdin.end();
  let stdout='',stderr='',error;
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.once('error',failure=>{error=failure;});
  child.once('close',(status,signal)=>settled.resolve({status,signal,stdout,stderr,...(error?{error}:{})}));
  return settled.promise;
};
try{
  const execution=selectDockerExecution(args);
  const result=mode==='sync'?runDockerCommand(execution,dispatch):await runDockerCommandAsync(execution,dispatch);
  if(result.error||result.stderr)throw new Error('Owned executable failed unexpectedly');
  process.stdout.write(JSON.stringify({dispatched,status:result.status,stdout:result.stdout})+'\\n');
}catch(error){
  if(dispatched)throw error;
  process.stdout.write(JSON.stringify({dispatched:false})+'\\n');
}`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpdir(),
            DSH_TEAM_VERIFICATION_SUBMISSIONS: join(directory, SUBMISSION_JOURNAL),
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );

      expect(writer.error).toBeUndefined();
      expect(writer.signal).toBeNull();
      expect(writer.status, writer.stderr).toBe(0);
      expect(writer.stderr).toBe('');
      if (outcome === 'missing-authority') {
        expect(writer.stdout).toBe('{"dispatched":false}\n');
        await expect(stat(witness)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(JSON.parse(writer.stdout)).toEqual({
          dispatched: true,
          status: outcome === 'nonzero' ? 17 : 0,
          stdout: outcome === 'observation' ? 'observed\n' : 'pending\n',
        });
        expect(await readFile(witness, 'utf8')).toBe('dispatched');
      }
      const state =
        outcome === 'nonzero' || outcome === 'missing-authority' ? 'unconfirmed' : 'confirmed';
      expect(freshSubmissionAssessment(directory)).toBe(`${JSON.stringify({ state })}\n`);
      if (outcome === 'observation')
        expect(await readFile(join(directory, SUBMISSION_JOURNAL), 'utf8')).toBe('');
    });
  },
);

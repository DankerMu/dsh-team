import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect } from 'vitest';
import {
  bindVerificationDockerObserver,
  createVerificationDockerObserverAuthority,
  reserveVerificationDockerObserver,
} from '../../scripts/verification-docker-generations.mjs';
import type {
  DockerObserverReservation,
  DockerObserverWitness,
} from '../../scripts/verification-docker-generations.mjs';
import type { CleanupAssessmentRequest } from '../../scripts/trusted-docker-audit.mjs';
import { SUBMISSION_JOURNAL } from '../../scripts/verification-submission-storage.mjs';
import { processBirth } from '../../scripts/probe-browser-native.mjs';

export interface CompiledDockerClient {
  readonly javascript: string;
  readonly sourceMap: string;
}
export interface ObserverChildOptions {
  preload?: boolean;
  authority?: string;
  bind?: boolean;
  bindingGate?: Promise<undefined> | undefined;
  releaseResponse?: () => void;
  bindingFailure?: boolean;
  alterBinding?: 'replace' | 'change' | undefined;
  alterInitialization?: 'missing' | 'replace' | 'extra-link' | undefined;
  beforeRelease?: () => Promise<void>;
  inspectContainer?:
    (() => Promise<{ id: string; imageId: string; startedAt: string }>) | undefined;
}
interface ObserverChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function compileDockerClient(): CompiledDockerClient {
  const configPath = fileURLToPath(new URL('../tsconfig.build.json', import.meta.url));
  const sourcePath = fileURLToPath(new URL('../src/orchestrator/client.ts', import.meta.url));
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length !== 0)
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  if (parsed.options.outDir === undefined)
    throw new Error('Platform build output is not configured');
  const javascriptPath = join(parsed.options.outDir, 'orchestrator/client.js');
  const mapPath = `${javascriptPath}.map`;
  const emitted = new Map<string, string>();
  const host = ts.createCompilerHost(parsed.options);
  // Resolve actual package context, but capture every output instead of writing dist.
  host.writeFile = (path, text) => {
    if ((path !== javascriptPath && path !== mapPath) || emitted.has(path))
      throw new Error(`Unexpected standalone client compiler output: ${path}`);
    emitted.set(path, text);
  };
  const program = ts.createProgram([sourcePath], parsed.options, host);
  const source = program.getSourceFile(sourcePath);
  if (source === undefined) throw new Error('Production Docker client source was not loaded');
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length !== 0)
    throw new Error(
      diagnostics
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  const result = program.emit(source);
  if (result.emitSkipped || result.diagnostics.length !== 0)
    throw new Error(
      `Standalone client emission failed: ${result.diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`,
    );
  const javascript = emitted.get(javascriptPath);
  const sourceMap = emitted.get(mapPath);
  if (javascript === undefined || sourceMap === undefined || emitted.size !== 2)
    throw new Error('Standalone client compiler output is incomplete');
  return Object.freeze({ javascript, sourceMap });
}

export async function writeCompiledClient(
  directory: string,
  emitted: CompiledDockerClient,
): Promise<string> {
  await mkdir(join(directory, 'orchestrator'), { mode: 0o700 });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const path = join(directory, 'orchestrator/client.js');
  await writeFile(path, emitted.javascript, { mode: 0o600, flag: 'wx' });
  await writeFile(`${path}.map`, emitted.sourceMap, { mode: 0o600, flag: 'wx' });
  await writeFile(
    join(directory, 'orchestrator/index.js'),
    "export {createDockerClient,DockerHttpError} from './client.js';\n",
    { mode: 0o600, flag: 'wx' },
  );
  // Node resolves module URLs through Darwin's /var alias before invoking load hooks.
  return realpath(path);
}

function publishFailedBinding(
  reserved: DockerObserverReservation,
  witness: DockerObserverWitness,
): void {
  const module = new URL('../../scripts/verification-docker-generations.mjs', import.meta.url).href;
  const storage = new URL('../../scripts/verification-submission-storage.mjs', import.meta.url)
    .href;
  const controller = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {bindVerificationDockerObserver} from ${JSON.stringify(module)};
import {SUBMISSION_JOURNAL} from ${JSON.stringify(storage)};
import {join} from 'node:path';
const reserved=${JSON.stringify(reserved)};
const journal=join(reserved.directory,SUBMISSION_JOURNAL);
const identity=fs.statSync(journal);
const original=fs.fsyncSync;
const failure=new Error('owned-binding-approval-fsync-failure');
let observed;
try{
  fs.fsyncSync=fd=>{
    const info=fs.fstatSync(fd);
    if(info.dev===identity.dev&&info.ino===identity.ino){
      const last=JSON.parse(fs.readFileSync(journal,'utf8').trimEnd().split('\\n').at(-1));
      if(last.id===reserved.bindingApproval.id&&last.state==='settled')throw failure;
    }
    return original(fd);
  };
  syncBuiltinESMExports();
  try{bindVerificationDockerObserver(reserved,${JSON.stringify(witness)});}catch(error){observed=error;}
}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
assert.equal(observed,failure);
process.stdout.write('binding-approval-fsync-failed\\n');
process.exitCode=17;`,
    ],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(controller.error).toBeUndefined();
  expect(controller.signal).toBeNull();
  expect(controller.status, controller.stderr).toBe(17);
  expect(controller.stdout).toBe('binding-approval-fsync-failed\n');
}

async function alterObserverBinding(
  reserved: DockerObserverReservation,
  alteration: 'replace' | 'change',
): Promise<void> {
  const path = join(reserved.bootstrap, `${reserved.generation}.binding.json`);
  const text = await readFile(path, 'utf8');
  if (alteration === 'replace') {
    await rename(path, `${path}.retired`);
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
    return;
  }
  const binding: unknown = JSON.parse(text);
  if (
    typeof binding !== 'object' ||
    binding === null ||
    !('witness' in binding) ||
    typeof binding.witness !== 'object' ||
    binding.witness === null ||
    !('birth' in binding.witness) ||
    typeof binding.witness.birth !== 'string'
  )
    throw new Error('Owned process binding missing');
  binding.witness.birth += '-changed';
  await writeFile(path, JSON.stringify(binding) + '\n', { mode: 0o600 });
}

async function alterObserverInitialization(
  reserved: DockerObserverReservation,
  alteration: 'missing' | 'replace' | 'extra-link',
): Promise<void> {
  const prepared = join(
    dirname(join(reserved.directory, SUBMISSION_JOURNAL)),
    `observer-${reserved.generation}.initialized-prepared`,
  );
  const published = prepared.replace(/-prepared$/, '');
  if (alteration === 'missing') await unlink(prepared);
  else if (alteration === 'extra-link') await link(published, `${published}.extra`);
  else {
    const bytes = await readFile(prepared);
    await rename(prepared, `${prepared}.retired`);
    await unlink(published);
    await writeFile(prepared, bytes, { mode: 0o600, flag: 'wx' });
    await link(prepared, published);
  }
}

async function bindObserverChild(
  reserved: DockerObserverReservation,
  pid: number,
  options: ObserverChildOptions,
): Promise<void> {
  const witness: DockerObserverWitness =
    options.inspectContainer !== undefined
      ? {
          ...(await options.inspectContainer()),
          kind: 'container',
          authority: reserved.authority,
          generation: reserved.generation,
        }
      : { kind: 'process', pid, birth: await processBirth(pid), generation: reserved.generation };
  if (options.bindingFailure) publishFailedBinding(reserved, witness);
  else bindVerificationDockerObserver(reserved, witness);
  if (options.alterBinding !== undefined)
    await alterObserverBinding(reserved, options.alterBinding);
  if (options.alterInitialization !== undefined)
    await alterObserverInitialization(reserved, options.alterInitialization);
  await options.beforeRelease?.();
}

function startObserverChild(
  reserved: DockerObserverReservation,
  source: string,
  options: ObserverChildOptions,
): ChildProcess {
  const preload = new URL('../../scripts/verification-docker-observer.mjs', import.meta.url);
  preload.searchParams.set('bootstrap', reserved.bootstrap);
  preload.searchParams.set('authority', options.authority ?? reserved.authority);
  const entry = `process.send('fixture-ready');
${source}
if(process.connected)process.disconnect();`;
  return spawn(
    process.execPath,
    [
      ...(options.preload === false ? [] : ['--import', preload.href]),
      '--input-type=module',
      '-e',
      entry,
    ],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' },
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
}

function observeChildProcess(child: ChildProcess) {
  const ready = Promise.withResolvers<boolean>();
  const closed = Promise.withResolvers<ObserverChildExit>();
  let spawnFailure: Error | undefined;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once('message', (message) => {
    ready.resolve(message === 'fixture-ready');
  });
  child.once('error', (error) => {
    spawnFailure = error;
  });
  child.once('close', (code, signal) => {
    closed.resolve({ code, signal });
    ready.resolve(false);
  });
  return {
    ready: ready.promise,
    closed: closed.promise,
    result(outcome: ObserverChildExit) {
      if (spawnFailure) throw spawnFailure;
      return { ...outcome, stdout, stderr };
    },
  };
}

export async function runObserverChild(
  reserved: DockerObserverReservation,
  source: string,
  options: ObserverChildOptions = {},
) {
  const child = startObserverChild(reserved, source, options);
  const observed = observeChildProcess(child);
  try {
    if (await observed.ready) {
      if (child.pid === undefined) throw new Error('Observer fixture child identity missing');
      const mayBind =
        options.bindingGate === undefined ||
        (await Promise.race([
          options.bindingGate.then(() => true),
          observed.closed.then(() => false),
        ]));
      if (mayBind && options.bind !== false) await bindObserverChild(reserved, child.pid, options);
      options.releaseResponse?.();
    }
    return observed.result(await observed.closed);
  } finally {
    options.releaseResponse?.();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await observed.closed;
  }
}

export function freshObserverAssessment(directory: string): string {
  const module = new URL('../../scripts/verification-submission-assessment.mjs', import.meta.url)
    .href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {requireVerificationSubmissionsSettled} from ${JSON.stringify(module)};
let state='confirmed';
try{requireVerificationSubmissionsSettled(${JSON.stringify(directory)});}catch{state='unconfirmed';}
process.stdout.write(state);`,
    ],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe('');
  return child.stdout;
}

export interface ObserverFaultBehavior {
  submitted: boolean;
  initializationFailure: boolean;
  initializationTamper: boolean;
  livenessOnly: boolean;
  hasHttp: boolean;
}

export function observerFaultBehavior(fault: string): ObserverFaultBehavior {
  const submitted = [
    'missing-preload',
    'missing-parent-binding',
    'missing-module-interception',
    'abrupt-exit',
    'binding-publication-failure',
    'binding-replaced',
    'binding-changed',
    'initialization-missing',
    'initialization-replaced',
    'initialization-extra-link',
  ].includes(fault);
  const initializationFailure =
    fault === 'initialization-existing' || fault === 'initialization-race';
  const initializationTamper = [
    'initialization-missing',
    'initialization-replaced',
    'initialization-extra-link',
  ].includes(fault);
  const livenessOnly =
    fault === 'missing-factory' || fault === 'publication-failure' || initializationFailure;
  return {
    submitted,
    initializationFailure,
    initializationTamper,
    livenessOnly,
    hasHttp: submitted || livenessOnly,
  };
}

export async function prepareObserverFault(
  directory: string,
  socket: string,
  clientPath: string,
  fault: string,
) {
  const authority = createVerificationDockerObserverAuthority(directory, {
    moduleUrl: pathToFileURL(
      fault === 'missing-module-interception'
        ? join(directory, 'orchestrator/unloaded.js')
        : clientPath,
    ).href,
    socketPath: socket,
  });
  const reserved = await reserveVerificationDockerObserver(authority);
  const initializedPath = join(
    dirname(join(directory, SUBMISSION_JOURNAL)),
    `observer-${reserved.generation}.initialized`,
  );
  if (fault === 'initialization-existing')
    await writeFile(initializedPath, 'foreign-initialization\n', { mode: 0o600, flag: 'wx' });
  if (fault === 'foreign-capability') {
    const foreignAuthority = createVerificationDockerObserverAuthority(directory, {
      moduleUrl: pathToFileURL(clientPath).href,
      socketPath: socket,
    });
    const foreign = await reserveVerificationDockerObserver(foreignAuthority);
    await writeFile(reserved.capabilityPath, await readFile(foreign.capabilityPath), {
      mode: 0o600,
    });
  }
  if (fault === 'wrong-generation')
    await writeFile(
      join(authority.bootstrap, 'current.json'),
      JSON.stringify({ version: 1, nonce: randomUUID(), authority: authority.authority }),
      { mode: 0o600 },
    );
  if (fault === 'changed-journal') {
    const journal = join(directory, SUBMISSION_JOURNAL);
    const bytes = await readFile(journal);
    await rename(journal, `${journal}.retired`);
    await writeFile(journal, bytes, { mode: 0o600, flag: 'wx' });
  }
  return { reserved, initializedPath };
}

const bindingChanges: Readonly<Record<string, 'replace' | 'change' | undefined>> = {
  'binding-replaced': 'replace',
  'binding-changed': 'change',
};
const initializationChanges: Readonly<
  Record<string, 'missing' | 'replace' | 'extra-link' | undefined>
> = {
  'initialization-missing': 'missing',
  'initialization-replaced': 'replace',
  'initialization-extra-link': 'extra-link',
};

export function observerFaultOptions(
  fault: string,
  reserved: DockerObserverReservation,
  hasHttp: boolean,
  bindingGate: Promise<undefined>,
  releaseResponse: () => void,
): ObserverChildOptions {
  return {
    preload: fault !== 'missing-preload',
    authority: fault === 'foreign-authority' ? randomUUID() : reserved.authority,
    bind: hasHttp && fault !== 'missing-parent-binding',
    bindingGate: hasHttp ? bindingGate : undefined,
    releaseResponse,
    bindingFailure: fault === 'binding-publication-failure',
    alterBinding: bindingChanges[fault],
    alterInitialization: initializationChanges[fault],
  };
}

export function observerFaultSource(
  fault: string,
  clientPath: string,
  socket: string,
  initializedPath: string,
  livenessOnly: boolean,
): string {
  return `import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {request as fixtureRequest} from 'node:http';
import {createDockerClient} from ${JSON.stringify(pathToFileURL(clientPath).href)};
const fault=${JSON.stringify(fault)};
if(fault==='publication-failure'){
  const original=fs.fsyncSync;
  const failure=new Error('owned-observer-publication-failure');
  try{
    fs.fsyncSync=()=>{throw failure;};syncBuiltinESMExports();
    assert.throws(()=>createDockerClient(${JSON.stringify(socket)}),error=>error===failure);
  }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
  assert.throws(()=>createDockerClient(${JSON.stringify(socket)}));
}else if(fault==='initialization-existing'||fault==='initialization-race'){
  const target=${JSON.stringify(initializedPath)};
  const original=fs.linkSync;
  try{
    if(fault==='initialization-race'){
      fs.linkSync=(from,to)=>{
        assert.equal(to,target);
        fs.writeFileSync(target,'foreign-initialization\\n',{mode:0o600,flag:'wx'});
        return original(from,to);
      };
      syncBuiltinESMExports();
    }
    assert.throws(()=>createDockerClient(${JSON.stringify(socket)}),error=>
      error instanceof Error&&(fault!=='initialization-race'||error.code==='EEXIST'));
  }finally{fs.linkSync=original;syncBuiltinESMExports();}
  assert.equal(fs.readFileSync(target,'utf8'),'foreign-initialization\\n');
  assert.throws(()=>createDockerClient(${JSON.stringify(socket)}));
  assert.equal(fs.readFileSync(target,'utf8'),'foreign-initialization\\n');
}else if(fault!=='missing-factory'){
  const client=createDockerClient(${JSON.stringify(socket)});
  assert.deepEqual(await client.json('POST','/networks/create',{},AbortSignal.timeout(2000)),{Id:'owned-effect'});
  if(fault==='abrupt-exit')process.kill(process.pid,'SIGKILL');
}
if(${JSON.stringify(livenessOnly)}){
  const ended=Promise.withResolvers();
  const call=fixtureRequest({socketPath:${JSON.stringify(socket)},path:'/fixture-ready',signal:AbortSignal.timeout(2000)},response=>{
    response.resume();response.once('end',ended.resolve);
  });
  call.once('error',ended.reject);call.end();await ended.promise;
}`;
}

interface ObserverScenario {
  directory: string;
  socket: string;
  clientPath: string;
  reserved: DockerObserverReservation;
  stalls: boolean;
  containerMode: boolean;
  assessmentRequest: CleanupAssessmentRequest;
  createPath: string;
  body: Record<string, unknown>;
  ownedId: string;
  name: string;
  inspectPath: string;
  deletePath: string;
}

export function observerScenarioSource(input: ObserverScenario): string {
  const {
    directory,
    socket,
    clientPath,
    reserved,
    stalls,
    containerMode,
    assessmentRequest,
    createPath,
    body,
    ownedId,
    name,
    inspectPath,
    deletePath,
  } = input;
  const create = `client.json('POST',${JSON.stringify(createPath)},${JSON.stringify(body)},AbortSignal.timeout(200))`;
  const stalledCreate = `try{created=await ${create};}
catch(error){failure=error;}`;
  // Same monotonic clock as the engine; issued follows the synchronous submit and request write.
  const timedCreate = `const now=()=>Number(process.hrtime.bigint())/1e6;
const called=now();
let issued,settled;
try{const pending=${create};issued=now();created=await pending;}
catch(error){settled=now();failure=error;}`;
  const source = `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {requireVerificationSubmissionsSettled} from ${JSON.stringify(new URL('../../scripts/verification-submission-assessment.mjs', import.meta.url).href)};
import {createDockerClient,DockerHttpError} from ${JSON.stringify(pathToFileURL(clientPath).href)};
import {createDockerClient as reexported,DockerHttpError as ReexportedError} from ${JSON.stringify(pathToFileURL(join(directory, 'orchestrator/index.js')).href)};
assert.equal(createDockerClient,reexported);
assert.equal(DockerHttpError,ReexportedError);
const client=createDockerClient(${JSON.stringify(socket)});
const initializedPath=${JSON.stringify(join(dirname(join(directory, SUBMISSION_JOURNAL)), `observer-${reserved.generation}.initialized`))};
const initializedIdentity=fs.statSync(initializedPath);
createDockerClient(${JSON.stringify(socket)});
assert.equal(fs.statSync(initializedPath).ino,initializedIdentity.ino);
assert.equal(fs.statSync(initializedPath).dev,initializedIdentity.dev);
if(${JSON.stringify(!stalls && !containerMode)}){
  process.on('exit',()=>{
    const writers=requireVerificationSubmissionsSettled(${JSON.stringify(directory)});
    assert.equal(writers.length,1);
    assert.equal(writers[0].kind,'process');
    assert.equal(writers[0].pid,process.pid);
    assert.equal(writers[0].generation,${JSON.stringify(reserved.generation)});
    const assessment=spawnSync(process.execPath,['--input-type=module','-e',
      ${JSON.stringify(`import {assessTrustedDockerCleanup} from ${JSON.stringify(new URL('../../scripts/trusted-docker-audit.mjs', import.meta.url).href)};
const result=await assessTrustedDockerCleanup(${JSON.stringify(assessmentRequest)},${JSON.stringify(directory)},true,()=>{throw new Error('Unexpected Docker inspection for process-only fixture');});
process.stdout.write(result.state);`)}
    ],{env:{PATH:process.env.PATH,LANG:'C'},encoding:'utf8',timeout:5000});
    assert.equal(assessment.error,undefined);
    assert.equal(assessment.status,0,assessment.stderr);
    assert.equal(assessment.stdout,'unconfirmed');
  });
}
let failure,created;
// Real cancellation must close the actual incomplete HTTP response, not a simulated timer.
${stalls ? stalledCreate : timedCreate}
if(${JSON.stringify(stalls)}){
  assert(failure instanceof Error);
  assert(!(failure instanceof DockerHttpError));
  assert(!Object.hasOwn(failure,'cause'));
}else{
  if(failure!==undefined)process.stderr.write('create-timing:'+JSON.stringify({called,issued,settled})+'\\n');
  assert.equal(failure,undefined);
  assert.deepEqual(created,{Id:${JSON.stringify(ownedId)}});
}
const owned=await client.json('GET',${JSON.stringify(inspectPath)},undefined,AbortSignal.timeout(2000));
assert.deepEqual(owned,{Id:${JSON.stringify(ownedId)},Name:${JSON.stringify(`/${name}`)},Config:${JSON.stringify(body)}});
await client.json('DELETE',${JSON.stringify(deletePath)},undefined,AbortSignal.timeout(2000));
let absence;
try{await client.json('GET',${JSON.stringify(inspectPath)},undefined,AbortSignal.timeout(2000));}
catch(error){absence=error;}
assert(absence instanceof DockerHttpError);
assert.equal(absence.statusCode,404);
let rejected;
try{await client.json('POST','/networks/create',{},AbortSignal.timeout(2000));}
catch(error){rejected=error;}
assert(rejected instanceof DockerHttpError);
assert.equal(rejected.statusCode,403);
assert.deepEqual(await client.json('GET','/large',undefined,AbortSignal.timeout(2000),256),{Data:'x'.repeat(128)});
await assert.rejects(client.json('GET','/large',undefined,AbortSignal.timeout(2000),16),error=>error instanceof Error&&!(error instanceof DockerHttpError));
const logs=client.logs('/logs',AbortSignal.timeout(2000));
assert.deepEqual(await logs.next(),{done:false,value:{stream:'stdout',data:Buffer.from('a')}});
await logs.return(undefined);
process.stdout.write(${JSON.stringify(stalls ? 'create-aborted-owned-cleanup-observed\n' : 'create-completed-owned-cleanup-observed\n')});`;
  return source;
}

const CREATE_TIMING = 'create-timing:';
const OUTPUT_TAIL = 8192;
interface ObserverCreateEngineEvidence {
  received: number | null;
  bodyEnded: number | null;
  responseFinished: number | null;
  responseClosed: number | null;
  dispatchedSettled: boolean;
  persisted: boolean;
  markersBeforeBinding: readonly string[];
  requests: readonly { method: string | undefined; path: string | undefined }[];
  maxEventLoopDelayMs: number;
}

/** Failure-only evidence; it never throws, so the original assertion stays authoritative. */
export function formatObserverCreateDiagnostic(
  outcome: { stdout: string; stderr: string },
  engine: ObserverCreateEngineEvidence,
): string {
  return JSON.stringify({
    childTiming: childCreateTiming(outcome.stderr),
    engine: {
      received: engine.received,
      bodyEnded: engine.bodyEnded,
      responseFinished: engine.responseFinished,
      responseClosed: engine.responseClosed,
      dispatchedSettled: engine.dispatchedSettled,
      persisted: engine.persisted,
      markersBeforeBinding: engine.markersBeforeBinding.length,
      requests: engine.requests.map(({ method, path }) => `${method ?? ''} ${path ?? ''}`),
      maxEventLoopDelayMs: engine.maxEventLoopDelayMs,
    },
    stdout: boundedTail(outcome.stdout),
    stderr: boundedTail(outcome.stderr),
  });
}

/** Parsed from the full stream so tail truncation cannot lose the child's own timing. */
function childCreateTiming(stderr: string): unknown {
  const line = stderr.split('\n').find((candidate) => candidate.startsWith(CREATE_TIMING));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(CREATE_TIMING.length)) as unknown;
  } catch {
    return null;
  }
}

function boundedTail(text: string): string {
  const omitted = text.length - OUTPUT_TAIL;
  return omitted > 0
    ? `[truncated: ${String(omitted)} earlier characters omitted]\n${text.slice(omitted)}`
    : text;
}

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { record } from './container-start-docker-fixture.ts';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const birthModule = new URL('../../scripts/probe-browser-native.mjs', import.meta.url).href;

function prepareCustodyRepository(
  repository: string,
  environment: NodeJS.ProcessEnv,
  mode: 'fail' | 'hold',
) {
  const files = [
    'scripts/probe-browser-native.mjs',
    'scripts/probe-browser-receipt.mjs',
    'scripts/probe-browser-network.mjs',
    'scripts/docker-proxy-environment.mjs',
    'scripts/docker-build-diagnostics.mjs',
    'platform/test/docker-command.ts',
    'platform/test/docker-cleanup.ts',
    ...readdirSync(join(sourceRoot, 'scripts'))
      .filter((name) => name.startsWith('trusted-docker-'))
      .map((name) => `scripts/${name}`),
    ...readdirSync(join(sourceRoot, 'platform/test'))
      .filter(
        (name) =>
          name.startsWith('trusted-docker-') &&
          !name.endsWith('.test.ts') &&
          !name.endsWith('-fixture.ts'),
      )
      .map((name) => `platform/test/${name}`),
  ];
  for (const relative of files) {
    const destination = join(repository, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(sourceRoot, relative), destination);
  }
  const packageValue: unknown = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  const verificationScript = record(record(packageValue).scripts)['verify:docker'];
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { 'test:docker': 'node fixture-child.mjs', 'verify:docker': verificationScript },
    }),
  );
  writeFileSync(join(repository, '.gitignore'), '.run/\n');
  writeFileSync(
    join(repository, 'fixture-child.mjs'),
    `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,watch,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {processBirth} from './scripts/probe-browser-native.mjs';
const custody=dirname(process.env.DSH_TEAM_CI_RESOURCE_JOURNAL);
const manifest=JSON.parse(readFileSync(join(custody,'manifest.json'),'utf8'));
assert.equal(manifest.head,process.env.DSH_TEAM_REVIEWED_HEAD);
assert.equal(await processBirth(manifest.owner.pid),manifest.owner.birth);
assert.equal(process.env.GH_TOKEN,undefined);
assert.equal(process.env.DMXAPI_KEY,undefined);
assert.equal(process.env.SSH_AUTH_SOCK,undefined);
const temporary=process.env.TMPDIR;
const release=join(temporary,'release');
process.once('SIGINT',()=>{writeFileSync(join(temporary,'child-interrupted'),'SIGINT');process.exitCode=27;process.exit(27);});
let ready;
const released=new Promise(resolve=>{ready=resolve;});
const watcher=${JSON.stringify(mode)}==='hold'?watch(temporary,()=>{if(existsSync(release))ready();}):undefined;
writeFileSync(join(temporary,'child-ready.json'),JSON.stringify({pid:process.pid,birth:await processBirth(process.pid)}));
process.stdout.write('fixture-begin\\n');
if(watcher){await released;watcher.close();}
process.stdout.write('fixture-end\\n');
process.stderr.write('fixture-error\\n');
process.exitCode=17;
`,
  );
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--quiet',
      '-m',
      'test: owned custody fixture',
    ],
  ]) {
    const result = spawnSync('git', args, {
      cwd: repository,
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error('Could not create owned custody repository');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  }).stdout.trim();
  return head;
}

export function createTrustedDockerFixture(mode: 'fail' | 'hold' = 'fail') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-team-docker-custody-')));
  const repository = join(directory, 'repository');
  const home = join(directory, 'home');
  mkdirSync(repository);
  mkdirSync(home);
  const environment = { PATH: process.env.PATH, HOME: home };
  const observeProcess = (pid: number): string | null => {
    // Darwin's existing ps-based identity is locale-sensitive; observe in the actual owner's
    // controlled environment, not the surrounding Vitest worker's unrelated locale.
    const source = `import {liveProcessBirth} from ${JSON.stringify(birthModule)};process.stdout.write(JSON.stringify(await liveProcessBirth(Number(process.argv[1]))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, String(pid)], {
      env: { ...environment, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65_536,
    });
    if (result.error || result.status !== 0)
      throw new Error('Fixture process observation unavailable');
    const value: unknown = JSON.parse(result.stdout);
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid fixture process observation');
    return value;
  };
  const head = prepareCustodyRepository(repository, environment, mode);
  const entry = join(repository, 'scripts/trusted-docker-run.mjs');
  const command = (args: string[], wrapper = false) =>
    spawnSync(
      wrapper ? 'pnpm' : process.execPath,
      wrapper ? ['--silent', 'verify:docker', ...args] : [entry, ...args],
      {
        cwd: repository,
        env: {
          ...environment,
          GH_TOKEN: 'fixture-gh-custody-canary',
          DMXAPI_KEY: 'fixture-model-custody-canary',
          SSH_AUTH_SOCK: '/fixture-ssh-custody-canary',
        },
        encoding: 'utf8',
        timeout: 15_000,
        killSignal: 'SIGKILL',
        maxBuffer: 65_536,
      },
    );
  const custodyBase = join(home, '.local/share/dsh-team/docker-verification');
  const issued = new Map<
    string,
    {
      owner: Record<string, unknown>;
      child?: Record<string, unknown>;
      temporary: string;
      device: number;
      inode: number;
    }
  >();
  const start = async () => {
    const result = command(['start', head], true);
    if (result.status !== 0) return result;
    const value: unknown = JSON.parse(result.stdout);
    const invocation = record(value).invocation;
    if (typeof invocation !== 'string' || !/^[a-f0-9-]{36}$/.test(invocation))
      throw new Error('Invalid issued fixture invocation');
    const invocationRoot = join(custodyBase, invocation);
    const requested: unknown = JSON.parse(
      readFileSync(join(invocationRoot, 'request.json'), 'utf8'),
    );
    const request = record(requested);
    if (
      request.head !== head ||
      request.root !== repository ||
      typeof request.temporary !== 'string'
    )
      throw new Error('Fixture launch authority changed');
    const temporary = realpathSync(request.temporary);
    if (!temporary.startsWith(join(realpathSync('/tmp'), 'dsh-team-docker-')))
      throw new Error('Unexpected fixture temporary root');
    const temporaryIdentity = lstatSync(temporary);
    if (!temporaryIdentity.isDirectory() || temporaryIdentity.uid !== process.getuid?.())
      throw new Error('Unowned fixture temporary root');
    const launched: unknown = JSON.parse(readFileSync(join(invocationRoot, 'launch.json'), 'utf8'));
    const authority = {
      owner: Object.freeze({ ...record(record(launched).owner) }),
      temporary,
      device: temporaryIdentity.dev,
      inode: temporaryIdentity.ino,
    };
    issued.set(invocation, authority);
    const until = Date.now() + 10_000;
    const childPath = join(invocationRoot, 'child.json');
    while (!existsSync(childPath) && !existsSync(join(invocationRoot, 'result.json'))) {
      if (Date.now() >= until) throw new Error('Owned fixture command identity was not published');
      await delay(20);
    }
    if (existsSync(childPath)) {
      const child: unknown = JSON.parse(readFileSync(childPath, 'utf8'));
      issued.set(invocation, {
        ...authority,
        child: Object.freeze({ ...record(record(child).owner) }),
      });
    }
    return result;
  };
  const settle = async (identity: Record<string, unknown>, group: boolean) => {
    const pid = identity.pid;
    if (typeof pid !== 'number' || typeof identity.birth !== 'string')
      throw new Error('Invalid owned fixture identity');
    const current = observeProcess(pid);
    if (current === null) return;
    if (current !== identity.birth)
      throw new Error('Fixture identity changed; retaining authority');
    if (group) {
      const observed = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65_536,
      });
      const current = observeProcess(pid);
      if (current === null) return;
      if (current !== identity.birth)
        throw new Error('Fixture identity changed; retaining authority');
      if (observed.status !== 0 || observed.stdout.trim() !== String(pid))
        throw new Error('Owned fixture process group identity changed');
    }
    process.kill(group ? -pid : pid, 'SIGKILL');
    const until = Date.now() + 5000;
    while (observeProcess(pid) === identity.birth) {
      if (Date.now() >= until) throw new Error('Owned custody fixture process did not retire');
      await delay(20);
    }
  };
  const cleanup = async () => {
    if (existsSync(custodyBase) && readdirSync(custodyBase).some((name) => !issued.has(name)))
      throw new Error('Uncaptured custody fixture authority retained');
    for (const authority of issued.values()) {
      if (authority.child) await settle(authority.child, true);
      await settle(authority.owner, false);
      if (existsSync(authority.temporary)) {
        const current = lstatSync(authority.temporary);
        if (
          !current.isDirectory() ||
          current.dev !== authority.device ||
          current.ino !== authority.inode
        )
          throw new Error('Fixture temporary root identity changed');
        rmSync(authority.temporary, { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, repository, home, head, command, start, observeProcess, cleanup };
}

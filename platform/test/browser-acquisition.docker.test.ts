import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { awaitFile } from './browser-runtime-fixture.ts';
import { browserDocker, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { retireAcquisition, stopOwnedUnit } from '../../scripts/ci-vps-units.mjs';
import { removeOwned } from './docker-cleanup.ts';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
const acquisitionFence = vi.hoisted(() => ({
  path: '',
  observed: undefined as (() => undefined) | undefined,
  release: Promise.resolve(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const value = await actual.readFile(...args);
      if (typeof args[0] === 'string' && args[0] === acquisitionFence.path) {
        acquisitionFence.observed?.();
        await acquisitionFence.release;
      }
      return value;
    },
  };
});
afterEach(() => {
  acquisitionFence.path = '';
  acquisitionFence.observed = undefined;
  acquisitionFence.release = Promise.resolve();
});

async function stopDriver(driver: ChildProcess, exited: Promise<unknown>) {
  if (driver.exitCode === null && !driver.signalCode) {
    driver.kill('SIGKILL');
    await exited;
  }
}

it.each(
  ['network-before-id', 'network-after-id-before-container', 'container-before-id'].flatMap(
    (phase) => ['driver', 'cgroup'].map((termination) => ({ phase, termination })),
  ),
)(
  'settles the still-live producer after $termination death at $phase before publishing complete cleanup',
  async ({ phase, termination }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-partial-create-'));
    const receiptFile = join(root, 'chrome.receipt.json');
    const marker = join(root, 'created');
    const released = join(root, 'release');
    const returned = join(root, 'returned');
    const invocation = randomUUID();
    const unit = `dsh-team-ci-${invocation}-run.service`;
    const sentinel = `dsh-team-test-sentinel-${invocation}`;
    if (termination === 'cgroup')
      browserDocker(['volume', 'create', '--label', `dsh-team.test-run=${invocation}`, sentinel]);
    const realDocker = execFileSync('which', ['docker'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    }).trim();
    const originalPath = process.env.PATH;
    const runtimeModule = fileURLToPath(
      new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url),
    );
    const launcherModule = fileURLToPath(
      new URL('../../scripts/probe-dsh-api-cdp.mjs', import.meta.url),
    );
    const shim = join(root, 'docker');
    await writeFile(
      shim,
      `#!/usr/bin/env node
const fs=require('node:fs');const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
const phase=${JSON.stringify(phase)};
const matches=phase==='network-before-id'?args[0]==='network'&&args[1]==='create':args[0]==='create';
async function hold(id){
    const {promise,resolve}=Promise.withResolvers();
    const watcher=fs.watch(${JSON.stringify(root)},(_event,name)=>{if(name==='release')resolve();});
    fs.writeFileSync(${JSON.stringify(marker + '.tmp')},id,{mode:0o600});
    fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});
    if(!fs.existsSync(${JSON.stringify(released)}))await promise;
    watcher.close();
}
const {dockerProxyEnvironment}=require(${JSON.stringify(fileURLToPath(new URL('../../scripts/docker-proxy-environment.mjs', import.meta.url)))});
async function run(){
  if(matches&&phase==='network-after-id-before-container')await hold('');
  const result=spawnSync(${JSON.stringify(realDocker)},args,{encoding:'utf8',env:{PATH:${JSON.stringify(originalPath)},DOCKER_CONFIG:process.env.DOCKER_CONFIG,...dockerProxyEnvironment()},timeout:30000});
  if(matches&&result.status===0){
    if(phase!=='network-after-id-before-container')await hold(result.stdout);
    fs.writeFileSync(${JSON.stringify(returned + '.tmp')},result.stdout,{mode:0o600});
    fs.renameSync(${JSON.stringify(returned + '.tmp')},${JSON.stringify(returned)});
  }
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status===0?0:1;
}
run().catch(()=>{process.exitCode=1;});
`,
      { mode: 0o755 },
    );
    const argumentsForDriver = [
      '--input-type=module',
      '-e',
      `import {startChrome} from ${JSON.stringify(launcherModule)};import {isolatedBrowserRuntime} from ${JSON.stringify(runtimeModule)};const chrome=await startChrome({runtime:isolatedBrowserRuntime(),origin:'http://127.0.0.1:12345',profile:${JSON.stringify(join(root, 'profile'))},receiptFile:${JSON.stringify(receiptFile)}});await chrome.stop();`,
    ];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${root}:${originalPath ?? ''}`,
    };
    const forwarded = [
      'PATH',
      'CHROME_BIN',
      'DSH_TEAM_BROWSER_RUNTIME',
      'DSH_TEAM_BROWSER_IMAGE_ID',
      'DSH_TEAM_BROWSER_CHROME_SHA256',
      'DSH_TEAM_BROWSER_DOCKER_CONFIG',
      'DSH_TEAM_BROWSER_RECEIPT_DIRECTORY',
      'DSH_TEAM_BROWSER_INVOCATION',
    ].flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [`--setenv=${name}=${value}`];
    });
    const driver =
      termination === 'cgroup'
        ? spawn(
            'systemd-run',
            [
              '--user',
              `--unit=${unit}`,
              '--collect',
              '--wait',
              '--pipe',
              `--description=dsh-team-ci:${invocation}`,
              '--property=KillMode=control-group',
              '--property=KillSignal=SIGKILL',
              '--property=RuntimeMaxSec=90',
              '--property=TimeoutStopSec=2',
              ...forwarded,
              `--setenv=DSH_TEAM_CI_INVOCATION=${invocation}`,
              '/usr/bin/sg',
              'docker',
              '-c',
              [process.execPath, ...argumentsForDriver]
                .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
                .join(' '),
            ],
            { stdio: 'ignore' },
          )
        : spawn(process.execPath, argumentsForDriver, { env: environment, stdio: 'ignore' });
    const exited = once(driver, 'exit');
    let pending: Promise<void> | undefined;
    const birthObserved = Promise.withResolvers<undefined>();
    const birthReleased = Promise.withResolvers<undefined>();
    try {
      await awaitFile(marker);
      const id = (await readFile(marker, 'utf8')).trim();
      const before = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      const producer = record(record(before.acquisition).producer);
      if (typeof producer.pid !== 'number')
        throw new Error('Partial-creation producer identity missing');
      expect(before.containerId).toBeNull();
      if (phase === 'network-before-id') expect(before.networkId).toBeNull();
      else expect(before.networkId).toMatch(/^[a-f0-9]{64}$/);
      expect(before.state).toBe('pending-identity');
      if (termination === 'cgroup') stopOwnedUnit(unit, `dsh-team-ci:${invocation}`);
      else expect(driver.kill('SIGKILL')).toBe(true);
      await exited;
      process.env.PATH = `${root}:${originalPath ?? ''}`;
      acquisitionFence.path = `/proc/${String(producer.pid)}/stat`;
      acquisitionFence.observed = () => {
        birthObserved.resolve(undefined);
        return undefined;
      };
      acquisitionFence.release = birthReleased.promise;
      pending = rescueChrome(receiptFile);
      const deadline = AbortSignal.timeout(15000);
      await Promise.race([
        birthObserved.promise,
        pending.then(() => {
          throw new Error('Acquisition rescue completed before the live-producer fence');
        }),
        once(deadline, 'abort').then(() => {
          throw new Error('Acquisition was not fenced by live producer identity');
        }),
      ]);
      const during = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      expect(during.containerId).toBeNull();
      expect(record(during.acquisition).state).toBe('creating');
      await writeFile(released, 'release');
      await awaitFile(returned);
      const returnedId = (await readFile(returned, 'utf8')).trim();
      birthReleased.resolve(undefined);
      await pending;
      const after = record(JSON.parse(await readFile(receiptFile, 'utf8')));
      expect(after.state).toBe('stopped');
      if (phase === 'network-before-id') expect(after.networkId).toBe(id);
      else expect(after.containerId).toBe(returnedId);
      expect(after.networkId).toMatch(/^[a-f0-9]{64}$/);
      expect(after.containerId).toMatch(/^[a-f0-9]{64}$/);
      expect(record(after.acquisition).state).toBe('settled');
      expect(
        browserDocker([
          'container',
          'ls',
          '--all',
          '--filter',
          `label=dsh-team.browser-nonce=${String(after.nonce)}`,
          '--quiet',
          '--no-trunc',
        ]),
      ).toBe('');
      expect(
        browserDocker([
          'network',
          'ls',
          '--filter',
          `label=dsh-team.browser-nonce=${String(after.nonce)}`,
          '--quiet',
          '--no-trunc',
        ]),
      ).toBe('');
      if (termination === 'cgroup') {
        retireAcquisition(invocation, after.nonce);
        expect(
          browserDocker([
            'volume',
            'inspect',
            '--format',
            '{{ index .Labels "dsh-team.test-run" }}',
            sentinel,
          ]),
        ).toBe(invocation);
      }
    } finally {
      try {
        birthReleased.resolve(undefined);
        if (termination === 'cgroup') stopOwnedUnit(unit, `dsh-team-ci:${invocation}`);
        await writeFile(released, 'release');
        await stopDriver(driver, exited);
        await pending?.catch(() => undefined);
        await rescueChrome(receiptFile);
        await rm(root, { recursive: true, force: true });
      } finally {
        try {
          if (termination === 'cgroup')
            removeOwned(
              (args, timeout) =>
                spawnSync('docker', args, {
                  env: {
                    PATH: originalPath,
                    DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
                    ...dockerProxyEnvironment(),
                  },
                  encoding: 'utf8',
                  timeout,
                }),
              'volume',
              sentinel,
              invocation,
              { 'dsh-team.test-run': invocation },
            );
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }
  },
);

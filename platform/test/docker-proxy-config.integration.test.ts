import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const moduleUrl = new URL('../../scripts/docker-proxy-environment.mjs', import.meta.url).href;
const scenario = String.raw`import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const [mode,moduleUrl,canary]=process.argv.slice(1);
const directory=join(process.env.HOME,'.config/dsh-team');
const file=join(directory,'docker-proxy.json');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
let content=JSON.stringify({HTTP_PROXY:'http://127.0.0.1:18080',NO_PROXY:''});
const fields={
 'unknown-field':{HTTP_PROXY:'http://127.0.0.1:18080',DOCKER_HOST:canary},
 'non-string':{HTTP_PROXY:42},
 'non-loopback':{HTTP_PROXY:'http://'+canary+'.invalid:18080'},
 'alternate-ip':{HTTP_PROXY:'http://127.1:18080'},
 'scheme':{HTTP_PROXY:'socks5://127.0.0.1:18080'},
 'url-path':{HTTP_PROXY:'http://127.0.0.1:18080/'+canary},
 'url-query':{HTTP_PROXY:'http://127.0.0.1:18080/?'+canary},
 'whitespace':{HTTP_PROXY:' http://127.0.0.1:18080'},
 'line-break':{NO_PROXY:canary+'\n'},
};
if(fields[mode])content=JSON.stringify(fields[mode]);
if(mode==='invalid-json')content='{'+canary;
if(mode==='array')content='[]';
if(mode==='exact-bound'||mode==='oversized')content='{}'+' '.repeat((mode==='exact-bound'?16384:16385)-2);
if(mode==='invalid-utf8')content=Buffer.from([0x7b,0xff,0x7d]);
fs.writeFileSync(file,content,{mode:0o600});
if(mode==='root-entry'){
 fs.chmodSync(file,0o644);
 const bin=join(process.env.HOME,'bin'),temporary=join(process.env.HOME,'tmp'),marker=join(process.env.HOME,'docker-called');
 fs.mkdirSync(bin);fs.mkdirSync(temporary);
 fs.writeFileSync(join(bin,'docker'),'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(marker)+',"called");process.exit(2);',{mode:0o700});
 const preload=join(process.env.HOME,'host.mjs');
 fs.writeFileSync(preload,'import os from "node:os";import {syncBuiltinESMExports} from "node:module";os.platform=()=>"linux";os.arch=()=>"x64";syncBuiltinESMExports();');
 const entry=fileURLToPath(new URL('./verify-browser-runtime.mjs',moduleUrl));
 const result=spawnSync(process.execPath,['--import',preload,entry,'docker'],{env:{...process.env,PATH:bin,TMPDIR:temporary},encoding:'utf8',timeout:2000});
 if(result.error||result.signal||fs.existsSync(marker)){process.stdout.write('root config fence failed');process.exit(2);}
 process.stdout.write(result.stdout+result.stderr);process.exit(result.status??1);
}
if(mode==='public-mode')fs.chmodSync(file,0o644);
if(mode==='unreadable')fs.chmodSync(file,0o000);
if(mode==='symlink'){fs.renameSync(file,file+'.target');fs.symlinkSync(file+'.target',file);}
if(mode==='directory'){fs.unlinkSync(file);fs.mkdirSync(file,{mode:0o700});}
if(mode==='fifo'){fs.unlinkSync(file);execFileSync('mkfifo',['-m','600',file],{timeout:1000});}
os.platform=()=>mode==='unsupported-host'?'darwin':'linux';
if(mode==='foreign-owner'){const uid=process.getuid();process.getuid=()=>uid+1;}
if(mode==='invalid-context')process.env.DSH_TEAM_CI_INVOCATION='invalid-context';
const originalOpen=fs.openSync;
const originalStat=fs.fstatSync;
const originalClose=fs.closeSync;
let selected;
fs.openSync=(path,...args)=>{const fd=originalOpen(path,...args);if(path===file)selected=fd;return fd;};
fs.fstatSync=(fd,...args)=>{
 const info=originalStat(fd,...args);
 if(fd===selected&&mode==='growing')fs.appendFileSync(file,' '.repeat(16385));
 if(fd===selected&&mode==='replaced'){
  fs.renameSync(file,file+'.verified');
  fs.writeFileSync(file,JSON.stringify({NO_PROXY:canary}),{mode:0o644});
 }
 return info;
};
fs.closeSync=fd=>{originalClose(fd);if(fd===selected&&mode==='close-failure')throw new Error(canary);};
syncBuiltinESMExports();
const {dockerProxyEnvironment}=await import(moduleUrl);
function descriptorClosed() {
 if(selected===undefined)return;
 try{originalStat(selected);}catch(error){if(error.code==='EBADF')return;throw error;}
 throw new Error('proxy descriptor remains open');
}
try {
 const selected=dockerProxyEnvironment();
 if(mode==='exact-bound'&&Object.keys(selected).length!==0)throw new Error('unexpected bounded configuration fields');
 if(mode==='replaced'&&selected.NO_PROXY!=='')throw new Error('replacement bytes admitted under predecessor metadata');
 descriptorClosed();
 process.stdout.write('accepted');
} catch(error) {
 descriptorClosed();
 process.stdout.write(error instanceof Error?error.message:'unexpected error');
 process.exitCode=1;
}
`;

async function runHostProxyCase(mode: string) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-proxy-'));
  const canary = `private-${randomUUID()}`;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', scenario, mode, moduleUrl, canary],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH,
          DSH_TEAM_CI_INVOCATION: randomUUID(),
          HTTP_PROXY: `http://${canary}.invalid`,
          HTTPS_PROXY: `http://${canary}.invalid`,
          NO_PROXY: '*',
        },
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 16_384,
      },
    );
    return {
      status: result.status,
      signal: result.signal,
      processError: result.error !== undefined,
      output: result.stdout + result.stderr,
      canary,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it.each([
  'unknown-field',
  'non-string',
  'non-loopback',
  'alternate-ip',
  'scheme',
  'url-path',
  'url-query',
  'whitespace',
  'line-break',
  'invalid-json',
  'array',
  'oversized',
  'invalid-utf8',
  'public-mode',
  'unreadable',
  'close-failure',
  'symlink',
  'directory',
  'fifo',
  'foreign-owner',
  'invalid-context',
  'unsupported-host',
  'growing',
])(
  'rejects %s private proxy configuration without raw evidence or a blocked process',
  async (mode) => {
    const result = await runHostProxyCase(mode);

    expect(result).toMatchObject({
      status: 1,
      signal: null,
      processError: false,
      output: 'Trusted host Docker proxy configuration invalid',
    });
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it.each(['exact-bound', 'replaced'])(
  'accepts %s configuration under the private opened-file contract',
  async (mode) => {
    const result = await runHostProxyCase(mode);

    expect(result).toMatchObject({
      status: 0,
      signal: null,
      processError: false,
      output: 'accepted',
    });
    expect(result.output.includes(result.canary)).toBe(false);
  },
);

it('reports invalid host proxy configuration before root Docker discovery', async () => {
  const result = await runHostProxyCase('root-entry');

  expect(result).toMatchObject({
    status: 1,
    signal: null,
    processError: false,
    output: 'Trusted host Docker proxy configuration invalid\n',
  });
  expect(result.output.includes(result.canary)).toBe(false);
});

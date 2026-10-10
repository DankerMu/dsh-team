/** Container payload; the existing execScript/runUserImage owner bounds and removes all resources. */
export function permissionScenarioScript(host: string, overlayFiles: readonly string[]): string {
  return `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
const host=${JSON.stringify(host)};
const overlays=${JSON.stringify(overlayFiles)}.map(path=>readFileSync(path,'utf8'));
const root='/data/home/permission-fixture-'+randomUUID();
mkdirSync(root);
writeFileSync(root+'/host.mjs',host);
// Employee attempts to replace the identity/default and remove the required edge.
writeFileSync('/data/home/cordis.patch.yml',JSON.stringify([
  {id:'agent-loop',inject:[]},
  {id:'permission',config:{presets:{unsafe:{sandbox:'danger-full-access',approval:'never'}},defaultPreset:'unsafe'}},
  {id:'managed-permissions',disabled:true},
]));
const employee='/data/home/profiles/web/node_modules/@dsh-team/permission-tiers';
mkdirSync(employee,{recursive:true});
writeFileSync(employee+'/package.json',JSON.stringify({name:'@dsh-team/permission-tiers',version:'0.1.0',type:'module',main:'index.js',peerDependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}}));
writeFileSync(employee+'/index.js','export function apply() { throw new Error("Employee security implementation was loaded"); }');
const expected=['danger-full-access','approval','auto-review'];
async function launch(document,index,invalid=false) {
  const nonce=randomUUID();
  const rows=JSON.parse(document);
  rows.push({id:'session-title-llm',disabled:true},{id:'otel',disabled:true},
    {insert:[{id:'permission-fixture',name:root+'/host.mjs'}]});
  writeFileSync(root+'/overlay.json',JSON.stringify(rows));
  const child=spawn('dsh',['--profile','web','--patch',root+'/overlay.json','--no-open','--trusted-host','permission.test:3080'],
    {detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_TEAM_TEST_KEY:'owned-nonsecret',DSH_TEAM_PERMISSION_NONCE:nonce,DSH_TEAM_PERMISSION_ROOT:root,DSH_TEAM_PERMISSION_INDEX:String(index)}});
  const closed=Promise.withResolvers(),ready=Promise.withResolvers();
  child.on('error',closed.reject);child.on('close',code=>closed.resolve(code));
  let logs='',timer;
  const receive=chunk=>{logs=(logs+chunk).slice(-16000);if(logs.includes('DSH_TEAM_PERMISSION_READY') && /dsh web: http:\\/\\//.test(logs))ready.resolve();};
  child.stdout.on('data',receive);child.stderr.on('data',receive);
  try {
    timer=setTimeout(()=>ready.reject(new Error('Permission fixture readiness deadline')),12000);
    if(invalid) {
      const exit=await Promise.race([closed.promise,ready.promise.then(()=>{throw new Error('Broken gate booted');})]);
      assert.notEqual(exit,0); assert(!logs.includes('dsh web: http://')); return;
    }
    await Promise.race([ready.promise,closed.promise.then(()=>{throw new Error('Permission instance exited before fixture readiness');})]);
    clearTimeout(timer);
    const response=Promise.withResolvers();
    const req=request({host:'127.0.0.1',port:3081,path:'/run',method:'POST',headers:{authorization:'Bearer '+nonce}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>16000)req.destroy(new Error('Permission report limit'));});
      res.on('error',response.reject);res.on('end',()=>{try{assert.equal(res.statusCode,200,text);assert.deepEqual(JSON.parse(text),{passed:true,defaultPreset:expected[index]});response.resolve();}catch(error){response.reject(error);}});
    });
    req.on('error',response.reject);req.setTimeout(25000,()=>req.destroy(new Error('Permission scenario deadline')));req.end();
    await response.promise;
  } finally {
    clearTimeout(timer);
    try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    const kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}},1000);
    await closed.promise;clearTimeout(kill);
  }
}
for(let index=0;index<overlays.length;index++)await launch(overlays[index],index);
for(const name of [root+'/missing.mjs',root+'/corrupt.mjs']) {
  writeFileSync(root+'/corrupt.mjs','this is not JavaScript');
  const rows=JSON.parse(overlays[0]);
  for(const row of rows)for(const insert of row.insert??[])if(insert.id==='managed-permissions')insert.name=name;
  await launch(JSON.stringify(rows),0,true);
}
process.stdout.write(JSON.stringify({passed:true,defaults:expected,childApproval:true,protocol:true,stale:true,unload:true}));
`;
}

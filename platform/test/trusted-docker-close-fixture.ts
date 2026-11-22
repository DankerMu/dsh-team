import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { record } from './container-start-docker-fixture.ts';

// Gitignored in the fixture repository, so the reviewed-checkout check never sees the receipt.
const CLOSE_RECEIPT = '.run/close-receipt.json';

/**
 * The post-close-member owner's preload fragment (#658). Only the owner (`own`) counts: it marks
 * the one `pnpm test:docker` child's close before the owner's own handler, then records every
 * negative-pid, signal-0 kill around the unchanged call. A call that returned is a present group;
 * EPERM (a possibly dead Darwin zombie) is not. Each update replaces the whole receipt.
 */
export const CLOSE_RECEIPT_PRELOAD = `import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(process.argv.includes('own')){
  const path=fileURLToPath(new URL(${JSON.stringify(CLOSE_RECEIPT)},import.meta.url));
  const receipt={matches:0,preClosePolls:0,presentPolls:0};
  // A failed write must not reach the product's kill; it shows as a missing or partial receipt.
  const write=()=>{try{mkdirSync(fileURLToPath(new URL('.run/',import.meta.url)),{recursive:true});writeFileSync(path+'.pending',JSON.stringify(receipt));renameSync(path+'.pending',path);}catch{}};
  const hooked=childProcess.spawn;
  childProcess.spawn=(command,args,options)=>{
    const child=hooked(command,args,options);
    if(command==='pnpm'&&args[0]==='test:docker'){receipt.matches+=1;write();child.once('close',()=>{receipt.closedAt=Date.now();write();});}
    return child;
  };
  syncBuiltinESMExports();
  const observed=process.kill;
  process.kill=(pid,signal)=>{
    if(!(pid<0&&signal===0))return observed(pid,signal);
    if(receipt.closedAt===undefined){receipt.preClosePolls+=1;write();return observed(pid,signal);}
    const at=Date.now();
    let present=false;
    try{const value=observed(pid,signal);present=true;return value;}
    finally{if(receipt.firstObservedAt===undefined){receipt.firstObservedAt=at;receipt.firstPresent=present;}if(present)receipt.presentPolls+=1;write();}
  };
}
`;

/**
 * The owner's first post-close group observation saw the group present, no observation preceded
 * close, and the member exited after that first observation. A missing or partial receipt fails.
 */
export function expectMemberOutlivedClose(repository: string, temporary: string) {
  const path = join(repository, CLOSE_RECEIPT);
  if (!existsSync(path))
    throw new Error('Post-close receipt missing: the owner preload wrote none');
  const receipt = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const { matches, closedAt, firstObservedAt, firstPresent, presentPolls, preClosePolls } = receipt;
  const { exited } = record(
    JSON.parse(readFileSync(join(temporary, 'member-exit.json'), 'utf8')) as unknown,
  );
  const scene = JSON.stringify({ ...receipt, exited });
  if (
    typeof matches !== 'number' ||
    typeof closedAt !== 'number' ||
    typeof firstObservedAt !== 'number' ||
    typeof firstPresent !== 'boolean' ||
    typeof presentPolls !== 'number' ||
    typeof preClosePolls !== 'number' ||
    typeof exited !== 'number'
  )
    throw new Error(`Post-close receipt partial: ${scene}`);

  expect(matches, scene).toBe(1);
  expect(preClosePolls, scene).toBe(0);
  expect(closedAt, scene).toBeLessThanOrEqual(firstObservedAt);
  expect(firstPresent, scene).toBe(true);
  expect(presentPolls, scene).toBeGreaterThanOrEqual(1);
  expect(exited, scene).toBeGreaterThan(firstObservedAt);
}

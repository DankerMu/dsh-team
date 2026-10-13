import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { execScript } from './managed-policy-fixture.ts';
import { officeDocxReadScript } from './office-docx-fixture.ts';
import { officeDocxEvidence } from './office-writer-oracle.ts';
import { runUserImage } from './user-image-fixture.ts';

it('distinguishes valid notice DOCX bytes from corrupt and missing files with the image parser', async () => {
  // This parser qualification owns separate Docker resources; it never touches a model acceptance workspace.
  const notice = {
    path: '/data/work/parser-qualification.docx',
    title: '关于会议的通知',
    addressee: '各部门',
    matter: '请于周五参加会议',
    issuer: '办公室',
    date: '2026年10月13日',
  };
  const make = `from docx import Document\nd=Document()\nfor text in ${JSON.stringify([
    notice.title,
    notice.addressee,
    notice.matter,
    notice.issuer,
    notice.date,
  ])}: d.add_paragraph(text)\nd.save(${JSON.stringify(notice.path)})`;
  await runUserImage(
    'managed-policy',
    () => undefined,
    undefined,
    (lifecycle) => {
      const output = execScript(
        lifecycle,
        `dsh-team-test-${lifecycle.runId}-docx-parser`,
        `
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
const made=spawnSync('/usr/bin/python3',['-c',${JSON.stringify(make)}],{encoding:'utf8',timeout:10000});
if(made.status!==0)throw new Error('Parser qualification setup failed');
const observe=()=>{
  const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(officeDocxReadScript(notice.path))}],{encoding:'utf8',timeout:15000,maxBuffer:65536});
  if(r.status!==0)throw new Error('Parser qualification failed');
  return JSON.parse(r.stdout);
};
const expectedHash=createHash('sha256').update(readFileSync(${JSON.stringify(notice.path)})).digest('hex');
const valid=observe();
writeFileSync(${JSON.stringify(notice.path)},'not a DOCX archive');
const corrupt=observe();
unlinkSync(${JSON.stringify(notice.path)});
const missing=observe();
process.stdout.write(JSON.stringify({valid,corrupt,missing,expectedHash}));`,
      );
      const result = record(JSON.parse(output));
      const accepted = officeDocxEvidence(result.valid, notice);
      expect(accepted.sha256).toBe(result.expectedHash);
      expect(record(result.corrupt).status).toBe('unreadable');
      expect(record(result.missing).status).toBe('missing');
      for (const rejected of [result.corrupt, result.missing]) {
        expect(() => officeDocxEvidence(rejected, notice)).toThrow('office-docx-identity');
      }
      return Promise.resolve('Real DOCX parser distinguished valid, corrupt and missing artifacts');
    },
  );
});

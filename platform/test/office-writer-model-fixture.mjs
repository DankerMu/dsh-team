import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureSettledScreenshot,
  clickAllowOnce,
  clickSelector,
  NEW_BTN,
  SEND_BTN,
  typeComposer,
  waitComposer,
  waitFor,
  waitTurnIdle,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { evaluate, physicalClick } from '../../scripts/probe-permission-ui.mjs';
import { officeDocxReadScript } from './office-docx-fixture.ts';
import { officeDocxEvidence, officeTurnEvidence } from './office-writer-oracle.ts';

const SEAT = 'button[aria-haspopup="menu"]:not([aria-label])';
const WRITER = '公文与材料写作';

export async function runOfficeWriterScenario({ page, rpc, exec, evidence }) {
  const marker = `office-notice-${randomUUID()}`;
  const notice = {
    path: `/data/work/${marker}.docx`,
    title: '关于开展消防演练的通知',
    addressee: '研发部全体同事',
    matter: `演练编号：${marker}`,
    issuer: '行政办公室',
    date: '2026年10月13日',
  };
  const prompt = `请制作一份正式的消防演练通知，保存为当前工作目录中的 ${notice.path}，并交付文件。正文须包含标题“${notice.title}”、主送对象“${notice.addressee}”、事项“${notice.matter}”（2026年10月16日下午三点在一楼大厅集合）、落款“${notice.issuer}”和日期“${notice.date}”。保留上述指定文字，其他行文自行组织。需要可打开的 DOCX，不要仅在聊天中给正文。`;
  const report = { path: notice.path, absentBefore: false };
  const observe = () => JSON.parse(exec(officeDocxReadScript(notice.path)));
  try {
    const prior = await rpc('session/list', { _request: {} });
    assert(Array.isArray(prior.items), 'office-session-list');
    const priorIds = new Set(prior.items.map((row) => row.sessionId));
    await clickSelector(page, NEW_BTN);
    await waitComposer(page, 30000);
    await waitFor(
      () =>
        evaluate(
          page,
          `document.querySelector(${JSON.stringify(SEAT)})?.textContent.trim()==='综合办公'`,
        ),
      30000,
      'office-default-seat',
    );
    await physicalClick(page, `document.querySelector(${JSON.stringify(SEAT)})`);
    const option = `[...document.querySelectorAll('[role="menu"] button[role="menuitem"]')].find(el=>!el.disabled&&(el.textContent||'').trim().startsWith(${JSON.stringify(WRITER)}))`;
    await waitFor(() => evaluate(page, `Boolean(${option})`), 30000, 'office-writer-option');
    await captureSettledScreenshot(page, join(evidence, 'office-preset-menu.png'));
    await physicalClick(page, option);
    await waitFor(
      () =>
        evaluate(
          page,
          `document.querySelector(${JSON.stringify(SEAT)})?.textContent.trim()===${JSON.stringify(WRITER)}`,
        ),
      30000,
      'office-writer-seat',
    );
    await captureSettledScreenshot(page, join(evidence, 'office-writer-selected.png'));
    const before = observe();
    assert.equal(before.status, 'missing', 'office-docx-not-fresh');
    assert.throws(() => officeDocxEvidence(before, notice), /office-docx-identity/);
    report.absentBefore = true;
    await writeFile(join(evidence, 'office-docx.json'), JSON.stringify(report));
    await typeComposer(page, prompt);
    await clickSelector(page, SEND_BTN);
    // rc.2 stages the hero choice before a Session exists; observe its committed binding after send.
    const session = await waitFor(
      async () => {
        const listed = await rpc('session/list', { _request: {} });
        const added = listed.items.filter((row) => !priorIds.has(row.sessionId));
        assert(added.length <= 1, 'office-session-ambiguous');
        return added[0]?.projections?.values?.agentPreset === 'office-writer' ? added[0] : false;
      },
      30000,
      'office-writer-binding',
    );
    report.sessionId = session.sessionId;
    let snapshot;
    await waitFor(
      async () => {
        await clickAllowOnce(page, marker);
        const projection = await rpc('session/projections', {
          request: { sessionId: session.sessionId },
        });
        const history = await rpc('session/page', {
          request: {
            address: { kind: 'session', sessionId: session.sessionId },
            throughSeq: projection.asOfSeq,
            maxMessages: 500,
          },
        });
        snapshot = {
          records: history.records,
          hasMore: history.hasMore,
          cursor: projection.asOfSeq,
          preset: projection.values.agentPreset,
          prompt,
        };
        return history.records.some(({ event }) => event.type === 'turn/end');
      },
      300000,
      'office-native-turn-end',
    );
    report.turn = officeTurnEvidence(snapshot);
    await waitTurnIdle(page, 30000, 'office-browser-turn-idle');
    report.docx = officeDocxEvidence(observe(), notice);
    await captureSettledScreenshot(page, join(evidence, 'office-docx-completed.png'));
    await writeFile(join(evidence, 'office-docx.json'), JSON.stringify(report));
  } catch (error) {
    report.failure = /^office-[a-z-]+$/.test(error.message)
      ? error.message
      : 'office-scenario-failed';
    await writeFile(join(evidence, 'office-docx.json'), JSON.stringify(report));
    await captureSettledScreenshot(page, join(evidence, 'office-failure.png'));
    throw error;
  }
}

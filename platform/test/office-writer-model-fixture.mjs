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
import {
  officeChildReady,
  officeDocxEvidence,
  officeTurnEvidence,
} from './office-writer-oracle.ts';

const SEAT = 'button[aria-haspopup="menu"]:not([aria-label])';
const WRITER = '公文与材料写作';

async function officeSnapshot(rpc, sessionId, address = { kind: 'session', sessionId }, child) {
  const projection = await rpc('session/projections', { request: { sessionId } });
  if (child && !officeChildReady(projection.values.subagent, child.agentAvailable)) return false;
  // A child address names the mode its native descriptor declares.
  const target = child ? { ...address, mode: projection.values.subagent.mode } : address;
  const history = await rpc('session/page', {
    request: { address: target, throughSeq: projection.asOfSeq, maxMessages: 500 },
  });
  return {
    records: history.records,
    hasMore: history.hasMore,
    cursor: projection.asOfSeq,
    preset: projection.values.agentPreset,
    catalog: projection.values.subagentCatalog,
    identity: projection.values.subagent,
  };
}

async function delegatedSnapshot(rpc, parent, priorIds, prompt, report) {
  const parentHistory = await officeSnapshot(rpc, parent.sessionId);
  const listed = await rpc('session/list', { _request: {} });
  const children = listed.items.filter((row) => row.parentSessionId === parent.sessionId);
  const tools = {
    subagent: 0,
    bash: 0,
    write: 0,
    edit: 0,
    skill: 0,
    read: 0,
    jobs: 0,
    present: 0,
    other: 0,
  };
  for (const { event } of parentHistory.records) {
    if (event.type !== 'tool/call') continue;
    const key = Object.hasOwn(tools, event.data.name) ? event.data.name : 'other';
    tools[key]++;
  }
  report.delegationState = {
    parentGeneral: parentHistory.preset === 'office-general',
    parentCursor: parentHistory.cursor,
    parentHasMore: parentHistory.hasMore,
    parentCompleted: parentHistory.records.some(
      ({ event }) => event.type === 'turn/end' && event.data.reason.kind === 'completed',
    ),
    catalogCount: Array.isArray(parentHistory.catalog) ? parentHistory.catalog.length : -1,
    derivedCount: children.length,
    tools,
  };
  assert(children.length <= 1, 'office-child-ambiguous');
  const child = children[0];
  if (!child) return false;
  assert(!priorIds.has(child.sessionId), 'office-child-not-fresh');
  const call = parentHistory.records.find(
    ({ event }) => event.type === 'tool/call' && event.data.name === 'subagent',
  );
  if (!call) return false;
  const args = JSON.parse(call.event.data.arguments);
  assert(typeof args.prompt === 'string', 'office-delegation-prompt');
  const snapshot = await officeSnapshot(
    rpc,
    child.sessionId,
    {
      kind: 'subagent',
      parentSessionId: parent.sessionId,
      childSessionId: child.sessionId,
    },
    child,
  );
  if (!snapshot) return false;
  return {
    ...snapshot,
    prompt: args.prompt,
    delegation: {
      parent: { ...parentHistory, sessionId: parent.sessionId, cwd: parent.cwd, prompt },
      child,
      identity: snapshot.identity,
    },
  };
}

async function failureDocx(observe, notice) {
  try {
    return officeDocxEvidence(await observe(), notice);
  } catch {
    return { valid: false };
  }
}

function contributionSummary(contribution, nonce, parentId, childId) {
  const proof = contribution ?? {};
  const receipt = proof.receipt ?? {};
  const artifact = proof.artifact ?? {};
  return {
    nonceMatches: proof.nonce === nonce,
    parentMatches: proof.parentId === parentId,
    childMatches: proof.childId === childId,
    callId: proof.callId,
    callSeq: proof.callSeq,
    resultSeq: proof.resultSeq,
    turn: proof.turn,
    step: proof.step,
    receiptPath: receipt.path,
    receiptSha256: receipt.sha256,
    artifactSha256: artifact.sha256,
    parsedAtConstruction: artifact.status === 'parsed',
  };
}

export async function runOfficeWriterScenario({ page, rpc, exec, evidence, mode, observer }) {
  const delegated = mode === 'delegated';
  const prefix = delegated ? 'office-delegation' : 'office-docx';
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
  const observe = async () => JSON.parse(await exec(officeDocxReadScript(notice.path)));
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
    if (!delegated) {
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
    } else {
      await captureSettledScreenshot(page, join(evidence, 'office-general-selected.png'));
    }
    const before = await observe();
    assert.equal(before.status, 'missing', 'office-docx-not-fresh');
    assert.throws(() => officeDocxEvidence(before, notice), /office-docx-identity/);
    report.absentBefore = true;
    if (delegated) {
      assert(observer, 'office-observer-required');
      await observer.arm({ nonce: marker, reader: officeDocxReadScript(notice.path) });
    }
    await writeFile(join(evidence, `${prefix}.json`), JSON.stringify(report));
    await typeComposer(page, prompt);
    await clickSelector(page, SEND_BTN);
    // rc.2 stages the hero choice before a Session exists; observe its committed binding after send.
    const session = await waitFor(
      async () => {
        const listed = await rpc('session/list', { _request: {} });
        const added = listed.items.filter(
          (row) => !priorIds.has(row.sessionId) && row.origin !== 'subagent',
        );
        assert(added.length <= 1, 'office-session-ambiguous');
        return added[0]?.projections?.values?.agentPreset ===
          (delegated ? 'office-general' : 'office-writer')
          ? added[0]
          : false;
      },
      30000,
      'office-writer-binding',
    );
    report.sessionId = session.sessionId;
    let snapshot;
    await waitFor(
      async () => {
        await clickAllowOnce(page, marker);
        snapshot = delegated
          ? await delegatedSnapshot(rpc, session, priorIds, prompt, report)
          : { ...(await officeSnapshot(rpc, session.sessionId)), prompt };
        if (!snapshot) return false;
        const completed = snapshot.records.some(({ event }) => event.type === 'turn/end');
        return (
          completed &&
          (!delegated ||
            snapshot.delegation.parent.records.some(({ event }) => event.type === 'turn/end'))
        );
      },
      300000,
      'office-native-turn-end',
    );
    report.native = {
      preset: snapshot.preset,
      cursor: snapshot.cursor,
      hasMore: snapshot.hasMore,
      counts: Object.fromEntries(
        ['agent-preset/selected', 'turn/start', 'user/message', 'tool/call', 'turn/end'].map(
          (type) => [type, snapshot.records.filter(({ event }) => event.type === type).length],
        ),
      ),
    };
    if (delegated) {
      const contribution = await observer.observation();
      report.contribution = contributionSummary(
        contribution,
        marker,
        session.sessionId,
        snapshot.delegation.child.sessionId,
      );
      snapshot.delegation = {
        ...snapshot.delegation,
        nonce: marker,
        notice,
        contribution,
      };
    }
    report.turn = officeTurnEvidence(snapshot);
    await waitTurnIdle(page, 30000, 'office-browser-turn-idle');
    report.docx = officeDocxEvidence(await observe(), notice);
    await captureSettledScreenshot(page, join(evidence, `${prefix}-completed.png`));
    await writeFile(join(evidence, `${prefix}.json`), JSON.stringify(report));
  } catch (error) {
    report.failure = /^office-[a-z-]+$/.test(error.message)
      ? error.message
      : 'office-scenario-failed';
    report.failureDocx = await failureDocx(observe, notice);
    await writeFile(join(evidence, `${prefix}.json`), JSON.stringify(report));
    await captureSettledScreenshot(page, join(evidence, `${prefix}-failure.png`));
    throw error;
  }
}

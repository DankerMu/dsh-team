import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { mappedRpc, navigateReady } from '../../scripts/probe-mapped-host.mjs';
import {
  captureSettledScreenshot,
  clickSelector,
  SEND_BTN,
  typeComposer,
  waitComposer,
  waitFor,
  waitTurnIdle,
} from '../../scripts/probe-dsh-api-ui.mjs';
import { attachScopeObserver } from '../../scripts/probe-session-address.mjs';
import {
  chosenLabel,
  clickSessionTitle,
  evaluate,
  PANEL,
  physicalClick,
  selectTier,
} from '../../scripts/probe-permission-ui.mjs';
import { permissionEvidence } from './permission-model-oracle.ts';

export async function runPermissionModelScenario({ page, origin, cookie, evidence, observe }) {
  const report = { selections: [], addresses: [], checkpoints: [] };
  try {
    attachScopeObserver(page, report);
    // Native Session rows are hidden by the narrow-screen navigation layout.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const rpc = async (method, payload) => {
      report.lastRpc = method;
      const result = await mappedRpc(origin, cookie, method, payload);
      if (!result.ok) throw new Error('permission-native-rpc');
      return result.value;
    };
    const history = async (sessionId) => {
      const projection = await rpc('session/projections', { request: { sessionId } });
      const value = await rpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: projection.asOfSeq,
          maxMessages: 100,
        },
      });
      if (
        !Array.isArray(value.records) ||
        value.hasMore !== false ||
        value.records.length !== projection.asOfSeq + 1 ||
        value.records.some((row, index) => row.event.seq !== index)
      )
        throw new Error('permission-history-incomplete');
      return {
        records: value.records,
        cursor: projection.asOfSeq,
        hasMore: value.hasMore,
        tier: projection.values.permissions.currentValue,
      };
    };
    const listed = await rpc('session/list', { _request: {} });
    assert.equal(listed.items.length, 1, 'one onboarding Session');
    const first = { sessionId: listed.items[0].sessionId, title: 'Real manual approval' };
    const second = {
      ...(await rpc('session/create', { request: { cwd: '/data/work', agentPreset: 'standard' } })),
      title: 'Real Yolo permission',
    };
    // Give the new native Session a real user turn so it appears in the ordinary sidebar.
    const initialized = await rpc('session/prompt', {
      request: {
        sessionId: second.sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: 'Reply READY. Do not call any tools.' }],
      },
    });
    assert.equal(initialized.accepted, true);
    await waitFor(
      async () => {
        const value = await history(second.sessionId);
        return value.records.some(
          ({ event }) => event.type === 'turn/end' && event.data.reason.kind === 'completed',
        );
      },
      300000,
      'permission-real-session-initialization',
    );
    for (const session of [first, second]) await rpc('session/rename', { request: session });
    await navigateReady(page, origin, 30000, true);
    await waitComposer(page, 30000);
    const select = async (session) =>
      clickSessionTitle(page, session.title, report, {
        kind: 'session',
        sessionId: session.sessionId,
      });
    await select(second);
    await selectTier(page, '人工批准', join(evidence, 'yolo-before-selection.png'), report);
    await selectTier(page, 'Yolo', join(evidence, 'yolo-selected.png'), report);
    await select(first);
    await selectTier(page, '人工批准', join(evidence, 'manual-selected.png'), report);

    const begin = async (session, label) => {
      const path = `/data/work/permission-${label}-${randomUUID()}.txt`;
      const content = `Real permission proof ${randomUUID()}`;
      const before = await history(session.sessionId);
      assert.deepEqual(observe(path, content), { exists: false, exact: false });
      const prompt = `Use the write tool exactly once with file_path ${JSON.stringify(path)} and content ${JSON.stringify(content)} (no newline). Do not use bash, run_code, or other tools. If the user rejects, stop and explain the rejection; do not retry or work around it. After the tool result, reply briefly.`;
      await waitComposer(page, 30000);
      await typeComposer(page, prompt);
      await clickSelector(page, SEND_BTN);
      return { sessionId: session.sessionId, path, content, prompt, afterSeq: before.cursor };
    };
    const sample = async (operation) => ({
      ...(await history(operation.sessionId)),
      ...operation,
      file: observe(operation.path, operation.content),
    });
    const retain = async (operation, phase) => {
      const value = await sample(operation);
      const proof = permissionEvidence({ ...value, phase });
      report.checkpoints.push({ sessionId: operation.sessionId, ...proof, file: value.file });
      await writeFile(join(evidence, 'permissions.json'), JSON.stringify(report));
      return proof;
    };
    const pending = async (operation, label) => {
      await waitFor(
        async () => {
          const value = await sample(operation);
          const events = value.records
            .filter(({ event }) => event.seq > operation.afterSeq)
            .map(({ event }) => event);
          if (events.some((event) => event.type === 'turn/end') || value.file.exists)
            throw new Error('permission-write-before-approval');
          return events.some((event) => event.type === 'approval/asked');
        },
        300000,
        'permission-pending-native-ask',
      );
      const proof = await retain(operation, 'pending');
      const key = await waitFor(
        () =>
          evaluate(
            page,
            `document.querySelector(${JSON.stringify(PANEL)})?.getAttribute('data-approval-key')`,
          ),
        30000,
        'permission-native-panel',
      );
      assert.equal(
        await evaluate(page, `document.querySelectorAll(${JSON.stringify(PANEL)}).length`),
        1,
      );
      assert.equal(
        await evaluate(
          page,
          `document.body.innerText.includes(${JSON.stringify(operation.path.split('/').at(-1))})`,
        ),
        true,
      );
      await captureSettledScreenshot(page, join(evidence, `${label}-pending.png`));
      return { proof, key };
    };
    const finish = async (operation, phase) => {
      await waitFor(
        async () => {
          const value = await sample(operation);
          const events = value.records
            .filter(({ event }) => event.seq > operation.afterSeq)
            .map(({ event }) => event);
          if (phase === 'yolo' && events.some((event) => event.type.startsWith('approval/')))
            throw new Error('permission-yolo-asked');
          if (
            events.filter((event) => event.type === 'approval/asked').length >
            (phase === 'yolo' ? 0 : 1)
          )
            throw new Error('permission-extra-approval');
          return events.some((event) => event.type === 'turn/end');
        },
        300000,
        'permission-native-turn-end',
      );
      await waitTurnIdle(page, 30000, 'permission-browser-turn-idle');
      await retain(operation, phase);
      await captureSettledScreenshot(page, join(evidence, `${phase}-completed.png`));
    };
    const decide = async (action) =>
      physicalClick(
        page,
        `[...document.querySelectorAll(${JSON.stringify(PANEL + ' button')})].find(el=>${JSON.stringify(action === 'allow' ? ['允许一次', 'Allow once'] : ['拒绝', 'Reject'])}.includes(el.textContent.trim())&&!el.disabled)`,
      );

    const manual = await begin(first, 'allow');
    const original = await pending(manual, 'allow');
    await select(second);
    assert.equal(await chosenLabel(page), 'Yolo');
    const yolo = await begin(second, 'yolo');
    await finish(yolo, 'yolo');
    const held = await retain(manual, 'pending');
    assert.equal(held.approvalId, original.proof.approvalId);
    assert.equal(held.callId, original.proof.callId);
    assert.equal(held.askedSeq, original.proof.askedSeq);
    await select(first);
    assert.equal(await chosenLabel(page), '人工批准');
    const returned = await pending(manual, 'returned-manual');
    assert.equal(returned.key, original.key);
    await decide('allow');
    await finish(manual, 'allow');
    const denied = await begin(first, 'deny');
    await pending(denied, 'deny');
    await decide('deny');
    await finish(denied, 'deny');
    assert.equal((await history(second.sessionId)).tier, 'danger-full-access');
    assert.equal((await history(first.sessionId)).tier, 'approval');
  } catch (error) {
    // Persist only fixed diagnostic vocabulary, never raw model/transport errors or history.
    report.failure = /^permission-[a-z-]+$/.test(error.message)
      ? error.message
      : 'permission-scenario-failed';
    await writeFile(join(evidence, 'permissions.json'), JSON.stringify(report));
    await captureSettledScreenshot(page, join(evidence, 'permission-failure.png'));
    throw error;
  }
}

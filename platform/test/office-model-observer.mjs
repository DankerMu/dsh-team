import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const name = 'dsh-team-office-model-proof';

function pairKey(turn, step, callId) {
  return JSON.stringify([turn, step, callId]);
}

function trackChildLifecycle(state, event) {
  const data = event.data;
  switch (event.type) {
    case 'subagent/descriptor':
      // Mode-agnostic: DSH 0.2.1 in-process spawn children are continuable.
      state.eligible = data.provider === 'spawn';
      break;
    case 'agent-preset/selected':
      state.writer = data.agentPreset === 'office-writer';
      break;
    case 'turn/start':
      state.calls.clear();
      state.turn = data.turn;
      state.promptSeq = undefined;
      break;
    case 'turn/end':
      state.calls.clear();
      state.turn = undefined;
      break;
    case 'user/message':
      if (data.source?.kind === 'user') state.promptSeq = event.seq;
      break;
  }
}

function trackConstructionCall(state, event) {
  const data = event.data;
  if (
    !state.eligible ||
    !state.writer ||
    data.name !== 'build_docx' ||
    data.turn !== state.turn ||
    !Number.isSafeInteger(data.turn) ||
    !Number.isSafeInteger(data.step) ||
    data.step < 0 ||
    typeof data.callId !== 'string' ||
    data.callId.length === 0 ||
    !(event.seq > state.promptSeq)
  )
    return;
  const key = pairKey(data.turn, data.step, data.callId);
  if (state.calls.has(key)) throw new Error('office-observation-ambiguous');
  state.calls.set(key, event.seq);
}

function successfulConstructionResult(data) {
  return (
    data.message.isError !== true &&
    data.error === undefined &&
    data.meta !== null &&
    typeof data.meta === 'object' &&
    !Array.isArray(data.meta)
  );
}

function consumeConstructionResult(state, event) {
  const data = event.data;
  const message = data.message;
  if (
    !state.eligible ||
    !state.writer ||
    data.turn !== state.turn ||
    message?.role !== 'tool' ||
    message.source?.kind !== 'tool' ||
    message.source.callId !== message.toolCallId
  )
    return;
  const key = pairKey(data.turn, data.step, message.toolCallId);
  const callSeq = state.calls.get(key);
  if (callSeq === undefined || !(event.seq > callSeq)) return;
  state.calls.delete(key);
  return successfulConstructionResult(data) ? callSeq : undefined;
}

export function apply(ctx, { control, evidence }) {
  let sessions = new WeakMap();
  let armedNonce;
  let taskParent;
  let reader;
  let captured = false;
  let failed = false;
  const save = (value) => writeFileSync(evidence, JSON.stringify(value), { mode: 0o600 });
  const observe = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', reader], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    });
    if (result.error || result.status !== 0) throw new Error('office-observation-reader');
    return JSON.parse(result.stdout);
  };
  const arm = (session, event) => {
    if (
      event.type !== 'user/message' ||
      session.header.origin === 'subagent' ||
      event.data.source?.kind !== 'user'
    )
      return;
    const config = JSON.parse(readFileSync(control, 'utf8'));
    if (!config.nonce || config.nonce === armedNonce) return;
    armedNonce = config.nonce;
    taskParent = session.header.id;
    sessions = new WeakMap();
    captured = false;
    failed = false;
    if (typeof config.reader !== 'string' || config.reader.length > 8192) {
      throw new Error('office-observation-reader');
    }
    reader = config.reader;
    save({ ready: true });
  };
  const captureConstruction = (session, state, event) => {
    const callSeq = consumeConstructionResult(state, event);
    if (callSeq === undefined) return;
    const data = event.data;
    // Session.append publishes this event synchronously after commit. Read
    // before returning to the agent loop, not from an unawaited async hook.
    // Select the first successful construction of the reader's target.
    // The oracle validates this candidate against its durable event.
    const artifact = observe();
    if (artifact?.path !== data.meta.path) return;
    save({
      nonce: armedNonce,
      parentId: taskParent,
      childId: session.header.id,
      callSeq,
      resultSeq: event.seq,
      callId: data.message.toolCallId,
      turn: data.turn,
      step: data.step,
      receipt: data.meta,
      artifact,
    });
    captured = true;
  };
  save({ ready: true });
  ctx.on('session/event', (session, event) => {
    try {
      arm(session, event);
      if (
        failed ||
        captured ||
        !armedNonce ||
        session.header.origin !== 'subagent' ||
        session.header.parentSession !== taskParent
      )
        return;
      // Session identity is authoritative: a replay or another object with the
      // same header ID cannot supply the result for this live Session's call.
      let state = sessions.get(session);
      if (!state) {
        // The creation header names the preset. DSH 0.2.1 commits the creation selection and
        // descriptor before the child Session is published, so no session/event carries them:
        // fold the committed prefix once.
        state = { calls: new Map(), writer: session.header.agentPreset === 'office-writer' };
        for (const prior of session.snapshotEvents(0, event.seq)) trackChildLifecycle(state, prior);
        sessions.set(session, state);
      }
      if (event.type === 'tool/call') {
        trackConstructionCall(state, event);
      } else if (event.type === 'tool/result') {
        captureConstruction(session, state, event);
      } else {
        trackChildLifecycle(state, event);
      }
    } catch {
      failed = true;
      save({ failure: 'office-observation-failed' });
    }
  });
}

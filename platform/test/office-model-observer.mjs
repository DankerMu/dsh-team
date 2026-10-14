import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const name = 'dsh-team-office-model-proof';
const READ_ONLY_PARENT_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'skill',
  'present',
  'jobs',
  'subagent',
]);

export function apply(ctx, { control, evidence }) {
  const active = new Map();
  let checkpoint;
  let armedNonce;
  let taskParent;
  let parentMayWrite = false;
  const save = (value) => writeFileSync(evidence, JSON.stringify(value), { mode: 0o600 });
  const observe = (script) => {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
    });
    if (result.error || result.status !== 0) throw new Error('office-observation-reader');
    return JSON.parse(result.stdout);
  };
  // Only delegation and native job coordination may overlap attribution. Arbitrary
  // bash (even named read-only by the model) is not proof of a read-only operation.
  const mayWrite = (call, childId) =>
    call.sessionId !== childId && call.name !== 'subagent' && call.name !== 'jobs';
  const observeParent = (session, event) => {
    if (
      event.type !== 'user/message' ||
      session.header.origin === 'subagent' ||
      event.data.source?.kind !== 'user'
    )
      return;
    const config = JSON.parse(readFileSync(control, 'utf8'));
    if (config.nonce && config.nonce !== armedNonce) {
      armedNonce = config.nonce;
      taskParent = session.header.id;
      parentMayWrite = false;
    }
  };
  const trackTools = (sessionId, event) => {
    if (event.type === 'tool/call') {
      const call = { sessionId, name: event.data.name };
      active.set(`${sessionId}:${event.data.callId}`, call);
      // Returning from bash does not prove its descendants have exited. Clear
      // historical ambiguity only with a quiet owned PID namespace below.
      if (sessionId === taskParent && !READ_ONLY_PARENT_TOOLS.has(call.name)) parentMayWrite = true;
      if (checkpoint && checkpoint.endSeq === undefined && mayWrite(call, checkpoint.childId)) {
        checkpoint.confounded = true;
      }
    } else if (event.type === 'tool/result') {
      active.delete(`${sessionId}:${event.data.message.toolCallId}`);
    }
  };
  const startCheckpoint = (session, event) => {
    const config = JSON.parse(readFileSync(control, 'utf8'));
    if (!config.nonce) return;
    if (checkpoint?.nonce === config.nonce) throw new Error('office-observation-ambiguous');
    if (typeof config.reader !== 'string' || config.reader.length > 8192) {
      throw new Error('office-observation-reader');
    }
    const earlierParentWork = session.header.parentSession === taskParent && parentMayWrite;
    // This observer runs inside the owned DSH container, not on the host. PID1
    // plus no other process rules out surviving shell descendants, even when
    // their foreground command/job has already returned. Unsupported topology
    // stays ambiguous. Read before spawning our own trusted document reader.
    const processesQuiet =
      earlierParentWork &&
      process.platform === 'linux' &&
      process.pid === 1 &&
      readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .every((entry) => entry === '1');
    checkpoint = {
      nonce: config.nonce,
      parentId: session.header.parentSession,
      childId: session.header.id,
      startSeq: event.seq,
      reader: config.reader,
      earlierParentWork,
      processesQuiet,
      confounded:
        (earlierParentWork && !processesQuiet) ||
        [...active.values()].some((call) => mayWrite(call, session.header.id)),
      before: observe(config.reader),
    };
  };
  save({ ready: true });
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session.header.id;
      observeParent(session, event);
      trackTools(sessionId, event);
      if (event.type === 'turn/start' && session.header.origin === 'subagent') {
        startCheckpoint(session, event);
      }
      if (event.type === 'turn/end') {
        if (checkpoint?.childId === sessionId) {
          // Released Session.append invokes session/event observers synchronously.
          // Capture before the native driver can return to its parent, not on a timer.
          const after = observe(checkpoint.reader);
          checkpoint.endSeq = event.seq;
          const proof = { ...checkpoint };
          delete proof.reader;
          save({ ...proof, after });
        }
        for (const [key, call] of active) {
          if (call.sessionId === sessionId) active.delete(key);
        }
      }
    } catch {
      save({ failure: 'office-observation-failed' });
    }
  });
}

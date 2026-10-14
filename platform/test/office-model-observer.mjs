import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const name = 'dsh-team-office-model-proof';

export function apply(ctx, { control, evidence }) {
  const active = new Map();
  let checkpoint;
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
  const startCheckpoint = (session, event) => {
    const config = JSON.parse(readFileSync(control, 'utf8'));
    if (!config.nonce) return;
    if (checkpoint?.nonce === config.nonce) throw new Error('office-observation-ambiguous');
    if (typeof config.reader !== 'string' || config.reader.length > 8192) {
      throw new Error('office-observation-reader');
    }
    checkpoint = {
      nonce: config.nonce,
      parentId: session.header.parentSession,
      childId: session.header.id,
      startSeq: event.seq,
      reader: config.reader,
      confounded: [...active.values()].some((call) => mayWrite(call, session.header.id)),
      before: observe(config.reader),
    };
  };
  save({ ready: true });
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session.header.id;
      if (event.type === 'tool/call') {
        const call = { sessionId, name: event.data.name };
        active.set(`${sessionId}:${event.data.callId}`, call);
        if (checkpoint && checkpoint.endSeq === undefined && mayWrite(call, checkpoint.childId)) {
          checkpoint.confounded = true;
        }
      } else if (event.type === 'tool/result') {
        active.delete(`${sessionId}:${event.data.message.toolCallId}`);
      }
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

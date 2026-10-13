import { record } from './container-start-docker-fixture.ts';

interface PermissionObservation {
  records: readonly unknown[];
  cursor: number;
  hasMore: boolean;
  tier: string;
  expectedTier: string;
  afterSeq: number;
  prompt: string;
  path: string;
  content: string;
  phase: 'pending' | 'allow' | 'deny' | 'unprompted';
  file: { exists: boolean; exact: boolean };
}

function requireEvidence(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`permission-${reason}`);
}

type Event = Record<string, unknown>;
const of = (events: readonly Event[], type: string) =>
  events.filter((event) => event.type === type);

function one(events: readonly Event[], reason: string): Event {
  const event = events[0];
  requireEvidence(events.length === 1 && event !== undefined, reason);
  return event;
}

function writeIdentity(events: readonly Event[], input: PermissionObservation) {
  const start = one(of(events, 'turn/start'), 'turn-call-count');
  const call = one(of(events, 'tool/call'), 'turn-call-count');
  const data = record(call.data);
  const turn = record(start.data).turn;
  const args = record(JSON.parse(String(data.arguments)));
  requireEvidence(
    data.turn === turn &&
      data.name === 'write' &&
      typeof data.callId === 'string' &&
      args.file_path === input.path &&
      args.content === input.content &&
      Number(call.seq) > Number(start.seq),
    'intended-write',
  );
  return { start, call, turn, callId: data.callId };
}

function promptIdentity(
  events: readonly Event[],
  input: PermissionObservation,
  start: Event,
  call: Event,
) {
  const event = one(
    of(events, 'user/message').filter((row) => record(record(row.data).source).kind === 'user'),
    'prompt-count',
  );
  const prompt = record(event.data);
  const source = record(prompt.source);
  requireEvidence(
    typeof source.rpcId === 'string' &&
      source.rpcId.length > 0 &&
      Array.isArray(prompt.content) &&
      prompt.content.some(
        (part: unknown) => record(part).type === 'text' && record(part).text === input.prompt,
      ) &&
      Number(event.seq) > Number(start.seq) &&
      Number(event.seq) < Number(call.seq),
    'prompt-identity',
  );
  return source.rpcId;
}

function approvalEvidence(events: readonly Event[], input: PermissionObservation, call: Event) {
  const unprompted = input.phase === 'unprompted';
  const asked = of(events, 'approval/asked');
  const decided = of(events, 'approval/decided');
  requireEvidence(asked.length === (unprompted ? 0 : 1), 'approval-count');
  const ask = asked[0];
  if (ask)
    requireEvidence(
      record(ask.data).callId === record(call.data).callId &&
        record(ask.data).toolName === 'write' &&
        typeof record(ask.data).id === 'string' &&
        Number(ask.seq) > Number(call.seq),
      'approval-identity',
    );
  if (input.phase === 'pending') {
    requireEvidence(
      decided.length === 0 &&
        of(events, 'tool/result').length === 0 &&
        of(events, 'turn/end').length === 0,
      'pending-settled',
    );
    return { ask, decision: undefined };
  }
  requireEvidence(decided.length === (unprompted ? 0 : 1), 'decision-count');
  const decision = decided[0];
  if (ask && decision)
    requireEvidence(
      record(decision.data).id === record(ask.data).id &&
        record(decision.data).outcome === (input.phase === 'deny' ? 'rejected' : 'allowed-once') &&
        Number(decision.seq) > Number(ask.seq),
      'decision',
    );
  return { ask, decision };
}

function resultEvidence(
  events: readonly Event[],
  input: PermissionObservation,
  identity: ReturnType<typeof writeIdentity>,
  predecessor: Event,
) {
  const result = one(of(events, 'tool/result'), 'tool-result');
  const message = record(record(result.data).message);
  requireEvidence(
    record(result.data).turn === identity.turn &&
      message.role === 'tool' &&
      message.toolCallId === identity.callId &&
      record(message.source).callId === identity.callId &&
      record(message.source).kind === 'tool' &&
      (message.isError === true) === (input.phase === 'deny') &&
      Number(result.seq) > Number(predecessor.seq),
    'tool-result',
  );
  const end = one(of(events, 'turn/end'), 'turn-completion');
  requireEvidence(
    record(end.data).turn === identity.turn &&
      record(record(end.data).reason).kind === 'completed' &&
      Number(end.seq) > Number(result.seq),
    'turn-completion',
  );
  requireEvidence(
    of(events, 'assistant/message').some(
      (event) =>
        record(event.data).turn === identity.turn &&
        Number(event.seq) > Number(result.seq) &&
        Number(event.seq) < Number(end.seq),
    ),
    'agent-continuation',
  );
  return end.seq;
}

export function permissionEvidence(input: PermissionObservation) {
  const all = input.records.map((row) => record(record(row).event));
  requireEvidence(
    !input.hasMore &&
      all.length === input.cursor + 1 &&
      all.every((event, index) => event.seq === index),
    'history-incomplete',
  );
  const events = all.filter((event) => Number(event.seq) > input.afterSeq);
  // Released retries retain failed/uncommitted attempts even if the turn later succeeds.
  requireEvidence(of(events, 'assistant/attempt').length === 0, 'provider-attempt');
  const identity = writeIdentity(events, input);
  const requestId = promptIdentity(events, input, identity.start, identity.call);
  requireEvidence(input.tier === input.expectedTier, 'tier');
  const written = input.phase === 'allow' || input.phase === 'unprompted';
  requireEvidence(input.file.exists === written && input.file.exact === written, 'file-state');
  const { ask, decision } = approvalEvidence(events, input, identity.call);
  const terminalSeq =
    input.phase === 'pending'
      ? null
      : resultEvidence(events, input, identity, decision ?? identity.call);
  return {
    requestId,
    turn: identity.turn,
    callId: identity.callId,
    approvalId: ask ? record(ask.data).id : null,
    askedSeq: ask?.seq ?? null,
    terminalSeq,
    cursor: input.cursor,
    phase: input.phase,
  };
}

interface AutoReviewExpectation {
  nonce: string;
  sessionId: string;
  callId: string;
  provider: string;
  model: string;
  mode: 'observe' | 'unavailable';
}

function reviewIdentity(value: unknown, expected: AutoReviewExpectation) {
  const observed = record(value);
  requireEvidence(
    observed.nonce === expected.nonce &&
      observed.overflow === false &&
      Array.isArray(observed.reviews),
    'auto-observation',
  );
  const row = one(observed.reviews.map(record), 'auto-count');
  requireEvidence(
    row.sessionId === expected.sessionId &&
      row.callId === expected.callId &&
      row.provider === expected.provider &&
      row.model === expected.model &&
      row.mode === expected.mode,
    'auto-identity',
  );
  requireEvidence(
    Number.isSafeInteger(row.started) &&
      Number.isSafeInteger(row.settled) &&
      Number.isSafeInteger(row.gated) &&
      Number(row.started) < Number(row.settled) &&
      Number(row.settled) < Number(row.gated),
    'auto-order',
  );
  return row;
}

export function autoReviewEvidence(value: unknown, expected: AutoReviewExpectation) {
  const row = reviewIdentity(value, expected);
  const fault = expected.mode === 'unavailable';
  requireEvidence(
    row.forwarded === !fault &&
      row.completed === !fault &&
      row.faultInjected === fault &&
      row.finish === (fault ? null : 'stop') &&
      row.decision === (fault ? null : 'allow') &&
      row.gate === (fault ? 'ask' : 'allow'),
    'auto-outcome',
  );
  return {
    sessionId: expected.sessionId,
    callId: expected.callId,
    mode: expected.mode,
    forwarded: row.forwarded,
    completed: row.completed,
    faultInjected: row.faultInjected,
    finish: row.finish,
    decision: row.decision,
    gate: row.gate,
  };
}

import { record } from './container-start-docker-fixture.ts';

interface PermissionBase {
  records: readonly unknown[];
  cursor: number;
  hasMore: boolean;
  tier: string;
  expectedTier: string;
  afterSeq: number;
  prompt: string;
  phase: 'pending' | 'allow' | 'deny' | 'unprompted';
}

interface PermissionObservation extends PermissionBase {
  path: string;
  content: string;
  file: { exists: boolean; exact: boolean };
}

interface BashObservation extends PermissionBase {
  command: string;
  phase: 'unprompted';
}

type NativeObservation = PermissionObservation | BashObservation;

class PermissionEvidenceError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(reason: string, detail: string | null = null) {
    super(`permission-${reason}`);
    this.code = this.message;
    this.detail = detail;
  }
}

/** Only locally constructed oracle errors can supply public diagnostics; never echo unknown errors. */
export function permissionFailure(error: unknown): { code: string; detail: string | null } {
  return error instanceof PermissionEvidenceError
    ? { code: error.code, detail: error.detail }
    : { code: 'unclassified', detail: null };
}

const BASH_FAILURE_MARKERS = [
  ['[exit code:', 'nonzero-exit'],
  ['[killed by signal:', 'signal'],
  ['[timed out after ', 'timeout'],
  ['[stopped:', 'stopped'],
  ['[output truncated;', 'truncated'],
  ['[stderr]', 'stderr'],
  ['started background job ', 'background'],
  ['[still running after ', 'promoted'],
] as const;

function requireEvidence(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new PermissionEvidenceError(reason);
}

type Event = Record<string, unknown>;
const of = (events: readonly Event[], type: string) =>
  events.filter((event) => event.type === type);

function one(events: readonly Event[], reason: string): Event {
  const event = events[0];
  requireEvidence(events.length === 1 && event !== undefined, reason);
  return event;
}

interface ToolIdentity {
  start: Event;
  call: Event;
  turn: unknown;
  callId: string;
}

function requireBashIdentity(
  matchingTurn: boolean,
  bash: boolean,
  exactCommand: boolean,
  stringCallId: boolean,
  ordered: boolean,
): asserts stringCallId {
  if (!(matchingTurn && bash && exactCommand && stringCallId && ordered))
    throw new PermissionEvidenceError(
      'intended-bash',
      `turn:${String(matchingTurn)},tool:${String(bash)},command:${String(exactCommand)},call-id:${String(stringCallId)},order:${String(ordered)}`,
    );
}

const TURN_END_KINDS = new Set(['completed', 'error', 'aborted', 'blocked', 'max-tokens']);

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Closed-set turn-end classification; never echoes the raw kind or any reason payload. */
function turnEndKind(ends: readonly Event[]): string {
  if (ends.length === 0) return 'absent';
  if (ends.length > 1) return 'multiple';
  const kind = field(field(ends[0]?.data, 'reason'), 'kind');
  return typeof kind === 'string' && TURN_END_KINDS.has(kind) ? kind : 'other';
}

function toolIdentity(events: readonly Event[], input: NativeObservation): ToolIdentity {
  const starts = of(events, 'turn/start');
  const calls = of(events, 'tool/call');
  const start = starts[0];
  const call = calls[0];
  if (starts.length !== 1 || calls.length !== 1 || !start || !call)
    throw new PermissionEvidenceError(
      'turn-call-count',
      `turn-start:${String(starts.length)},tool-call:${String(calls.length)},turn-end:${turnEndKind(of(events, 'turn/end'))},assistant-message:${String(of(events, 'assistant/message').length)}`,
    );
  const data = record(call.data);
  const turn = record(start.data).turn;
  const args = record(JSON.parse(String(data.arguments)));
  const matchingTurn = data.turn === turn;
  const stringCallId = typeof data.callId === 'string';
  const ordered = Number(call.seq) > Number(start.seq);
  if ('command' in input) {
    requireBashIdentity(
      matchingTurn,
      data.name === 'bash',
      args.command === input.command,
      stringCallId,
      ordered,
    );
  } else {
    requireEvidence(
      matchingTurn &&
        data.name === 'write' &&
        args.file_path === input.path &&
        args.content === input.content &&
        stringCallId &&
        ordered,
      'intended-write',
    );
  }
  // Both branches enforce stringCallId; TypeScript cannot retain that property narrowing through the helper.
  return { start, call, turn, callId: data.callId as string };
}

function promptIdentity(
  events: readonly Event[],
  input: NativeObservation,
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

function approvalEvidence(events: readonly Event[], input: NativeObservation, call: Event) {
  const unprompted = input.phase === 'unprompted';
  const asked = of(events, 'approval/asked');
  const decided = of(events, 'approval/decided');
  requireEvidence(asked.length === (unprompted ? 0 : 1), 'approval-count');
  const ask = asked[0];
  if (ask)
    requireEvidence(
      record(ask.data).callId === record(call.data).callId &&
        record(ask.data).toolName === record(call.data).name &&
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
  input: NativeObservation,
  identity: ToolIdentity,
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

function bashStdout(events: readonly Event[], input: BashObservation): string {
  requireEvidence(
    input.expectedTier === 'danger-full-access' &&
      !events.some((event) => String(event.type).startsWith('approval/')),
    'bash-yolo',
  );
  const message = record(record(one(of(events, 'tool/result'), 'tool-result').data).message);
  const content: unknown = message.content;
  requireEvidence(Array.isArray(content) && content.length === 1, 'bash-process');
  const part = record(content[0]);
  requireEvidence(part.type === 'text' && typeof part.text === 'string', 'bash-process');
  // Released bash persists rendered text, not structured process metadata. Complete JSON
  // rejects stderr, truncation, background and unsuccessful-exit markers appended by its renderer.
  try {
    JSON.parse(part.text);
  } catch {
    for (const [marker, detail] of BASH_FAILURE_MARKERS)
      if (part.text.includes(marker)) throw new PermissionEvidenceError('bash-process', detail);
    throw new PermissionEvidenceError('bash-process', 'malformed-json');
  }
  return part.text;
}

export function permissionEvidence(input: NativeObservation) {
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
  const identity = toolIdentity(events, input);
  const requestId = promptIdentity(events, input, identity.start, identity.call);
  requireEvidence(input.tier === input.expectedTier, 'tier');
  const written = input.phase === 'allow' || input.phase === 'unprompted';
  if ('file' in input && !('command' in input))
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
    ...('command' in input ? { stdout: bashStdout(events, input) } : {}),
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

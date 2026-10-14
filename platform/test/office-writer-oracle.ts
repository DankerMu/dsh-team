import assert from 'node:assert/strict';
import { record } from './container-start-docker-fixture.ts';

interface OfficeNotice {
  path: string;
  title: string;
  addressee: string;
  matter: string;
  issuer: string;
  date: string;
}

export function officeDocxEvidence(value: unknown, expected: OfficeNotice) {
  const parsed = record(value);
  assert(
    parsed.status === 'parsed' && parsed.path === expected.path && parsed.uid === 1001,
    'office-docx-identity',
  );
  assert(
    typeof parsed.bytes === 'number' &&
      Number.isSafeInteger(parsed.bytes) &&
      parsed.bytes > 0 &&
      parsed.bytes <= 1_048_576,
    'office-docx-size',
  );
  assert(
    typeof parsed.sha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.sha256),
    'office-docx-hash',
  );
  assert(
    Array.isArray(parsed.paragraphs) &&
      parsed.paragraphs.every((text: unknown) => typeof text === 'string'),
    'office-docx-text',
  );
  const text = parsed.paragraphs.join('\n').replace(/\s/gu, '');
  const fields = { title: false, addressee: false, matter: false, issuer: false, date: false };
  for (const field of ['title', 'addressee', 'matter', 'issuer', 'date'] as const) {
    const wanted = expected[field].replace(/\s/gu, '');
    fields[field] = wanted !== '' && text.includes(wanted);
  }
  assert(Object.values(fields).every(Boolean), 'office-docx-content');
  return { path: expected.path, bytes: parsed.bytes, sha256: parsed.sha256, fields };
}

export function officeChildReady(identity: unknown, agentAvailable: unknown): boolean {
  if (identity == null && agentAvailable === true) return false;
  const descriptor = record(identity);
  assert(
    descriptor.mode === 'one-shot' &&
      typeof descriptor.seq === 'number' &&
      Number.isSafeInteger(descriptor.seq) &&
      descriptor.seq >= 0,
    'office-child-descriptor',
  );
  return true;
}

interface OfficeHistory {
  records: readonly unknown[];
  cursor: number;
  hasMore: boolean;
  preset: string;
  prompt: string;
}

interface OfficeDelegation {
  parent: OfficeHistory & { sessionId: string; cwd: string; catalog: unknown };
  child: unknown;
  identity: unknown;
  nonce: string;
  notice: OfficeNotice;
  contribution: unknown;
}

function historyEvents(input: OfficeHistory) {
  const events = input.records.map((row) => record(record(row).event));
  assert(
    !input.hasMore &&
      events.length === input.cursor + 1 &&
      events.every((event, index) => event.seq === index),
    'office-history-incomplete',
  );
  return events;
}

function childLineage(delegation: OfficeDelegation, events: Record<string, unknown>[]) {
  const { parent } = delegation;
  const child = record(delegation.child);
  const identity = record(delegation.identity);
  assert(
    parent.preset === 'office-general' &&
      child.origin === 'subagent' &&
      child.parentSessionId === parent.sessionId &&
      child.sessionId !== parent.sessionId &&
      parent.cwd === '/data/work' &&
      child.cwd === parent.cwd,
    'office-child-lineage',
  );
  assert(
    identity.mode === 'one-shot' &&
      typeof identity.seq === 'number' &&
      Number.isSafeInteger(identity.seq),
    'office-child-descriptor',
  );
  const descriptor = record(events[identity.seq]);
  assert(
    descriptor.type === 'subagent/descriptor' &&
      record(descriptor.data).mode === identity.mode &&
      record(descriptor.data).provider === 'spawn',
    'office-child-descriptor',
  );
  assert(Array.isArray(parent.catalog) && parent.catalog.length === 1, 'office-child-catalog');
  const entry = record(parent.catalog[0]);
  assert(
    entry.id === child.sessionId &&
      entry.mode === identity.mode &&
      entry.label === identity.label &&
      record(descriptor.data).label === identity.label,
    'office-child-catalog',
  );
  return { child, identity };
}

function delegationEvidence(
  input: OfficeHistory,
  delegation: OfficeDelegation,
  childEvents: Record<string, unknown>[],
) {
  const { child, identity } = childLineage(delegation, childEvents);
  const { parent } = delegation;
  const events = historyEvents(parent);
  const starts = events.filter((event) => event.type === 'turn/start');
  const prompts = events.filter(
    (event) => event.type === 'user/message' && record(record(event.data).source).kind === 'user',
  );
  assert(prompts.length === 1 && starts.length > 0, 'office-parent-prompt');
  const prompt = record(prompts[0]);
  const source = record(record(prompt.data).source);
  const content = record(prompt.data).content;
  assert(
    typeof source.rpcId === 'string' &&
      source.rpcId.length > 0 &&
      Array.isArray(content) &&
      content.some(
        (part: unknown) => record(part).type === 'text' && record(part).text === parent.prompt,
      ),
    'office-parent-prompt',
  );
  const start = record(starts[0]);
  const turn = record(start.data).turn;
  assert(Number(start.seq) < Number(prompt.seq), 'office-parent-prompt');
  const calls = events.filter(
    (event) =>
      event.type === 'tool/call' &&
      record(event.data).name === 'subagent' &&
      record(event.data).turn === turn,
  );
  assert.equal(calls.length, 1, 'office-delegation-call');
  const call = record(calls[0]);
  const callData = record(call.data);
  const args = record(JSON.parse(String(callData.arguments)));
  assert(
    typeof callData.callId === 'string' &&
      Number(call.seq) > Number(prompt.seq) &&
      args.prompt === input.prompt &&
      args.description === identity.label,
    'office-delegation-call',
  );
  const catalog = events.filter(
    (event) => event.type === 'subagent/catalog' && record(event.data).childId === child.sessionId,
  );
  assert.equal(catalog.length, 1, 'office-delegation-membership');
  assert(Number(record(catalog[0]).seq) > Number(call.seq), 'office-delegation-membership');
  const terminal = delegationResult(events, call);
  assert(Number(record(catalog[0]).seq) < Number(terminal.seq), 'office-delegation-membership');
  return {
    parentId: parent.sessionId,
    childId: child.sessionId,
    callId: callData.callId,
    callSeq: call.seq,
    catalogSeq: record(catalog[0]).seq,
    parentTerminalSeq: terminal.seq,
  };
}

function delegationResult(events: Record<string, unknown>[], call: Record<string, unknown>) {
  const data = record(call.data);
  const ends = events.filter(
    (event) => event.type === 'turn/end' && record(event.data).turn === data.turn,
  );
  assert.equal(ends.length, 1, 'office-parent-completion');
  const end = record(ends[0]);
  assert(record(record(end.data).reason).kind === 'completed', 'office-parent-completion');
  assert(
    events.some((event) => {
      if (event.type !== 'tool/result' || record(event.data).turn !== data.turn) return false;
      const message = record(record(event.data).message);
      return (
        message.role === 'tool' &&
        message.isError !== true &&
        message.toolCallId === data.callId &&
        record(message.source).kind === 'tool' &&
        record(message.source).callId === data.callId &&
        Number(event.seq) > Number(call.seq) &&
        Number(event.seq) < Number(end.seq)
      );
    }),
    'office-delegation-result',
  );
  return end;
}

function childContribution(
  delegation: OfficeDelegation,
  start: Record<string, unknown>,
  end: Record<string, unknown>,
) {
  const proof = record(delegation.contribution);
  assert(
    proof.nonce === delegation.nonce &&
      proof.parentId === delegation.parent.sessionId &&
      proof.childId === record(delegation.child).sessionId &&
      proof.startSeq === start.seq &&
      proof.endSeq === end.seq &&
      proof.confounded === false,
    'office-child-contribution',
  );
  const before = record(proof.before);
  assert(
    before.status === 'missing' && before.uid === 1001 && before.path === delegation.notice.path,
    'office-child-artifact-not-fresh',
  );
  return officeDocxEvidence(proof.after, delegation.notice);
}

export function officeTurnEvidence(input: OfficeHistory & { delegation?: OfficeDelegation }) {
  const events = historyEvents(input);
  assert(input.preset === 'office-writer', 'office-preset-binding');
  const selected = events.filter((event) => event.type === 'agent-preset/selected');
  const starts = events.filter((event) => event.type === 'turn/start');
  const prompts = events.filter(
    (event) => event.type === 'user/message' && record(record(event.data).source).kind === 'user',
  );
  const ends = events.filter((event) => event.type === 'turn/end');
  assert(
    selected.length === 1 && starts.length === 1 && prompts.length === 1 && ends.length === 1,
    'office-turn-count',
  );
  const selection = record(selected[0]);
  const start = record(starts[0]);
  const prompt = record(prompts[0]);
  const end = record(ends[0]);
  const turn = record(start.data).turn;
  assert(
    record(selection.data).agentPreset === 'office-writer' &&
      Number(selection.seq) < Number(start.seq),
    'office-preset-selection',
  );
  const message = record(prompt.data);
  assert(typeof turn === 'number' && Number.isSafeInteger(turn), 'office-turn-identity');
  assert(
    record(message.source).kind === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(
        (part: unknown) => record(part).type === 'text' && record(part).text === input.prompt,
      ) &&
      Number(start.seq) < Number(prompt.seq),
    'office-prompt',
  );
  const calls = events.filter(
    (event) =>
      event.type === 'tool/call' &&
      record(event.data).turn === turn &&
      Number(event.seq) > Number(prompt.seq),
  );
  const successfulTool = events.some((event) => {
    if (event.type !== 'tool/result' || record(event.data).turn !== turn) return false;
    const result = record(record(event.data).message);
    return (
      result.role === 'tool' &&
      result.isError !== true &&
      record(result.source).kind === 'tool' &&
      calls.some((call) => {
        const data = record(call.data);
        if (
          input.delegation &&
          data.name !== 'bash' &&
          data.name !== 'write' &&
          data.name !== 'edit'
        )
          return false;
        return (
          typeof data.callId === 'string' &&
          data.callId === result.toolCallId &&
          result.toolCallId === record(result.source).callId &&
          Number(call.seq) < Number(event.seq)
        );
      }) &&
      Number(event.seq) < Number(end.seq)
    );
  });
  assert(
    successfulTool &&
      record(end.data).turn === turn &&
      record(record(end.data).reason).kind === 'completed',
    'office-turn-completion',
  );
  return {
    selectedSeq: selection.seq,
    promptSeq: prompt.seq,
    turn,
    terminalSeq: end.seq,
    ...(input.delegation
      ? {
          delegation: {
            ...delegationEvidence(input, input.delegation, events),
            childDocx: childContribution(input.delegation, start, end),
          },
        }
      : {}),
  };
}

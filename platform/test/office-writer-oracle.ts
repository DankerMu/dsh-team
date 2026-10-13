import assert from 'node:assert/strict';
import { record } from './container-start-docker-fixture.ts';

export interface OfficeNotice {
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

export function officeTurnEvidence(input: {
  records: readonly unknown[];
  cursor: number;
  hasMore: boolean;
  preset: string;
  prompt: string;
}) {
  const events = input.records.map((row) => record(record(row).event));
  assert(
    !input.hasMore &&
      events.length === input.cursor + 1 &&
      events.every((event, index) => event.seq === index),
    'office-history-incomplete',
  );
  assert(input.preset === 'office-writer', 'office-preset-binding');
  const selected = events.filter((event) => event.type === 'agent-preset/selected');
  const starts = events.filter((event) => event.type === 'turn/start');
  const prompts = events.filter((event) => event.type === 'user/message');
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
      calls.some(
        (call) =>
          typeof record(call.data).callId === 'string' &&
          record(call.data).callId === result.toolCallId &&
          result.toolCallId === record(result.source).callId &&
          Number(call.seq) < Number(event.seq),
      ) &&
      Number(event.seq) < Number(end.seq)
    );
  });
  assert(
    successfulTool &&
      record(end.data).turn === turn &&
      record(record(end.data).reason).kind === 'completed',
    'office-turn-completion',
  );
  return { selectedSeq: selection.seq, promptSeq: prompt.seq, turn, terminalSeq: end.seq };
}

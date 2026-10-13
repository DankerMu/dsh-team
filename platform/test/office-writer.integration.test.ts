import { expect, it } from 'vitest';
import { officeDocxEvidence, officeTurnEvidence } from './office-writer-oracle.ts';

const NOTICE = {
  path: '/data/work/notice-test.docx',
  title: '关于消防演练的通知',
  addressee: '研发部全体同事',
  matter: '演练编号：notice-test；周五下午在一楼大厅集合',
  issuer: '行政办公室',
  date: '2026年10月13日',
};
const PARSED = {
  status: 'parsed',
  path: NOTICE.path,
  uid: 1001,
  bytes: 2048,
  sha256: 'a'.repeat(64),
  paragraphs: [NOTICE.title, NOTICE.addressee, NOTICE.matter, NOTICE.issuer, NOTICE.date],
};

it('binds readable DOCX content to the requested notice without retaining document text', () => {
  const proof = officeDocxEvidence(PARSED, NOTICE);
  expect(proof).toEqual({
    path: NOTICE.path,
    bytes: 2048,
    sha256: PARSED.sha256,
    fields: { title: true, addressee: true, matter: true, issuer: true, date: true },
  });
  expect(JSON.stringify(proof)).not.toContain(NOTICE.matter);
});

it.each(['title', 'addressee', 'matter', 'issuer', 'date'] as const)(
  'rejects a notice missing its requested %s',
  (field) => {
    expect(() =>
      officeDocxEvidence(
        {
          ...PARSED,
          paragraphs: PARSED.paragraphs.filter((text) => text !== NOTICE[field]),
        },
        NOTICE,
      ),
    ).toThrow('office-docx-content');
  },
);

it.each([
  { status: 'missing' },
  { status: 'unreadable' },
  { path: '/data/work/other.docx' },
  { uid: 0 },
  { paragraphs: ['another task'] },
  { paragraphs: null },
  { sha256: '' },
])('rejects absent, invalid or unrelated document evidence %#', (change) => {
  expect(() => officeDocxEvidence({ ...PARSED, ...change }, NOTICE)).toThrow();
});

const PROMPT = '请生成指定通知 DOCX。';
const EVENTS = [
  { type: 'session/create', data: {} },
  { type: 'agent-preset/selected', data: { agentPreset: 'office-writer' } },
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'request' }, content: [{ type: 'text', text: PROMPT }] },
  },
  { type: 'tool/call', data: { turn: 1, callId: 'call', name: 'bash' } },
  {
    type: 'tool/result',
    data: {
      turn: 1,
      message: { role: 'tool', toolCallId: 'call', source: { kind: 'tool', callId: 'call' } },
    },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
const TURN = {
  preset: 'office-writer',
  prompt: PROMPT,
  cursor: EVENTS.length - 1,
  hasMore: false,
  records: EVENTS.map((event, seq) => ({ event: { seq, ...event } })),
};

it('binds manual writer selection to its exact prompt, successful tool activity and terminal turn', () => {
  expect(officeTurnEvidence(TURN)).toEqual({
    selectedSeq: 1,
    promptSeq: 3,
    turn: 1,
    terminalSeq: 6,
  });
});

it.each([
  { preset: 'office-general' },
  { prompt: 'a different task' },
  { hasMore: true },
  { cursor: 99 },
  { records: TURN.records.slice(1) },
])('rejects mismatched or incomplete native writer history %#', (change) => {
  expect(() => officeTurnEvidence({ ...TURN, ...change })).toThrow();
});

it.each([
  { index: 1, data: { agentPreset: 'office-general' } },
  { index: 2, data: { turn: 2 } },
  {
    index: 5,
    data: {
      turn: 1,
      message: { role: 'tool', toolCallId: 'other', source: { kind: 'tool', callId: 'other' } },
    },
  },
  {
    index: 5,
    data: {
      turn: 1,
      message: {
        role: 'tool',
        toolCallId: 'call',
        isError: true,
        source: { kind: 'tool', callId: 'call' },
      },
    },
  },
  { index: 6, data: { turn: 1, reason: { kind: 'failed' } } },
  { index: 6, data: { turn: 2, reason: { kind: 'completed' } } },
])('rejects false selection, tool or completion provenance %#', ({ index, data }) => {
  const records = TURN.records.map((row, position) =>
    position === index ? { event: { ...row.event, data } } : row,
  );
  expect(() => officeTurnEvidence({ ...TURN, records })).toThrow();
});

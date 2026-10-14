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

it('distinguishes the human task from native skill catalog and instruction messages', () => {
  const injected = ['skill-catalog', 'skill-invocation'].map((kind) => ({
    type: 'user/message',
    data: { source: { kind }, content: [{ type: 'text', text: PROMPT }] },
  }));
  const records = [...EVENTS.slice(0, 4), ...injected, ...EVENTS.slice(4)].map((event, seq) => ({
    event: { seq, ...event },
  }));
  expect(officeTurnEvidence({ ...TURN, records, cursor: records.length - 1 })).toEqual({
    selectedSeq: 1,
    promptSeq: 3,
    turn: 1,
    terminalSeq: 8,
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
    index: 3,
    data: { source: { kind: 'skill-invocation' }, content: [{ type: 'text', text: PROMPT }] },
  },
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

const DELEGATED_PROMPT = '请按主任务给出的五项内容制作通知文件。';
const PARENT_EVENTS = [
  { type: 'session/create', data: {} },
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'human' }, content: [{ type: 'text', text: PROMPT }] },
  },
  {
    type: 'tool/call',
    data: {
      turn: 1,
      callId: 'delegate',
      name: 'subagent',
      arguments: JSON.stringify({ description: '通知', prompt: DELEGATED_PROMPT }),
    },
  },
  { type: 'subagent/catalog', data: { childId: 'child', mode: 'one-shot', label: '通知' } },
  {
    type: 'tool/result',
    data: {
      turn: 1,
      message: {
        role: 'tool',
        toolCallId: 'delegate',
        source: { kind: 'tool', callId: 'delegate' },
      },
    },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
const DELEGATION = {
  parent: {
    sessionId: 'parent',
    cwd: '/data/work',
    preset: 'office-general',
    prompt: PROMPT,
    hasMore: false,
    cursor: PARENT_EVENTS.length - 1,
    records: PARENT_EVENTS.map((event, seq) => ({ event: { seq, ...event } })),
    catalog: [{ id: 'child', mode: 'one-shot', label: '通知' }],
  },
  child: { sessionId: 'child', origin: 'subagent', parentSessionId: 'parent', cwd: '/data/work' },
  identity: { mode: 'one-shot', label: '通知', seq: 1 },
};
const DELEGATED_TURN = {
  ...TURN,
  prompt: DELEGATED_PROMPT,
  delegation: DELEGATION,
  cursor: EVENTS.length,
  records: [
    ...EVENTS.slice(0, 1),
    {
      type: 'subagent/descriptor',
      data: { version: 1, mode: 'one-shot', provider: 'spawn', label: '通知' },
    },
    ...EVENTS.slice(1).map((event) =>
      event.type === 'user/message'
        ? {
            ...event,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: DELEGATED_PROMPT }] },
          }
        : event,
    ),
  ].map((event, seq) => ({ event: { seq, ...event } })),
};

it('binds the model-authored child prompt to the actual human parent and native delegation', () => {
  expect(officeTurnEvidence(DELEGATED_TURN)).toMatchObject({ turn: 1, selectedSeq: 2 });
});

it.each([
  { child: { ...DELEGATION.child, parentSessionId: 'unrelated' } },
  { child: { ...DELEGATION.child, origin: undefined } },
  { child: { ...DELEGATION.child, cwd: '/other' } },
  { child: { ...DELEGATION.child, sessionId: 'stale-child' } },
  { identity: { ...DELEGATION.identity, mode: 'continuable' } },
  { identity: { ...DELEGATION.identity, seq: 0 } },
  { parent: { ...DELEGATION.parent, preset: 'office-writer' } },
  { parent: { ...DELEGATION.parent, prompt: 'another human task' } },
  { parent: { ...DELEGATION.parent, hasMore: true } },
  { parent: { ...DELEGATION.parent, catalog: [] } },
])('rejects a successful writer child with false or incomplete delegation lineage %#', (change) => {
  expect(() =>
    officeTurnEvidence({ ...DELEGATED_TURN, delegation: { ...DELEGATION, ...change } }),
  ).toThrow();
});

it.each([
  { index: 3, data: { ...PARENT_EVENTS[3]?.data, name: 'write' } },
  {
    index: 3,
    data: {
      ...PARENT_EVENTS[3]?.data,
      arguments: JSON.stringify({ prompt: PROMPT, description: '通知' }),
    },
  },
  { index: 4, data: { childId: 'another-child', mode: 'one-shot', label: '通知' } },
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
        toolCallId: 'delegate',
        source: { kind: 'tool', callId: 'delegate' },
        isError: true,
      },
    },
  },
  { index: 6, data: { turn: 1, reason: { kind: 'error' } } },
])('rejects manufactured parent call, child membership or completion %#', ({ index, data }) => {
  const parent = {
    ...DELEGATION.parent,
    records: DELEGATION.parent.records.map((row, position) =>
      position === index ? { event: { ...row.event, data } } : row,
    ),
  };
  expect(() =>
    officeTurnEvidence({ ...DELEGATED_TURN, delegation: { ...DELEGATION, parent } }),
  ).toThrow();
});

it('rejects a delegated writer that only reads while another Agent could produce the file', () => {
  const records = DELEGATED_TURN.records.map((row) =>
    row.event.type === 'tool/call'
      ? { event: { ...row.event, data: { ...row.event.data, name: 'read' } } }
      : row,
  );
  expect(() => officeTurnEvidence({ ...DELEGATED_TURN, records })).toThrow(
    'office-turn-completion',
  );
});

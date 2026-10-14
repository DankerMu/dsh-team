import { expect, it } from 'vitest';
import {
  officeChildReady,
  officeDocxEvidence,
  officeTurnEvidence,
} from './office-writer-oracle.ts';

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
const RECEIPT = {
  path: NOTICE.path,
  bytes: 2048,
  sha256: 'a'.repeat(64),
  uid: 1001,
};
const CONSTRUCTION_CALL = {
  turn: 1,
  step: 1,
  callId: 'construct',
  name: 'build_docx',
  arguments: JSON.stringify({
    path: NOTICE.path,
    paragraphs: PARSED.paragraphs.map((text) => ({ text })),
  }),
};
const CONSTRUCTION_RESULT = {
  turn: 1,
  step: 1,
  message: {
    role: 'tool',
    toolCallId: 'construct',
    source: { kind: 'tool', callId: 'construct' },
  },
  meta: RECEIPT,
};
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
  notice: NOTICE,
  nonce: 'office-observation',
  contribution: {
    nonce: 'office-observation',
    parentId: 'parent',
    childId: 'child',
    callSeq: 5,
    resultSeq: 6,
    callId: 'construct',
    turn: 1,
    step: 1,
    receipt: RECEIPT,
    artifact: PARSED,
  },
};
const DELEGATED_TURN = {
  ...TURN,
  prompt: DELEGATED_PROMPT,
  delegation: DELEGATION,
  cursor: EVENTS.length + 2,
  records: [
    ...EVENTS.slice(0, 1),
    {
      type: 'subagent/descriptor',
      data: { version: 1, mode: 'one-shot', provider: 'spawn', label: '通知' },
    },
    ...EVENTS.slice(1, 4).map((event) =>
      event.type === 'user/message'
        ? {
            ...event,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: DELEGATED_PROMPT }] },
          }
        : event,
    ),
    { type: 'tool/call', data: CONSTRUCTION_CALL },
    { type: 'tool/result', data: CONSTRUCTION_RESULT },
    ...EVENTS.slice(4),
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

it('binds structured construction to its receipt and boundary artifact without retaining text', () => {
  const records = DELEGATED_TURN.records
    .filter((row) => row.event.seq !== 7 && row.event.seq !== 8)
    .map((row, seq) => ({ event: { ...row.event, seq } }));

  const proof = officeTurnEvidence({ ...DELEGATED_TURN, records, cursor: records.length - 1 });

  expect(proof.delegation).toMatchObject({
    childId: 'child',
    childDocx: {
      path: NOTICE.path,
      bytes: 2048,
      sha256: 'a'.repeat(64),
      fields: { title: true, addressee: true, matter: true, issuer: true, date: true },
    },
  });
  expect(JSON.stringify(proof)).not.toContain(NOTICE.matter);
});

it.each(['bash', 'write', 'edit', 'read'])(
  'rejects %s-only child activity even with the previously accepted absence/completion proof',
  (name) => {
    // Retain the old oracle's full accepted checkpoint here so RED demonstrates
    // missing construction, not merely rejection of the new proof envelope.
    const records = DELEGATED_TURN.records
      .filter((row) => row.event.seq !== 5 && row.event.seq !== 6)
      .map((row, seq) => ({
        event: {
          ...row.event,
          seq,
          ...(row.event.type === 'tool/call'
            ? {
                data: {
                  turn: 1,
                  callId: 'call',
                  name,
                  arguments: JSON.stringify({
                    command: `cp /data/work/prepared.docx ${NOTICE.path}`,
                  }),
                },
              }
            : {}),
        },
      }));
    const contribution = {
      nonce: DELEGATION.nonce,
      parentId: 'parent',
      childId: 'child',
      startSeq: 3,
      endSeq: 7,
      confounded: false,
      before: { path: NOTICE.path, uid: 1001, status: 'missing' },
      after: PARSED,
    };

    expect(() =>
      officeTurnEvidence({
        ...DELEGATED_TURN,
        records,
        cursor: records.length - 1,
        delegation: { ...DELEGATION, contribution },
      }),
    ).toThrow(/^office-child-contribution$/);
  },
);

it.each([
  { label: 'missing checkpoint', contribution: undefined },
  { label: 'empty checkpoint', contribution: {} },
  { label: 'missing receipt', contribution: { ...DELEGATION.contribution, receipt: undefined } },
  { label: 'stale invocation', contribution: { ...DELEGATION.contribution, nonce: 'stale' } },
  { label: 'sibling child', contribution: { ...DELEGATION.contribution, childId: 'sibling' } },
  { label: 'parent receipt', contribution: { ...DELEGATION.contribution, childId: 'parent' } },
  { label: 'wrong parent', contribution: { ...DELEGATION.contribution, parentId: 'other' } },
  { label: 'stale call sequence', contribution: { ...DELEGATION.contribution, callSeq: 4 } },
  { label: 'stale result sequence', contribution: { ...DELEGATION.contribution, resultSeq: 8 } },
  { label: 'wrong call', contribution: { ...DELEGATION.contribution, callId: 'call' } },
  { label: 'stale turn', contribution: { ...DELEGATION.contribution, turn: 0 } },
  { label: 'stale step', contribution: { ...DELEGATION.contribution, step: 0 } },
])('rejects $label despite successful generic child tool activity', ({ contribution }) => {
  expect(() =>
    officeTurnEvidence({ ...DELEGATED_TURN, delegation: { ...DELEGATION, contribution } }),
  ).toThrow(/^office-child-contribution$/);
});

it.each([
  { label: 'missing metadata', meta: undefined },
  { label: 'wrong target', meta: { ...RECEIPT, path: '/data/work/other.docx' } },
  { label: 'wrong owner', meta: { ...RECEIPT, uid: 0 } },
  { label: 'zero size', meta: { ...RECEIPT, bytes: 0 } },
  { label: 'oversized artifact', meta: { ...RECEIPT, bytes: 1_048_577 } },
  { label: 'fractional size', meta: { ...RECEIPT, bytes: 2048.5 } },
  { label: 'invalid digest', meta: { ...RECEIPT, sha256: 'A'.repeat(64) } },
  { label: 'unknown receipt field', meta: { ...RECEIPT, copied: true } },
])('rejects construction with $label in its durable receipt', ({ meta }) => {
  const records = DELEGATED_TURN.records.map((row) =>
    row.event.seq === 6 ? { event: { ...row.event, data: { ...CONSTRUCTION_RESULT, meta } } } : row,
  );

  expect(() =>
    officeTurnEvidence({
      ...DELEGATED_TURN,
      records,
      delegation: {
        ...DELEGATION,
        contribution: { ...DELEGATION.contribution, receipt: meta },
      },
    }),
  ).toThrow(/^office-child-contribution$/);
});

it.each([
  { label: 'stale call turn', seq: 5, data: { ...CONSTRUCTION_CALL, turn: 0 } },
  { label: 'stale call step', seq: 5, data: { ...CONSTRUCTION_CALL, step: 0 } },
  { label: 'wrong call identity', seq: 5, data: { ...CONSTRUCTION_CALL, callId: 'other' } },
  {
    label: 'wrong requested target',
    seq: 5,
    data: {
      ...CONSTRUCTION_CALL,
      arguments: JSON.stringify({ path: '/data/work/other.docx', paragraphs: [{ text: 'other' }] }),
    },
  },
  { label: 'stale result turn', seq: 6, data: { ...CONSTRUCTION_RESULT, turn: 0 } },
  { label: 'stale result step', seq: 6, data: { ...CONSTRUCTION_RESULT, step: 0 } },
  {
    label: 'failed result',
    seq: 6,
    data: {
      ...CONSTRUCTION_RESULT,
      message: { ...CONSTRUCTION_RESULT.message, isError: true },
    },
  },
  {
    label: 'native error despite success-shaped message',
    seq: 6,
    data: { ...CONSTRUCTION_RESULT, error: { name: 'ToolError', code: 'cancelled' } },
  },
  {
    label: 'wrong result call',
    seq: 6,
    data: {
      ...CONSTRUCTION_RESULT,
      message: { ...CONSTRUCTION_RESULT.message, toolCallId: 'other' },
    },
  },
  {
    label: 'wrong source call',
    seq: 6,
    data: {
      ...CONSTRUCTION_RESULT,
      message: { ...CONSTRUCTION_RESULT.message, source: { kind: 'tool', callId: 'other' } },
    },
  },
  {
    label: 'non-tool result source',
    seq: 6,
    data: {
      ...CONSTRUCTION_RESULT,
      message: { ...CONSTRUCTION_RESULT.message, source: { kind: 'user', callId: 'construct' } },
    },
  },
])('rejects $label even when another child tool succeeds', ({ seq, data }) => {
  const records = DELEGATED_TURN.records.map((row) =>
    row.event.seq === seq ? { event: { ...row.event, data } } : row,
  );

  expect(() => officeTurnEvidence({ ...DELEGATED_TURN, records })).toThrow(
    /^office-child-contribution$/,
  );
});

it.each(['failed', 'cancelled'])('rejects a %s writer turn after construction', (kind) => {
  const records = DELEGATED_TURN.records.map((row) =>
    row.event.type === 'turn/end'
      ? { event: { ...row.event, data: { turn: 1, reason: { kind } } } }
      : row,
  );

  expect(() => officeTurnEvidence({ ...DELEGATED_TURN, records })).toThrow(
    'office-turn-completion',
  );
});

it.each([
  { label: 'missing boundary file', artifact: { ...PARSED, status: 'missing' } },
  { label: 'unreadable boundary file', artifact: { ...PARSED, status: 'unreadable' } },
  { label: 'wrong boundary path', artifact: { ...PARSED, path: '/data/work/other.docx' } },
  { label: 'wrong boundary owner', artifact: { ...PARSED, uid: 0 } },
  { label: 'boundary digest mismatch', artifact: { ...PARSED, sha256: 'b'.repeat(64) } },
  { label: 'boundary size mismatch', artifact: { ...PARSED, bytes: 4096 } },
  ...(['title', 'addressee', 'matter', 'issuer', 'date'] as const).map((field) => ({
    label: `missing boundary ${field}`,
    artifact: { ...PARSED, paragraphs: PARSED.paragraphs.filter((text) => text !== NOTICE[field]) },
  })),
])('rejects $label even when the final delivered DOCX is valid', ({ artifact }) => {
  expect(officeDocxEvidence(PARSED, NOTICE).fields.matter).toBe(true);

  expect(() =>
    officeTurnEvidence({
      ...DELEGATED_TURN,
      delegation: {
        ...DELEGATION,
        contribution: { ...DELEGATION.contribution, artifact },
      },
    }),
  ).toThrow(/^office-child-contribution$/);
});

it('rejects checkpoint metadata that differs from the committed construction receipt', () => {
  expect(() =>
    officeTurnEvidence({
      ...DELEGATED_TURN,
      delegation: {
        ...DELEGATION,
        contribution: {
          ...DELEGATION.contribution,
          receipt: { ...RECEIPT, sha256: 'b'.repeat(64) },
          artifact: { ...PARSED, sha256: 'b'.repeat(64) },
        },
      },
    }),
  ).toThrow(/^office-child-contribution$/);
});

it('allows parent-supplied complete prose before genuine structured writer construction', () => {
  const suppliedPrompt = PARSED.paragraphs.join('\n');
  const records = DELEGATED_TURN.records.map((row) =>
    row.event.type === 'user/message'
      ? {
          event: {
            ...row.event,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: suppliedPrompt }] },
          },
        }
      : row,
  );
  const parentEvents = [
    ...PARENT_EVENTS.slice(0, 3),
    { type: 'tool/call', data: { turn: 1, callId: 'draft', name: 'write' } },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'draft', source: { kind: 'tool', callId: 'draft' } },
      },
    },
    ...PARENT_EVENTS.slice(3).map((event) =>
      event.type === 'tool/call'
        ? {
            ...event,
            data: {
              ...event.data,
              arguments: JSON.stringify({ description: '通知', prompt: suppliedPrompt }),
            },
          }
        : event,
    ),
  ];
  const parent = {
    ...DELEGATION.parent,
    records: parentEvents.map((event, seq) => ({ event: { seq, ...event } })),
    cursor: parentEvents.length - 1,
  };

  expect(
    officeTurnEvidence({
      ...DELEGATED_TURN,
      prompt: suppliedPrompt,
      records,
      delegation: { ...DELEGATION, parent },
    }).delegation,
  ).toMatchObject({ childId: 'child', childDocx: { sha256: 'a'.repeat(64) } });
});

it('allows parent edits after construction while independently checking the final DOCX', () => {
  expect(officeTurnEvidence(DELEGATED_TURN).delegation).toMatchObject({ childId: 'child' });
  const edited = officeDocxEvidence({ ...PARSED, sha256: 'b'.repeat(64), bytes: 4096 }, NOTICE);

  expect(edited.sha256).toBe('b'.repeat(64));
  expect(edited.fields).toEqual({
    title: true,
    addressee: true,
    matter: true,
    issuer: true,
    date: true,
  });
  expect(() =>
    officeDocxEvidence(
      { ...PARSED, sha256: 'b'.repeat(64), paragraphs: ['parent removed facts'] },
      NOTICE,
    ),
  ).toThrow('office-docx-content');
});

it('keeps a live blank child pending until its one-shot descriptor is published', () => {
  expect(officeChildReady(null, true)).toBe(false);
  expect(officeChildReady({ mode: 'one-shot', seq: 2 }, true)).toBe(true);
  expect(officeChildReady({ mode: 'one-shot', seq: 2 }, false)).toBe(true);
});

it.each([
  { identity: null, available: false },
  { identity: undefined, available: false },
  { identity: { mode: 'continuable', seq: 0 }, available: true },
  { identity: { mode: 'unknown', seq: 0 }, available: true },
  { identity: { mode: 'one-shot', seq: -1 }, available: true },
  { identity: { mode: 'one-shot', seq: 0.5 }, available: true },
])('rejects terminal missing or invalid child identity %#', ({ identity, available }) => {
  expect(() => officeChildReady(identity, available)).toThrow();
});

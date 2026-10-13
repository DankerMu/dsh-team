import { expect, it } from 'vitest';
import { permissionEvidence } from './permission-model-oracle.ts';

function evidence(phase: 'pending' | 'allow' | 'deny' | 'yolo' = 'allow') {
  const callId = 'provider-call',
    id = 'native-approval';
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        source: { kind: 'user', rpcId: 'native-request' },
        content: [{ type: 'text', text: 'Write owned file' }],
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 0,
        callId,
        name: 'write',
        arguments: JSON.stringify({ file_path: '/data/work/owned.txt', content: 'owned bytes' }),
      },
    },
    ...(phase === 'yolo'
      ? []
      : [{ type: 'approval/asked', data: { id, callId, toolName: 'write' } }]),
    ...(phase === 'pending'
      ? []
      : [
          ...(phase === 'yolo'
            ? []
            : [
                {
                  type: 'approval/decided',
                  data: { id, outcome: phase === 'deny' ? 'rejected' : 'allowed-once' },
                },
              ]),
          {
            type: 'tool/result',
            data: {
              turn: 1,
              step: 0,
              message: {
                role: 'tool',
                toolCallId: callId,
                source: { kind: 'tool', callId },
                isError: phase === 'deny',
              },
            },
          },
          { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant' } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ]),
  ];
  return {
    records: rows.map((event, seq) => ({ type: 'event', event: { ...event, seq } })),
    cursor: rows.length - 1,
    hasMore: false,
    tier: phase === 'yolo' ? 'danger-full-access' : 'approval',
    afterSeq: -1,
    prompt: 'Write owned file',
    path: '/data/work/owned.txt',
    content: 'owned bytes',
    phase,
    file: {
      exists: phase === 'allow' || phase === 'yolo',
      exact: phase === 'allow' || phase === 'yolo',
    },
  };
}

function eventAt(value: ReturnType<typeof evidence>, index: number) {
  const row = value.records[index];
  if (!row) throw new Error('Missing oracle control event');
  return row.event;
}

it.each(['pending', 'allow', 'deny', 'yolo'] as const)(
  'recognizes correlated native %s evidence',
  (phase) => {
    expect(permissionEvidence(evidence(phase))).toMatchObject({
      callId: 'provider-call',
      requestId: 'native-request',
      turn: 1,
    });
  },
);

it('rejects a write that already happened while native approval is pending', () => {
  const value = evidence('pending');
  value.file.exists = true;
  expect(() => permissionEvidence(value)).toThrow('permission-file-state');
});

it.each(['missing', 'gap', 'truncated'] as const)(
  'rejects %s native history rather than treating absence as no asks',
  (failure) => {
    const value = evidence('yolo');
    if (failure === 'missing') value.records.pop();
    if (failure === 'gap') value.records.splice(1, 1);
    if (failure === 'truncated') value.hasMore = true;
    expect(() => permissionEvidence(value)).toThrow('permission-history-incomplete');
  },
);

it.each([
  'wrong-call',
  'wrong-decision',
  'missing-result',
  'unfinished',
  'wrong-bytes',
  'wrong-tier',
  'wrong-prompt',
] as const)('rejects %s evidence for manual authorization', (failure) => {
  const value = evidence();
  if (failure === 'wrong-call')
    eventAt(value, 3).data = {
      id: 'native-approval',
      callId: 'foreign-call',
      toolName: 'write',
    };
  if (failure === 'wrong-decision')
    eventAt(value, 4).data = { id: 'native-approval', outcome: 'rejected' };
  if (failure === 'missing-result') eventAt(value, 5).type = 'step/end';
  if (failure === 'unfinished') eventAt(value, 7).type = 'step/end';
  if (failure === 'wrong-bytes') value.file.exact = false;
  if (failure === 'wrong-tier') value.tier = 'danger-full-access';
  if (failure === 'wrong-prompt') value.prompt = 'A different request';
  expect(() => permissionEvidence(value)).toThrow(/permission-/);
});

it('rejects a Yolo automatic rejection even when no interactive panel was shown', () => {
  const value = evidence('deny');
  value.phase = 'yolo';
  value.tier = 'danger-full-access';
  value.file = { exists: true, exact: true };
  expect(() => permissionEvidence(value)).toThrow('permission-approval-count');
});

it('rejects a supposedly pending request that settled while the other Session ran', () => {
  const value = evidence('allow');
  value.phase = 'pending';
  value.file = { exists: false, exact: false };
  expect(() => permissionEvidence(value)).toThrow('permission-pending-settled');
});

it('rejects denial evidence without a model-facing error result', () => {
  const value = evidence('deny');
  eventAt(value, 5).data = {
    turn: 1,
    step: 0,
    message: {
      role: 'tool',
      toolCallId: 'provider-call',
      isError: false,
      source: { kind: 'tool', callId: 'provider-call' },
    },
  };
  expect(() => permissionEvidence(value)).toThrow('permission-tool-result');
});

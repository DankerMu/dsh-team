import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CdpPage } from '../../scripts/probe-dsh-api-cdp.mjs';
import { expect, it } from 'vitest';
import {
  autoReviewEvidence,
  permissionEvidence,
  permissionFailure,
} from './permission-model-oracle.ts';
import { runPermissionModelScenario } from './permission-model-fixture.mjs';
import { record } from './container-start-docker-fixture.ts';

it('retains the acceptance failure when asynchronous observer diagnostics are unavailable', async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'dsh-team-permission-failure-'));
  const acceptanceFailure = new Error('permission-owned-acceptance-failure');
  const observerFailure = Promise.reject(new Error('Owned observer read failed'));
  // Observe the injected transport rejection even with the pre-cutover fixture,
  // so its missing await fails the report assertion rather than leaking a rejection.
  void observerFailure.catch(() => undefined);
  const page: CdpPage = {
    on() {
      // No browser events are emitted before the injected first-command failure.
    },
    close() {
      throw new Error('Scenario does not own browser closure');
    },
    send(method) {
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: 'aGVsbG8=' });
      return Promise.reject(acceptanceFailure);
    },
  };
  try {
    await expect(
      runPermissionModelScenario({
        page,
        origin: 'http://permission-failure.invalid',
        cookie: 'owned-cookie',
        evidence: evidenceDirectory,
        observe: () => {
          return Promise.reject(
            new Error('File observation must not start before browser initialization'),
          );
        },
        model: 'owned-model',
        reviewObserver: {
          arm() {
            return Promise.reject(new Error('Observer must not arm before browser initialization'));
          },
          observation: () => observerFailure,
        },
      }),
    ).rejects.toBe(acceptanceFailure);

    expect(JSON.parse(await readFile(join(evidenceDirectory, 'permissions.json'), 'utf8'))).toEqual(
      {
        selections: [],
        addresses: [],
        checkpoints: [],
        observerUnavailable: true,
        failure: 'permission-owned-acceptance-failure',
      },
    );
  } finally {
    await rm(evidenceDirectory, { recursive: true, force: true });
  }
});

function evidence(phase: 'pending' | 'allow' | 'deny' | 'unprompted' = 'allow') {
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
    ...(phase === 'unprompted'
      ? []
      : [{ type: 'approval/asked', data: { id, callId, toolName: 'write' } }]),
    ...(phase === 'pending'
      ? []
      : [
          ...(phase === 'unprompted'
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
    tier: phase === 'unprompted' ? 'danger-full-access' : 'approval',
    expectedTier: phase === 'unprompted' ? 'danger-full-access' : 'approval',
    afterSeq: -1,
    prompt: 'Write owned file',
    path: '/data/work/owned.txt',
    content: 'owned bytes',
    phase,
    file: {
      exists: phase === 'allow' || phase === 'unprompted',
      exact: phase === 'allow' || phase === 'unprompted',
    },
  };
}

function eventAt(value: ReturnType<typeof evidence>, index: number) {
  const row = value.records[index];
  if (!row) throw new Error('Missing oracle control event');
  return row.event;
}

function bashEvidence() {
  const value = evidence('unprompted');
  const command = 'printf \'{"owned":true}\\n\'';
  const records = value.records.map((row, index) => {
    if (index === 2)
      return {
        ...row,
        event: {
          ...row.event,
          data: {
            turn: 1,
            step: 0,
            callId: 'provider-call',
            name: 'bash',
            arguments: JSON.stringify({ command }),
          },
        },
      };
    if (index === 3)
      return {
        ...row,
        event: {
          ...row.event,
          data: {
            ...row.event.data,
            message: {
              ...record(record(row.event.data).message),
              content: [{ type: 'text', text: '{"owned":true}\n' }],
            },
          },
        },
      };
    return row;
  });
  return { ...value, command, records };
}

it('binds a Yolo bash receipt to the exact requested command and returns actual stdout', () => {
  expect(permissionEvidence(bashEvidence())).toMatchObject({
    callId: 'provider-call',
    stdout: '{"owned":true}\n',
  });
});

it('rejects a different bash command even when it reports the expected output', () => {
  const value = bashEvidence();
  value.command = 'echo forged-output';
  expect(() => permissionEvidence(value)).toThrow('permission-intended-bash');
});

it('classifies an exact-command rejection without retaining the rejected command', () => {
  const value = bashEvidence();
  value.command = 'private command sentinel';
  let failure: unknown;
  try {
    permissionEvidence(value);
  } catch (error) {
    failure = error;
  }
  expect(permissionFailure(failure)).toEqual({ code: 'permission-intended-bash', detail: null });
});

it.each([
  ['nonzero-exit', '{"owned":true}\n[exit code: 7]'],
  ['signal', '{"owned":true}\n[killed by signal: SIGTERM]'],
  ['timeout', '{"owned":true}\n[timed out after 1000ms]'],
  ['stopped', '{"owned":true}\n[stopped: cancelled]'],
  ['truncated', '{"owned":true}\n[output truncated; full output: /data/work/spill]'],
  ['stderr', '{"owned":true}\n[stderr]\nprobe failed'],
  ['background', 'started background job owned-job'],
  ['promoted', '{"owned":true}\n[still running after 1000ms; moved to background job owned-job]'],
  ['malformed-json', '{"owned":'],
])(
  'rejects and safely classifies %s shell output without accepting a JSON prefix',
  (detail, text) => {
    const value = bashEvidence();
    const message = record(record(value.records[3]?.event.data).message);
    message.content = [{ type: 'text', text }];
    let failure: unknown;
    try {
      permissionEvidence(value);
    } catch (error) {
      failure = error;
    }
    expect(permissionFailure(failure)).toEqual({ code: 'permission-bash-process', detail });
  },
);

it.each([
  new Error('permission-intended-bash private-key-sentinel'),
  Object.assign(new Error('private-cookie-sentinel'), {
    code: 'permission-bash-process',
    detail: 'private-output-sentinel',
    actual: 'private-body-sentinel',
    expected: 'private-prompt-sentinel',
  }),
  new AggregateError([new Error('private-cause-sentinel')], 'permission-provider-attempt'),
  { code: 'permission-intended-bash', message: 'private-command-sentinel' },
])('withholds untrusted diagnostic messages and payloads', (error) => {
  expect(permissionFailure(error)).toEqual({ code: 'unclassified', detail: null });
});

it.each(['foreign-call', 'abort', 'extra-part', 'missing-content'] as const)(
  'rejects %s native bash evidence',
  (failure) => {
    const value = bashEvidence();
    const message = record(record(value.records[3]?.event.data).message);
    if (failure === 'foreign-call') message.toolCallId = 'another-call';
    if (failure === 'abort') message.isError = true;
    if (failure === 'extra-part')
      message.content = [
        { type: 'text', text: '{"owned":true}' },
        { type: 'text', text: 'untrusted trailing result' },
      ];
    if (failure === 'missing-content') message.content = [];
    expect(() => permissionEvidence(value)).toThrow(
      failure === 'foreign-call' || failure === 'abort'
        ? 'permission-tool-result'
        : 'permission-bash-process',
    );
  },
);

it.each(['pending', 'allow', 'deny', 'unprompted'] as const)(
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
    const value = evidence('unprompted');
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
  value.phase = 'unprompted';
  value.tier = 'danger-full-access';
  value.expectedTier = 'danger-full-access';
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

it.each(['pending', 'allow', 'deny', 'unprompted'] as const)(
  'rejects recovered provider failure before accepting %s evidence',
  (phase) => {
    const value = evidence(phase);
    const events: Record<string, unknown>[] = value.records.map((row) => row.event);
    const index =
      phase === 'pending' ? 2 : events.findIndex((event) => event.type === 'tool/result') + 1;
    // Published rc.2 persists failed requests as log-only assistant/attempt,
    // including when the native retry plugin later completes the same turn.
    events.splice(index, 0, {
      type: 'assistant/attempt',
      data: {
        turn: 1,
        step: phase === 'pending' ? 0 : 1,
        stream: [
          {
            type: 'chunk',
            time: 1,
            chunk: {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { code: 'SERVER', message: 'Owned failure control' },
              },
            },
          },
        ],
      },
    });
    const records = events.map((event, seq) => ({ type: 'event', event: { ...event, seq } }));
    expect(() => permissionEvidence({ ...value, records, cursor: records.length - 1 })).toThrow(
      'permission-provider-attempt',
    );
  },
);

function reviewObservation(mode: 'observe' | 'unavailable') {
  const fault = mode === 'unavailable';
  const expected = {
    nonce: 'owned-review',
    sessionId: 'session-a',
    callId: 'provider-call',
    provider: 'intranet',
    model: 'development-model',
    mode,
  };
  const observed = {
    nonce: expected.nonce,
    overflow: false,
    reviews: [
      {
        sessionId: expected.sessionId,
        callId: expected.callId,
        provider: expected.provider,
        model: expected.model,
        mode,
        forwarded: !fault,
        completed: !fault,
        faultInjected: fault,
        finish: fault ? null : 'stop',
        decision: fault ? null : 'allow',
        gate: fault ? 'ask' : 'allow',
        started: 1,
        settled: 2,
        gated: 3,
      },
    ],
  };
  return { expected, observed };
}

it.each(['observe', 'unavailable'] as const)('accepts correlated Auto %s provenance', (mode) => {
  const { expected, observed } = reviewObservation(mode);
  expect(autoReviewEvidence(observed, expected)).toMatchObject({ callId: expected.callId, mode });
});

it.each([
  'missing',
  'duplicate',
  'stale',
  'wrong-session',
  'wrong-call',
  'wrong-route',
  'bypassed',
  'incomplete',
  'denied',
  'premature',
  'overflow',
] as const)(
  'rejects %s Auto provenance rather than inferring a review from file success',
  (failure) => {
    const { expected, observed } = reviewObservation('observe');
    const row = observed.reviews[0];
    if (!row) throw new Error('Missing review control');
    if (failure === 'missing') observed.reviews.length = 0;
    if (failure === 'duplicate') observed.reviews.push({ ...row });
    if (failure === 'stale') observed.nonce = 'previous-operation';
    if (failure === 'wrong-session') row.sessionId = 'session-b';
    if (failure === 'wrong-call') row.callId = 'foreign-call';
    if (failure === 'wrong-route') row.provider = 'simulated-provider';
    if (failure === 'bypassed') row.forwarded = false;
    if (failure === 'incomplete') row.completed = false;
    if (failure === 'denied') row.decision = 'deny';
    if (failure === 'premature') row.gated = 1;
    if (failure === 'overflow') observed.overflow = true;
    expect(() => autoReviewEvidence(observed, expected)).toThrow(/permission-auto-/);
  },
);

it('does not count ordinary policy denial as review unavailability', () => {
  const { expected, observed } = reviewObservation('unavailable');
  const row = observed.reviews[0];
  if (!row) throw new Error('Missing review control');
  row.faultInjected = false;
  row.forwarded = true;
  row.completed = true;
  row.decision = 'deny';
  expect(() => autoReviewEvidence(observed, expected)).toThrow('permission-auto-outcome');
});

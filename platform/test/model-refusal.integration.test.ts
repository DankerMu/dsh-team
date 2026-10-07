import { expect, it } from 'vitest';
import { assertModelRefusal, modelRefusalTurn } from './model-refusal-oracle.ts';
import { execWebScript } from './web-startup-fixture.ts';
import type { DockerCommand } from './docker-command.ts';

// Literal released Session wire facts: prompt rpcId, turn boundaries, and TRANSPORT failure.
const records = [
  { type: 'event', event: { type: 'turn/start', seq: 0, data: { turn: 1 } } },
  {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'user', rpcId: 'prompt-owned' } },
    },
  },
  {
    type: 'event',
    event: {
      type: 'turn/end',
      seq: 2,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } },
      },
    },
  },
];
const observation = {
  accepted: true,
  promptCount: 1,
  sessionId: 'session-owned',
  requestId: 'prompt-owned',
  turn: modelRefusalTurn(records, 'prompt-owned'),
  running: false,
  usedProvider: 'intranet',
  usedModel: 'beta',
  visibleError: true,
  recorder: { baseline: 1, total: 1, inflight: 0, controlStatus: 204, overflow: false },
};

it('accepts a correlated terminal managed connection refusal with an idle reachable recorder', () => {
  expect(modelRefusalTurn(records, 'prompt-owned')).toEqual({
    userSeq: 1,
    turn: 1,
    terminalSeq: 2,
    errorCode: 'TRANSPORT',
    connectionError: true,
  });
  expect(() => {
    assertModelRefusal(observation);
  }).not.toThrow();
});

it('rejects a concrete alternate model request even when the managed turn failed visibly', () => {
  expect(() => {
    assertModelRefusal({ ...observation, recorder: { ...observation.recorder, total: 2 } });
  }).toThrow('alternate requests');
});

it('rejects missing, stale, nonterminal and unrelated failures instead of crediting model refusal', () => {
  for (const bad of [
    { ...observation, accepted: false },
    { ...observation, promptCount: 2 },
    { ...observation, running: true },
    { ...observation, visibleError: false },
    { ...observation, usedProvider: 'personal' },
    { ...observation, recorder: { ...observation.recorder, inflight: 1 } },
    { ...observation, turn: modelRefusalTurn(records.slice(0, 2), 'prompt-owned') },
    { ...observation, turn: modelRefusalTurn(records, 'another-prompt') },
    { ...observation, turn: { ...observation.turn, errorCode: 'MISSING_CREDENTIAL' } },
    { ...observation, turn: { ...observation.turn, errorCode: 'TIMEOUT' } },
    { ...observation, turn: { ...observation.turn, errorCode: 'AUTH' } },
    {
      ...observation,
      turn: modelRefusalTurn(
        [
          ...records.slice(0, 2),
          {
            type: 'event',
            event: {
              type: 'turn/end',
              seq: 2,
              data: {
                turn: 2,
                reason: {
                  kind: 'error',
                  error: { code: 'TRANSPORT', message: 'Connection error.' },
                },
              },
            },
          },
        ],
        'prompt-owned',
      ),
    },
    { ...observation, turn: { ...observation.turn, connectionError: false } },
  ])
    expect(() => {
      assertModelRefusal(bad);
    }).toThrow();
});

it('never probes credentials or endpoints inside an unowned or wrong-image container', () => {
  for (const fault of ['volume', 'container', 'image']) {
    const operations: string[] = [];
    const command: DockerCommand = (args) => {
      operations.push(args[0] ?? '');
      const stdout =
        args[0] === 'volume'
          ? fault === 'volume'
            ? 'foreign'
            : 'owned'
          : JSON.stringify({
              Image: fault === 'image' ? 'foreign-image' : 'captured-image',
              Config: {
                Labels: { 'dsh-team.test-run': fault === 'container' ? 'foreign' : 'owned' },
              },
              State: { Running: true },
            });
      return { status: 0, stdout, stderr: '' };
    };

    expect(() =>
      execWebScript(
        command,
        {
          container: 'owned-web',
          imageId: 'captured-image',
          runId: 'owned',
          stateVolume: 'owned-state',
          workVolume: 'owned-work',
          overlay: '/owned/patch.yml',
          seccomp: '/owned/seccomp.json',
        },
        'process.stdout.write("probe")',
      ),
    ).toThrow(/ownership/);
    expect(operations).not.toContain('exec');
  }
});

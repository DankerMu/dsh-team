import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { apply } from './office-model-observer.mjs';

type Listener = Parameters<Parameters<typeof apply>[0]['on']>[1];
const CHILD = { header: { id: 'writer', origin: 'subagent', parentSession: 'general' } };
const PARENT = { header: { id: 'general' } };

function withObserver(
  body: (fixture: { path: string; emit: Listener; result: () => Record<string, unknown> }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-office-checkpoint-'));
  const path = join(root, 'document');
  const control = join(root, 'control.json');
  const evidence = join(root, 'evidence.json');
  let emit: Listener = () => {
    throw new Error('Observer not attached');
  };
  // Real filesystem/subprocess observation; this boundary test does not pretend
  // these bytes are a DOCX or these emitted records are a native runtime run.
  const reader = `import {existsSync,readFileSync} from 'node:fs';
const path=${JSON.stringify(path)};
process.stdout.write(JSON.stringify(existsSync(path)?{status:'present',content:readFileSync(path,'utf8')}:{status:'missing'}));`;
  try {
    writeFileSync(control, JSON.stringify({ nonce: 'owned', reader }));
    apply(
      {
        on(_name, listener) {
          emit = listener;
        },
      },
      { control, evidence },
    );
    body({
      path,
      emit: (...args) => {
        emit(...args);
      },
      result: () => record(JSON.parse(readFileSync(evidence, 'utf8'))),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('captures child bytes synchronously before a parent can replace them after completion', () => {
  withObserver(({ path, emit, result }) => {
    emit(PARENT, { type: 'user/message', seq: 0, data: { source: { kind: 'user' } } });
    emit(PARENT, { type: 'tool/call', seq: 1, data: { callId: 'delegate', name: 'subagent' } });
    emit(CHILD, { type: 'turn/start', seq: 3, data: {} });
    writeFileSync(path, 'child-authored document');

    emit(CHILD, { type: 'turn/end', seq: 7, data: {} });
    emit(PARENT, { type: 'tool/call', seq: 2, data: { callId: 'verify', name: 'bash' } });
    writeFileSync(path, 'parent-edited document');

    expect(result()).toMatchObject({
      nonce: 'owned',
      parentId: 'general',
      childId: 'writer',
      startSeq: 3,
      endSeq: 7,
      confounded: false,
      before: { status: 'missing' },
      after: { status: 'present', content: 'child-authored document' },
    });
    expect(readFileSync(path, 'utf8')).toBe('parent-edited document');
  });
});

it('does not attribute a parent-only artifact created after an empty child completes', () => {
  withObserver(({ path, emit, result }) => {
    emit(CHILD, { type: 'turn/start', seq: 3, data: {} });
    emit(CHILD, { type: 'turn/end', seq: 7, data: {} });

    writeFileSync(path, 'parent-only document');

    expect(result().after).toEqual({ status: 'missing' });
    expect(readFileSync(path, 'utf8')).toBe('parent-only document');
  });
});

it.each(['before', 'during'])(
  'marks another Agent tool already active or started %s the child as ambiguous',
  (when) => {
    withObserver(({ path, emit, result }) => {
      const other = () => {
        emit(PARENT, { type: 'tool/call', seq: 1, data: { callId: 'other', name: 'bash' } });
      };
      if (when === 'before') other();
      emit(CHILD, { type: 'turn/start', seq: 3, data: {} });
      if (when === 'during') other();
      writeFileSync(path, 'unattributed bytes');

      emit(CHILD, { type: 'turn/end', seq: 7, data: {} });

      expect(result().confounded).toBe(true);
      expect(result().after).toEqual({ status: 'present', content: 'unattributed bytes' });
    });
  },
);

it('does not treat a returned parent shell job as settled file effects', () => {
  withObserver(({ path, emit, result }) => {
    emit(PARENT, { type: 'user/message', seq: 0, data: { source: { kind: 'user' } } });
    emit(PARENT, { type: 'tool/call', seq: 1, data: { callId: 'background', name: 'bash' } });
    emit(PARENT, { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'background' } } });
    emit(CHILD, { type: 'turn/start', seq: 3, data: {} });
    writeFileSync(path, 'bytes from possible parent background work');

    emit(CHILD, { type: 'turn/end', seq: 7, data: {} });

    expect(result().confounded).toBe(true);
  });
});

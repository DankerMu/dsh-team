import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import { apply } from './office-model-observer.mjs';

type Listener = Parameters<Parameters<typeof apply>[0]['on']>[1];
type Session = Parameters<Listener>[0];
const CHILD = { header: { id: 'writer', origin: 'subagent', parentSession: 'general' } };
const PARENT = { header: { id: 'general' } };
const DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const MESSAGE = {
  role: 'tool',
  toolCallId: 'construct',
  source: { kind: 'tool', callId: 'construct' },
};

function withObserver(
  body: (fixture: {
    path: string;
    emit: Listener;
    result: () => Record<string, unknown>;
    arm: (nonce: string) => void;
  }) => void,
  readerOverride?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-office-checkpoint-'));
  const path = join(root, 'document');
  const control = join(root, 'control.json');
  const evidence = join(root, 'evidence.json');
  let emit: Listener = () => {
    throw new Error('Observer not attached');
  };
  // Real filesystem/subprocess boundary, synthetic Session records and reader
  // envelope. Native DOCX parsing, uid1001 and committed events need Docker proof.
  const reader =
    readerOverride ??
    `import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const path=${JSON.stringify(path)};
const bytes=existsSync(path)?readFileSync(path):null;
process.stdout.write(JSON.stringify(bytes?{status:'parsed',path,uid:1001,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),paragraphs:[bytes.toString('utf8')]}:{status:'missing',path,uid:1001}));`;
  const arm = (nonce: string) => {
    writeFileSync(control, JSON.stringify({ nonce, reader }));
  };
  try {
    arm('owned');
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
      arm,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function startWriter(emit: Listener, session: Session = CHILD) {
  emit(session, {
    type: 'subagent/descriptor',
    seq: 1,
    data: { version: 1, mode: 'one-shot', provider: 'spawn', label: 'notice' },
  });
  emit(session, {
    type: 'agent-preset/selected',
    seq: 2,
    data: { agentPreset: 'office-writer' },
  });
  emit(session, { type: 'turn/start', seq: 3, data: { turn: 1 } });
  emit(session, {
    type: 'user/message',
    seq: 4,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'supplied draft' }] },
  });
}

function armParent(emit: Listener) {
  emit(PARENT, { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } });
  emit(PARENT, {
    type: 'tool/call',
    seq: 3,
    data: { turn: 1, step: 1, callId: 'delegate', name: 'subagent' },
  });
}

function constructionCall(path: string, change: Record<string, unknown> = {}) {
  return {
    type: 'tool/call',
    seq: 5,
    data: {
      turn: 1,
      step: 1,
      callId: 'construct',
      name: 'build_docx',
      arguments: JSON.stringify({ path, paragraphs: [{ text: 'abc' }] }),
      ...change,
    },
  };
}

function constructionResult(path: string, change: Record<string, unknown> = {}) {
  return {
    type: 'tool/result',
    seq: 6,
    data: {
      turn: 1,
      step: 1,
      message: MESSAGE,
      meta: { path, bytes: 3, sha256: DIGEST, uid: 1001 },
      ...change,
    },
  };
}

it('captures construction bytes at the committed result before child completion or parent edits', () => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(path));
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(path));
    const checkpoint = result();
    writeFileSync(path, 'parent-edited document');
    emit(CHILD, {
      type: 'turn/end',
      seq: 7,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    expect(checkpoint).toEqual({
      nonce: 'owned',
      parentId: 'general',
      childId: 'writer',
      callSeq: 5,
      resultSeq: 6,
      callId: 'construct',
      turn: 1,
      step: 1,
      receipt: { path, bytes: 3, sha256: DIGEST, uid: 1001 },
      artifact: {
        status: 'parsed',
        path,
        uid: 1001,
        bytes: 3,
        sha256: DIGEST,
        paragraphs: ['abc'],
      },
    });
    expect(result()).toEqual(checkpoint);
    expect(readFileSync(path, 'utf8')).toBe('parent-edited document');
  });
});

it('allows parent draft preparation and unrelated tool work without process-census attribution', () => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    emit(PARENT, {
      type: 'tool/call',
      seq: 4,
      data: { turn: 1, step: 1, callId: 'draft', name: 'bash' },
    });
    writeFileSync(path, 'parent-supplied draft');
    startWriter(emit);
    // The builder remains create-only; the observer need not require absence
    // at child start when a supplied draft is removed before construction.
    rmSync(path);
    emit(CHILD, constructionCall(path));
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(path));

    expect(result()).toMatchObject({
      childId: 'writer',
      receipt: { sha256: DIGEST, bytes: 3 },
      artifact: { sha256: DIGEST, paragraphs: ['abc'] },
    });
  });
});

it.each(['bash', 'write', 'edit', 'read'])(
  'does not capture a %s-only child as construction',
  (name) => {
    withObserver(({ path, emit, result }) => {
      armParent(emit);
      startWriter(emit);
      emit(CHILD, constructionCall(path, { name }));
      writeFileSync(path, 'abc');

      emit(CHILD, constructionResult(path));
      emit(CHILD, {
        type: 'turn/end',
        seq: 7,
        data: { turn: 1, reason: { kind: 'completed' } },
      });

      expect(result()).not.toHaveProperty('receipt');
      expect(result()).not.toHaveProperty('artifact');
    });
  },
);

it.each([
  { label: 'wrong call', change: { message: { ...MESSAGE, toolCallId: 'other' } } },
  {
    label: 'wrong source call',
    change: { message: { ...MESSAGE, source: { kind: 'tool', callId: 'other' } } },
  },
  {
    label: 'non-tool source',
    change: { message: { ...MESSAGE, source: { kind: 'user', callId: 'construct' } } },
  },
  { label: 'failed execution', change: { message: { ...MESSAGE, isError: true } } },
  {
    label: 'cancelled execution',
    change: {
      message: { ...MESSAGE, isError: true },
      error: { name: 'ToolError', code: 'cancelled' },
    },
  },
  {
    label: 'native error with success-shaped message',
    change: { error: { name: 'ToolError', code: 'failed' } },
  },
  { label: 'missing durable metadata', change: { meta: undefined } },
])('does not capture $label with an otherwise matching construction call', ({ change }) => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(path));
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(path, change));

    expect(result()).not.toHaveProperty('receipt');
    expect(result()).not.toHaveProperty('artifact');
  });
});

it.each([
  { label: 'another turn', change: { turn: 0 } },
  { label: 'another step', change: { step: 2 } },
])(
  'does not consume a pending construction when a result from $label reuses its call ID',
  ({ change }) => {
    withObserver(({ path, emit, result }) => {
      armParent(emit);
      startWriter(emit);
      emit(CHILD, constructionCall(path));
      writeFileSync(path, 'abc');

      emit(CHILD, constructionResult(path, change));
      expect(result()).not.toHaveProperty('receipt');
      emit(CHILD, { ...constructionResult(path), seq: 7 });

      expect(result()).toMatchObject({
        callSeq: 5,
        resultSeq: 7,
        callId: 'construct',
        turn: 1,
        step: 1,
        receipt: { sha256: DIGEST },
      });
    });
  },
);

it.each([
  { label: 'parent', session: PARENT },
  { label: 'sibling', session: { header: { ...CHILD.header, id: 'sibling' } } },
  { label: 'another Session object with the same ID', session: { header: { ...CHILD.header } } },
])('does not pair a writer call with the $label result', ({ session }) => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(path));
    writeFileSync(path, 'abc');

    emit(session, constructionResult(path));
    expect(result()).not.toHaveProperty('receipt');
    emit(CHILD, constructionResult(path));

    expect(result()).toMatchObject({
      childId: 'writer',
      callSeq: 5,
      resultSeq: 6,
      receipt: { sha256: DIGEST },
    });
  });
});

it.each([
  { label: 'unrelated parent', header: { ...CHILD.header, parentSession: 'unrelated' } },
  { label: 'root Session', header: { id: 'writer' } },
  { label: 'fork Session', header: { ...CHILD.header, origin: 'fork' } },
])('does not collect construction from an $label', ({ header }) => {
  withObserver(({ path, emit, result }) => {
    const session = { header };
    armParent(emit);
    startWriter(emit, session);
    emit(session, constructionCall(path));
    writeFileSync(path, 'abc');

    emit(session, constructionResult(path));

    expect(result()).not.toHaveProperty('receipt');
  });
});

it.each([
  { label: 'prior turn', change: { turn: 0 } },
  { label: 'prior step', change: { step: 0 } },
])(
  'pairs reused call IDs by turn and step rather than overwriting the current call with a $label',
  ({ change }) => {
    withObserver(({ path, emit, result }) => {
      armParent(emit);
      startWriter(emit);
      emit(CHILD, constructionCall(path));
      emit(CHILD, { ...constructionCall(path, change), seq: 6 });
      writeFileSync(path, 'abc');

      emit(CHILD, { ...constructionResult(path), seq: 7 });

      expect(result()).toMatchObject({
        callSeq: 5,
        resultSeq: 7,
        callId: 'construct',
        turn: 1,
        step: 1,
        receipt: { sha256: DIGEST },
      });
    });
  },
);

it('does not accept an unpaired or out-of-order committed result', () => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(path));
    expect(result()).not.toHaveProperty('receipt');
    emit(CHILD, constructionCall(path));
    emit(CHILD, { ...constructionResult(path), seq: 4 });

    expect(result()).not.toHaveProperty('receipt');
  });
});

it('does not reuse a call from a previous observation nonce', () => {
  withObserver(({ path, emit, result, arm }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(path));
    arm('next-observation');
    armParent(emit);
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(path));

    expect(result()).not.toHaveProperty('receipt');
  });
});

it('fails closed when the synchronous artifact reader fails at the construction result', () => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(path));

    emit(CHILD, constructionResult(path));

    expect(result()).toEqual({ failure: 'office-observation-failed' });
  }, 'process.exit(7)');
});

it('does not let construction of another document consume the requested target checkpoint', () => {
  withObserver(({ path, emit, result }) => {
    armParent(emit);
    startWriter(emit);
    emit(CHILD, constructionCall(`${path}.draft`));
    writeFileSync(path, 'abc');

    emit(CHILD, constructionResult(`${path}.draft`));
    expect(result()).not.toHaveProperty('receipt');
    emit(CHILD, { ...constructionCall(path, { step: 2 }), seq: 7 });
    emit(CHILD, { ...constructionResult(path, { step: 2 }), seq: 8 });

    expect(result()).toMatchObject({
      callSeq: 7,
      resultSeq: 8,
      callId: 'construct',
      turn: 1,
      step: 2,
      receipt: { path, sha256: DIGEST },
      artifact: { path, sha256: DIGEST },
    });
  });
});

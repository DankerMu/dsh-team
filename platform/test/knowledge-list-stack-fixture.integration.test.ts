import { describe, expect, it } from 'vitest';
import {
  listEvidence,
  listResultsOf,
  listSteps,
  ownedList,
} from './knowledge-list-stack-fixture.ts';
import type { ListDriver } from './knowledge-list-stack-fixture.ts';

const POLICIES = 'dsh-team-seed-policies';
const SEEDS = [POLICIES, 'dsh-team-seed-products', 'dsh-team-seed-minutes'];
const FILES = ['attendance-policy.txt', 'expense-policy.txt'];
const POLICIES_ID = '1'.repeat(32);
const IDS = [POLICIES_ID, '2'.repeat(32), '3'.repeat(32), '0'.repeat(32)];

const listed = (libraries: string[]) => {
  const title = `本轮可查看的知识库：${String(libraries.length)} 个`;
  return {
    text: [title, ...libraries.map((name) => `- ${name}`)].join('\n'),
    meta: { result: 'ok', libraries, title },
    isError: false,
  };
};
const paged = (files = FILES, extra: Record<string, unknown> = {}) => {
  const title = `知识库「${POLICIES}」中文件：共 2 个，第 1/1 页`;
  return {
    text: [title, ...files.map((name) => `- ${name}`)].join('\n'),
    meta: { result: 'ok', library: POLICIES, files, total: 2, page: 1, pages: 1, title, ...extra },
    isError: false,
  };
};

describe('ownedList', () => {
  it('scripts a fresh marker and the policies library', () => {
    const [first, second] = [ownedList(), ownedList()];

    expect(first.library).toBe(POLICIES);
    expect(first.marker).toMatch(/^stack-list-[0-9a-f-]{36}$/);
    expect(second.marker).not.toBe(first.marker);
  });
});

describe('listResultsOf', () => {
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) => ({ seq: seq++, type, data });
  const call = (callId: string, name: string) => event('tool/call', { callId, name });
  const result = (callId: string, text: string, meta?: unknown) =>
    event('tool/result', {
      message: { toolCallId: callId, content: [{ type: 'text', text }], isError: false },
      meta,
    });

  it('pairs each list call with its native result, in order, ignoring other tools', () => {
    const events = [
      call('a', 'knowledge_base_list'),
      call('w', 'write'),
      result('w', 'written'),
      result('a', 'first', { result: 'ok' }),
      call('b', 'knowledge_base_list'),
    ];

    expect(listResultsOf(events)).toEqual([
      { text: 'first', meta: { result: 'ok' }, isError: false },
      undefined,
    ]);
    expect(listResultsOf([call('s', 'knowledge_base_search')])).toEqual([]);
  });
});

describe('listEvidence', () => {
  it('accepts exactly the policies library, then its two files', () => {
    expect(listEvidence([listed([POLICIES]), paged()], 'policies', IDS)).toEqual({
      scope: 'policies',
      libraries: [POLICIES],
      files: FILES,
      total: 2,
    });
  });

  it('accepts the whole scope when every seed library is among the listed ones', () => {
    const libraries = ['本地其他库', ...SEEDS];

    expect(listEvidence([listed(libraries), paged([...FILES].reverse())], 'whole', IDS)).toEqual({
      scope: 'whole',
      libraries,
      files: [...FILES].reverse(),
      total: 2,
    });
  });

  const failed = { text: '知识库返回了异常的列表，请稍后重试', meta: { result: 'upstream-error' } };
  it.each([
    ['no calls', [], 'calls unexpected'],
    ['one call', [listed([POLICIES])], 'calls unexpected'],
    ['three calls', [listed([POLICIES]), paged(), paged()], 'calls unexpected'],
    ['a pending call', [listed([POLICIES]), undefined], 'calls unexpected'],
    ['a failed call', [listed([POLICIES]), { ...failed, isError: false }], 'result not a clean ok'],
    [
      'an error result',
      [{ ...listed([POLICIES]), isError: true }, paged()],
      'result not a clean ok',
    ],
    [
      'a text without its title',
      [{ ...listed([POLICIES]), text: '- x' }, paged()],
      'result not a clean ok',
    ],
    ['a widened scope', [listed([POLICIES, SEEDS[1] ?? '']), paged()], 'libraries unexpected'],
    ['another file count', [listed([POLICIES]), paged(FILES, { total: 3 })], 'files unexpected'],
    ['another library', [listed([POLICIES]), paged(FILES, { library: 'x' })], 'files unexpected'],
    ['a missing file', [listed([POLICIES]), paged([FILES[0] ?? ''])], 'files unexpected'],
    [
      'a name missing from the text',
      [{ ...listed([POLICIES]), text: listed([POLICIES]).meta.title }, paged()],
      'text without its names',
    ],
  ])('rejects %s under the policies scope', (_label, results, reason) => {
    expect(() => listEvidence(results, 'policies', IDS)).toThrow(`List policies ${reason}`);
  });

  it('rejects a whole scope missing a seed library', () => {
    expect(() => listEvidence([listed(SEEDS.slice(0, 2)), paged()], 'whole', IDS)).toThrow(
      'List whole libraries unexpected',
    );
  });

  it('rejects any dataset ID in a text or a meta and names outcomes only', () => {
    const leaked = { ...paged(), text: `${paged().text}\n${POLICIES_ID}` };
    const inMeta = paged(FILES, { id: POLICIES_ID });

    for (const second of [leaked, inMeta]) {
      const failure = (() => {
        try {
          listEvidence([listed([POLICIES]), second], 'policies', IDS);
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
        return '';
      })();
      expect(failure).toBe('List policies result not a clean ok (calls=2 ok,ok)');
      expect(failure).not.toContain(POLICIES_ID);
    }
  });
});

describe('listSteps', () => {
  const list = ownedList();
  const events = (libraries: string[]) =>
    [listed(libraries), paged()].flatMap(({ text, meta }, index) => [
      {
        seq: 2 * index,
        type: 'tool/call',
        data: { callId: `c${String(index)}`, name: 'knowledge_base_list' },
      },
      {
        seq: 2 * index + 1,
        type: 'tool/result',
        data: {
          message: {
            toolCallId: `c${String(index)}`,
            content: [{ type: 'text', text }],
            isError: false,
          },
          meta,
        },
      },
    ]);
  const history: Record<string, unknown[]> = {
    scoped: events([POLICIES]),
    whole: events(['本地其他库', ...SEEDS]),
  };
  const scenario = {
    // The released projection/page RPC: one complete page per Session.
    rpc: (method: string, args: unknown) => {
      const { request } = args as {
        request: { sessionId?: string; address?: { sessionId: string } };
      };
      const id = request.sessionId ?? request.address?.sessionId ?? '';
      return Promise.resolve(
        method === 'session/projections'
          ? { asOfSeq: 3 }
          : { records: (history[id] ?? []).map((event) => ({ event })), hasMore: false },
      );
    },
    policies: { id: POLICIES_ID, name: POLICIES },
    ids: IDS,
    list,
  };
  /** A recording driver whose open popover shows `checked`. */
  const driver = (checked: readonly string[]) => {
    const calls: string[] = [];
    const sessions = ['scoped', 'whole'];
    const scope: ListDriver = {
      newSession: () => Promise.resolve(sessions.shift() ?? 'extra'),
      command: (id, line, selection) =>
        Promise.resolve(calls.push(`command ${id} ${line} ${JSON.stringify(selection)}`)),
      expectScope: (id, selection) =>
        Promise.resolve(calls.push(`scope ${id} ${JSON.stringify(selection)}`)),
      open: () => Promise.resolve({ list: (calls.push('open'), { checked }) }),
      close: () => Promise.resolve(calls.push('close')),
      send: (id, text) => Promise.resolve(calls.push(`send ${id} ${text}`)),
      turnEnd: (id) => Promise.resolve(calls.push(`end ${id}`)),
    };
    return { calls, scope };
  };

  it('checks the scoped popover before the scoped turn, then lists in both Sessions', async () => {
    const { calls, scope } = driver([POLICIES_ID]);
    const selection = JSON.stringify([POLICIES_ID]);

    expect((await listSteps(scope, scenario)).map(({ scope: kind }) => kind)).toEqual([
      'policies',
      'whole',
    ]);
    expect(calls).toEqual([
      `command scoped /kb-scope {"datasetIds":${selection}} ${selection}`,
      `scope scoped ${selection}`,
      'open',
      'close',
      `send scoped ${list.marker} 知识库里有哪些文件`,
      'end scoped',
      'scope whole null',
      `send whole ${list.marker} 知识库里有哪些文件`,
      'end whole',
    ]);
  });

  it('fails before any turn when the popover does not show the scoped library checked', async () => {
    const { calls, scope } = driver([]);

    await expect(listSteps(scope, scenario)).rejects.toThrow();
    expect(calls.some((call) => call.startsWith('send'))).toBe(false);
  });
});

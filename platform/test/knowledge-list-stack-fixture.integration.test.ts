import { describe, expect, it } from 'vitest';
import { listEvidence, listResultsOf, ownedList } from './knowledge-list-stack-fixture.ts';

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

import { describe, expect, it } from 'vitest';
import {
  childSessionOf,
  scopeCommandOutcome,
  searchCard,
  searchCardPhase,
  searchEvidence,
  searchOutcome,
  searchResultOf,
  settledAfter,
} from './knowledge-search-stack-fixture.ts';

const POLICIES = { id: '1'.repeat(32), name: 'dsh-team-seed-policies' };
const MISSING = '0'.repeat(32);
const IDS = [POLICIES.id, '2'.repeat(32), '3'.repeat(32), MISSING];
const CHILD = 'child-session-7';
const SELECTION = [POLICIES.id, MISSING];

let seq = 0;
const event = (type: string, data: Record<string, unknown>) => ({ seq: seq++, type, data });
const call = (callId: string, name: string) => event('tool/call', { callId, name, arguments: {} });
const result = (callId: string, text: string, extra: Record<string, unknown> = {}) =>
  event('tool/result', {
    message: { toolCallId: callId, content: [{ type: 'text', text }], isError: false },
    ...extra,
  });
const run = (commandId: string, datasetIds: unknown) =>
  event('command/run', {
    commandId,
    name: 'kb-scope',
    args: JSON.stringify({ datasetIds }),
  });

const CHUNK = {
  content: '提交发票',
  documentName: 'expense-policy.txt',
  datasetName: POLICIES.name,
};
const TEXT = `知识库检索：1 条结果\n有 1 个已选知识库已不可用，已跳过\n\n[1] 文件：expense-policy.txt；所属知识库：${POLICIES.name}\n提交发票`;
const META = { result: 'ok', title: '知识库检索：1 条结果', excluded: 1, chunks: [CHUNK] };
const searched = (text = TEXT, meta: unknown = META, isError = false) => ({ text, meta, isError });
const ROOT = { expected: SELECTION, turn: { turn: 1, scope: SELECTION } };

describe('childSessionOf', () => {
  it('reads the child Session from the root subagent result text', () => {
    expect(childSessionOf([call('a', 'subagent'), result('a', `started subagent ${CHILD}`)])).toBe(
      CHILD,
    );
  });

  it('is undefined until the subagent result arrives', () => {
    expect(childSessionOf([])).toBeUndefined();
    expect(childSessionOf([call('a', 'subagent')])).toBeUndefined();
    expect(childSessionOf([call('b', 'write'), result('b', 'written')])).toBeUndefined();
  });

  it.each([
    ['two subagent calls', [call('a', 'subagent'), call('b', 'subagent')]],
    ['a result text without an ID', [call('a', 'subagent'), result('a', 'subagent failed')]],
    [
      'an error result',
      [
        call('a', 'subagent'),
        event('tool/result', {
          message: { toolCallId: 'a', content: [{ type: 'text', text: 'x' }], isError: true },
        }),
      ],
    ],
  ])('fails for %s', (_label, events) => {
    expect(() => childSessionOf(events)).toThrow(/^Root subagent delegation malformed$/);
  });
});

describe('searchResultOf', () => {
  it('reads the one search result text and meta', () => {
    const events = [call('s', 'knowledge_base_search'), result('s', TEXT, { meta: META })];

    expect(searchResultOf(events)).toEqual({ text: TEXT, meta: META, isError: false });
  });

  it('is undefined until the search result arrives', () => {
    expect(searchResultOf([call('s', 'knowledge_base_search')])).toBeUndefined();
    expect(searchResultOf([])).toBeUndefined();
  });

  it('fails for more than one search call', () => {
    const events = [call('s', 'knowledge_base_search'), call('t', 'knowledge_base_search')];

    expect(() => searchResultOf(events)).toThrow(/^Child search history malformed$/);
  });
});

describe('searchEvidence', () => {
  it('keeps only the outcome, counts and library names', () => {
    expect(searchEvidence(searched(), POLICIES.name, IDS, ROOT)).toEqual({
      result: 'ok',
      chunks: 1,
      datasetNames: [POLICIES.name],
      documentNames: ['expense-policy.txt'],
      excluded: 1,
    });
  });

  it.each([
    ['an error result', searched(TEXT, META, true)],
    ['a missing title', searched(TEXT.replace('知识库检索：', ''))],
    ['a missing exclusion note', searched(TEXT.replace('有 1 个', '有 2 个'))],
    ['another outcome', searched(TEXT, { ...META, result: 'no-results', chunks: [] })],
    ['no chunks', searched(TEXT, { ...META, chunks: [] })],
    ['another exclusion count', searched(TEXT, { ...META, excluded: 2 })],
    ['a widened scope', searched(TEXT, { ...META, chunks: [{ ...CHUNK, datasetName: 'other' }] })],
    ['a dataset ID in the text', searched(`${TEXT}\n${IDS[1] ?? ''}`)],
    ['a dataset ID in the meta', searched(TEXT, { ...META, title: MISSING })],
    ['a malformed meta', searched(TEXT, [])],
  ])('fails for %s without echoing the result', (_label, observed) => {
    const check = () => searchEvidence(observed, POLICIES.name, IDS, ROOT);

    expect(check).toThrow(/^Child search (result|scope) /);
    try {
      check();
    } catch (error) {
      expect(String(error)).not.toContain('提交发票');
      expect(String(error)).not.toMatch(/[0-9a-f]{32}/);
    }
  });
});

describe('scopeCommandOutcome', () => {
  it('pairs the run carrying the selection with its done and counts turn starts', () => {
    const events = [
      run('c1', null),
      event('command/done', { commandId: 'c1', kind: 'success' }),
      run('c2', SELECTION),
      event('command/done', { commandId: 'c2', kind: 'success' }),
    ];

    expect(scopeCommandOutcome(events, SELECTION)).toEqual({ done: 'success', turnStarts: 0 });
  });

  it('reports a pending or failed command and every turn start', () => {
    expect(scopeCommandOutcome([run('c', SELECTION)], SELECTION)).toEqual({
      done: 'pending',
      turnStarts: 0,
    });
    const failed = [
      run('c', SELECTION),
      event('command/done', { commandId: 'c', kind: 'error' }),
      event('turn/start', { turn: 1 }),
    ];
    expect(scopeCommandOutcome(failed, SELECTION)).toEqual({ done: 'error', turnStarts: 1 });
    expect(scopeCommandOutcome([run('c', [POLICIES.id])], SELECTION)).toEqual({
      done: 'missing',
      turnStarts: 0,
    });
  });
});

describe('settledAfter', () => {
  const start = (turn: number) => event('turn/start', { turn });
  const end = (turn: number) => event('turn/end', { turn });

  it('waits for a later turn and for every started turn to end', () => {
    expect(settledAfter([start(1), end(1)], 1)).toBe(false);
    expect(settledAfter([start(1), end(1), start(2)], 1)).toBe(false);
    expect(settledAfter([start(1), end(1), start(2), end(2)], 1)).toBe(true);
    expect(settledAfter([start(1), end(1), start(2), end(2), start(3)], 1)).toBe(false);
  });
});

describe('searchCard', () => {
  const page = (fields: Record<string, unknown>) => ({
    folds: 1,
    foldOpen: true,
    foldClicked: false,
    groups: 1,
    groupsOpen: true,
    groupsClicked: false,
    cards: 1,
    visible: 1,
    ...fields,
  });
  const closed = { cards: 0, visible: 0 };

  it('reads the turn fold, the step groups, the counted cards and the visible ones', () => {
    expect(searchCard(page({}))).toEqual({ fold: 'open', group: 'open', cards: 1, visible: 1 });
    expect(searchCard(page({ visible: 0 }))).toEqual({
      fold: 'open',
      group: 'open',
      cards: 1,
      visible: 0,
    });
    expect(
      searchCard(page({ groups: 0, groupsOpen: null, cards: 2, groupsClicked: true })),
    ).toEqual({ fold: 'open', group: 'none', cards: 2, visible: 1 });
  });

  it.each([
    ['no turn fold', { folds: 0, foldOpen: null, groups: 0, groupsOpen: null }, 'missing'],
    [
      'a fold without a disclosure state',
      { foldOpen: null, groups: 0, groupsOpen: null },
      'missing',
    ],
    ['a collapsed turn fold', { foldOpen: false, groups: 0, groupsOpen: null }, 'collapsed'],
    ['an open turn fold', { folds: 2 }, 'open'],
  ])('names the turn fold state of %s', (_label, fields, fold) => {
    expect(searchCard(page({ ...fields, ...closed })).fold).toBe(fold);
  });

  it.each([
    ['no step group', { groups: 0, groupsOpen: null }, 'none'],
    ['a collapsed step group', { groups: 2, groupsOpen: false }, 'collapsed'],
    ['open step groups', { groups: 2, groupsOpen: true }, 'open'],
  ])('names the step group state of %s', (_label, fields, group) => {
    expect(searchCard(page({ ...fields, ...closed })).group).toBe(group);
  });

  it.each([
    ['no state', null],
    ['an array', []],
    ['a text card count', page({ cards: '1' })],
    ['a negative card count', page({ cards: -1 })],
    ['a fractional card count', page({ cards: 0.5 })],
    ['a text visible count', page({ visible: '1' })],
    ['more visible cards than cards', page({ visible: 2 })],
    ['a negative fold count', page({ folds: -1 })],
    ['a text fold count', page({ folds: '1' })],
    ['a text fold state', page({ foldOpen: 'true' })],
    ['a text fold click', page({ foldClicked: 'true' })],
    ['a text group count', page({ groups: '1' })],
    ['a text group state', page({ groupsOpen: 'true' })],
    ['a text group click', page({ groupsClicked: 'true' })],
    ['a group state without groups', page({ groups: 0, groupsOpen: true })],
    ['groups without a group state', page({ groups: 1, groupsOpen: null })],
    ['a missing visible count', { ...page({}), visible: undefined }],
    [
      'cards counted under a collapsed fold',
      page({ foldOpen: false, groups: 0, groupsOpen: null }),
    ],
    ['cards counted without a fold', page({ foldOpen: null, groups: 0, groupsOpen: null })],
    ['groups read under a collapsed fold', page({ foldOpen: false, ...closed })],
    ['cards counted under a collapsed group', page({ groupsOpen: false })],
    ['card text leaving the page', page({ text: '' })],
  ])('fails for %s', (_label, value) => {
    expect(() => searchCard(value)).toThrow(/^Search card state malformed$/);
  });
});

describe('searchCardPhase', () => {
  const state = (fold: string, group: string, cards = 0, visible = 0) => ({
    fold,
    group,
    cards,
    visible,
  });

  it.each([
    [undefined, 'card state unread'],
    [state('missing', 'none'), 'turn fold not found'],
    [state('collapsed', 'none'), 'turn fold still collapsed'],
    [state('open', 'collapsed'), 'step group still collapsed'],
    [state('open', 'open'), 'fold expanded but no card'],
    [state('open', 'none'), 'fold expanded but no card'],
    [state('open', 'open', 1), 'fold expanded but no visible card'],
    [state('open', 'open', 1, 1), 'card visible'],
    [state('open', 'none', 2, 1), 'card visible'],
  ] as const)('names the step a card wait stopped at for %j', (shown, phase) => {
    expect(searchCardPhase(shown as Parameters<typeof searchCardPhase>[0])).toBe(phase);
  });
});

describe('searchOutcome', () => {
  it.each([
    ['ok', TEXT, 'ok'],
    ['no-results', '知识库中没有找到相关内容\n有 1 个已选知识库已不可用，已跳过', 'no-results'],
    ['scope-unavailable', '无法确定本轮的检索范围，未检索', 'scope-unavailable'],
    ['invalid-question', '检索问题为空或过长，未检索', 'invalid-question'],
    ['timeout', '知识库检索超时，请稍后重试', 'timeout'],
    ['upstream-error', '知识库返回了异常结果，请稍后重试', 'upstream-error'],
  ])('names the %s outcome by its meta and its text', (result, text, named) => {
    expect(searchOutcome(searched(text, { ...META, result }))).toBe(
      `meta=${result} text=${named} excluded=1`,
    );
  });

  it('names an unknown meta, an unrecognized text and an error without echoing either', () => {
    const outcome = searchOutcome(searched(`提交发票 ${MISSING}`, { result: MISSING }, true));

    expect(outcome).toBe('meta=unknown text=unrecognized error excluded=unknown');
  });

  it.each([
    ['two excluded libraries', { ...META, excluded: 2 }, 'excluded=2'],
    ['no excluded library', { ...META, excluded: 0 }, 'excluded=0'],
    ['a negative count', { ...META, excluded: -1 }, 'excluded=unknown'],
    ['a fractional count', { ...META, excluded: 1.5 }, 'excluded=unknown'],
    ['a text count', { ...META, excluded: '1' }, 'excluded=unknown'],
  ])('counts the excluded libraries of %s', (_label, meta, counted) => {
    expect(searchOutcome(searched(TEXT, meta))).toBe(`meta=ok text=ok ${counted}`);
  });

  it.each([
    ['the selected scope', SELECTION, 'scope=2 same'],
    ['every library', null, 'scope=all differs'],
    ['no library', [], 'scope=none differs'],
    ['only the kept library', [POLICIES.id], 'scope=1 differs'],
    ['the same IDs in another order', [MISSING, POLICIES.id], 'scope=2 differs'],
  ])('sizes a root turn snapshot of %s without naming an ID', (_label, scope, sized) => {
    const outcome = searchOutcome(searched(), { expected: SELECTION, turn: { turn: 3, scope } });

    expect(outcome).toBe(`meta=ok text=ok excluded=1 ${sized}`);
    expect(outcome).not.toMatch(/[0-9a-f]{32}/);
  });

  it('names a root without a turn snapshot', () => {
    expect(searchOutcome(searched(), { expected: SELECTION, turn: null })).toBe(
      'meta=ok text=ok excluded=1 scope=no-turn',
    );
  });

  it('carries the outcome and the root snapshot in every evidence failure', () => {
    const observed = searched('知识库中没有找到相关内容', {
      ...META,
      result: 'no-results',
      chunks: [],
    });

    expect(() => searchEvidence(observed, POLICIES.name, IDS, ROOT)).toThrow(
      'Child search result title missing (meta=no-results text=no-results excluded=1 scope=2 same)',
    );
  });
});

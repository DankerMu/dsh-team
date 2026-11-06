import type { Page } from '@playwright/test';
import { expect } from 'vitest';
import type { PanelNeedles } from './knowledge-panel-stack-fixture.ts';
import { readScope, scopeSession } from './knowledge-scope-stack-fixture.ts';
import type { ScopeDriver, ScopeSelection, ScopeValue } from './knowledge-scope-stack-fixture.ts';
import { sessionEvents } from './owned-completion-fixture.ts';
import type { SessionAddress, SessionRpc } from './owned-completion-fixture.ts';
import { until } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

type HistoryEvent = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const dataOf = (event: HistoryEvent) => (isRecord(event.data) ? event.data : {});

const TOOL = 'knowledge_base_search';
// The owned provider's subagent `description` (deployment-model-wire.ts DELEGATION_TITLE): the
// released subagent catalog lists the child under it.
const CHILD_TITLE = '检索知识库';
const STARTED = /^started subagent (\S+)$/;

/** The calls named `name` in a history, and the native result of one call ID. */
const callsNamed = (events: readonly HistoryEvent[], name: string) =>
  events.filter((event) => event.type === 'tool/call' && dataOf(event).name === name);
function resultOf(events: readonly HistoryEvent[], callId: unknown) {
  const found = events.find(
    (event) =>
      event.type === 'tool/result' &&
      isRecord(dataOf(event).message) &&
      (dataOf(event).message as Record<string, unknown>).toolCallId === callId,
  );
  if (found === undefined) return undefined;
  const data = dataOf(found);
  const message = data.message as Record<string, unknown>;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((block: unknown) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('');
  return { text, meta: data.meta, isError: message.isError === true };
}

const DELEGATION_MALFORMED = 'Root subagent delegation malformed';

/**
 * The child Session ID from the root's one `subagent` result, whose text is the released
 * `started subagent <id>` (the root's `tool/result` keeps no value); undefined until it arrives.
 */
export function childSessionOf(events: readonly HistoryEvent[]): string | undefined {
  const calls = callsNamed(events, 'subagent');
  if (calls.length > 1) throw new Error(DELEGATION_MALFORMED);
  const [only] = calls;
  if (only === undefined) return undefined;
  const result = resultOf(events, dataOf(only).callId);
  if (result === undefined) return undefined;
  const id = result.isError ? undefined : STARTED.exec(result.text)?.[1];
  if (id === undefined) throw new Error(DELEGATION_MALFORMED);
  return id;
}

/** What the child's one search call returned in its native history. */
export interface SearchResult {
  readonly text: string;
  readonly meta: unknown;
  readonly isError: boolean;
}

/** The child's only `knowledge_base_search` result; undefined until it arrives. */
export function searchResultOf(events: readonly HistoryEvent[]): SearchResult | undefined {
  const calls = callsNamed(events, TOOL);
  if (calls.length > 1) throw new Error('Child search history malformed');
  const [only] = calls;
  return only === undefined ? undefined : resultOf(events, dataOf(only).callId);
}

// The plugin's fixed outcome texts (plugins/knowledge-base/index.js OUTCOME_TEXTS); `ok` opens
// with its counted title. platform/ never imports plugins/, so the closed set is restated here.
const OK_TITLE = '知识库检索：';
const OUTCOME_TEXTS: Readonly<Record<string, string>> = {
  'no-results': '知识库中没有找到相关内容',
  'no-scope': '本轮没有选择知识库，未检索',
  'no-datasets': '平台上还没有任何知识库，未检索',
  'scope-unavailable': '无法确定本轮的检索范围，未检索',
  'invalid-question': '检索问题为空或过长，未检索',
  'invalid-request': '检索请求无效',
  'not-configured': '知识库未配置，请联系管理员',
  timeout: '知识库检索超时，请稍后重试',
  unavailable: '知识库暂时不可用，请稍后重试',
  'upstream-error': '知识库返回了异常结果，请稍后重试',
};
const OUTCOMES = new Set(['ok', ...Object.keys(OUTCOME_TEXTS)]);

/** The root turn snapshot a child copied at creation, and the selection the step saved. */
export interface RootScope {
  readonly expected: ScopeSelection;
  readonly turn: ScopeValue['turn'];
}

/** A snapshot's kind and size (`all`, `none` or a count) and whether it is the saved selection. */
function rootScopeOf({ expected, turn }: RootScope): string {
  if (turn === null) return 'scope=no-turn';
  const { scope } = turn;
  const size = scope === null ? 'all' : scope.length === 0 ? 'none' : String(scope.length);
  const same = JSON.stringify(scope) === JSON.stringify(expected) ? 'same' : 'differs';
  return `scope=${size} ${same}`;
}

/**
 * Which closed outcome a result names, once by its `meta.result` and once by its text's opening
 * fixed text (anything else is `unknown`/`unrecognized`), how many selected libraries the proxy
 * excluded, and, when given, the root snapshot's size. Never the text, a chunk or an ID.
 */
export function searchOutcome(observed: SearchResult, root?: RootScope): string {
  const { meta, text } = observed;
  const result = isRecord(meta) && typeof meta.result === 'string' ? meta.result : undefined;
  const named = result !== undefined && OUTCOMES.has(result) ? result : 'unknown';
  const opening = text.startsWith(OK_TITLE)
    ? 'ok'
    : (Object.entries(OUTCOME_TEXTS).find(([, fixed]) => text.startsWith(fixed))?.[0] ??
      'unrecognized');
  const count = isRecord(meta) ? meta.excluded : undefined;
  const excluded = Number.isSafeInteger(count) && Number(count) >= 0 ? String(count) : 'unknown';
  const parts = [`meta=${named}`, `text=${opening}${observed.isError ? ' error' : ''}`];
  parts.push(`excluded=${excluded}`);
  if (root !== undefined) parts.push(rootScopeOf(root));
  return parts.join(' ');
}

/** The search step's evidence: no chunk content, no dataset ID. */
export interface SearchFacts {
  readonly result: string;
  readonly chunks: number;
  readonly datasetNames: readonly string[];
  readonly documentNames: readonly string[];
  readonly excluded: number;
}

/**
 * A successful policies-only search over the two-ID scope: the text and the card meta report
 * one excluded library, every chunk belongs to `datasetName`, and neither carries any of `ids`.
 * Failures name the broken property, the outcome and the size of `root`'s snapshot only.
 */
export function searchEvidence(
  observed: SearchResult,
  datasetName: string,
  ids: readonly string[],
  root: RootScope,
): SearchFacts {
  const fail = (what: string) =>
    new Error(`Child search ${what} (${searchOutcome(observed, root)})`);
  if (observed.isError) throw fail('result failed');
  if (!observed.text.includes(OK_TITLE)) throw fail('result title missing');
  if (!observed.text.includes('有 1 个已选知识库已不可用，已跳过'))
    throw fail('result exclusion note missing');
  const { meta } = observed;
  if (!isRecord(meta) || !Array.isArray(meta.chunks)) throw fail('result meta malformed');
  if (meta.result !== 'ok' || meta.excluded !== 1 || meta.chunks.length === 0)
    throw fail('result outcome unexpected');
  const chunks = meta.chunks.filter(isRecord);
  const datasetNames = [...new Set(chunks.map((chunk) => chunk.datasetName))];
  if (chunks.length !== meta.chunks.length || datasetNames.join() !== datasetName)
    throw fail('scope widened beyond the selected library');
  const shown = `${observed.text}${JSON.stringify(meta)}`;
  if (ids.some((id) => shown.includes(id))) throw fail('result carries a dataset ID');
  return {
    result: meta.result,
    chunks: chunks.length,
    datasetNames: [datasetName],
    documentNames: [...new Set(chunks.map((chunk) => String(chunk.documentName)))],
    excluded: meta.excluded,
  };
}

/**
 * The `command/done` kind of the last `kb-scope` run carrying `selection` (`pending` without it,
 * `missing` without such a run), and how many turns the Session has started.
 */
export function scopeCommandOutcome(events: readonly HistoryEvent[], selection: ScopeSelection) {
  const wanted = JSON.stringify({ datasetIds: selection });
  const runs = events.filter((event) => {
    const data = dataOf(event);
    if (event.type !== 'command/run' || data.name !== 'kb-scope') return false;
    return typeof data.args === 'string' && data.args.trim() === wanted;
  });
  const commandId = runs.length === 0 ? undefined : dataOf(runs[runs.length - 1] ?? {}).commandId;
  const done = events.find(
    (event) => event.type === 'command/done' && dataOf(event).commandId === commandId,
  );
  const kind = dataOf(done ?? {}).kind;
  return {
    done: commandId === undefined ? 'missing' : typeof kind === 'string' ? kind : 'pending',
    turnStarts: events.filter((event) => event.type === 'turn/start').length,
  };
}

/** A turn after `turn` has ended and every started turn has ended. */
export function settledAfter(events: readonly HistoryEvent[], turn: number): boolean {
  const turns = (type: string) =>
    events.filter((event) => event.type === type).map((event) => Number(dataOf(event).turn));
  const ends = turns('turn/end');
  return (
    ends.some((end) => end > turn) && turns('turn/start').every((start) => ends.includes(start))
  );
}

// The released client folds a settled Turn behind its process button (dsh-client-ui-chat
// TurnProcessNodeView: `button[data-turn-process]` naming the Turn, `aria-expanded` only when it
// has content, the Turn's tool-call count in `data-turn-process-tool-calls`), and inside it each
// step group behind its own header (ChatGroupSeat root `[data-step-process][data-chat-turn]`,
// ProcessGroupHeader `button[data-process-activity][aria-controls]` with `aria-expanded`). Folded
// content can stay mounted but clipped, so the disclosures decide, not card presence: the first
// live fold of a Turn with tool calls is clicked open while it reads "false" and `click.fold`
// holds; once it reads "true", every collapsed group header of that Turn is clicked open while
// `click.groups` holds; cards (the released ToolRow root `data-tool`, dsh-client-ui-tool) are
// counted only when the fold and all of the Turn's groups read "true". A card is visible when,
// scrolled to the centre, its rect has a size and the element at its centre lies inside it. With
// exactly one visible card, its own row (the primitives' DisclosureRow with `expandOnRowClick`:
// `[data-disclosure-row]`, `role="button"` and `aria-expanded` while expandable) is clicked open
// while it reads "false" and `click.row` holds; once it reads "true" the card's text, which then
// includes the `tool/result` output, is matched against the expected strings in the page. Only
// counts and booleans leave the page, never a card's text.
const CARD = (
  childId: string,
  click: { readonly fold: boolean; readonly groups: boolean; readonly row: boolean },
  expected: CardTexts,
) => `(() => {
  const live = (node) => node.closest('[inert]') === null && node.getClientRects().length > 0;
  const view = document.querySelector('[data-conversation-session="' + ${JSON.stringify(childId)} + '"]') || document;
  const folds = [...view.querySelectorAll('button[data-turn-process]')]
    .filter(live)
    .filter((fold) => Number(fold.getAttribute('data-turn-process-tool-calls')) > 0);
  const fold = folds[0];
  const disclosure = fold === undefined ? null : fold.getAttribute('aria-expanded');
  const foldOpen = disclosure === 'true' ? true : disclosure === 'false' ? false : null;
  const foldClicked = ${JSON.stringify(click.fold)} && foldOpen === false && !fold.disabled;
  if (foldClicked) fold.click();
  const state = {
    folds: folds.length, foldOpen, foldClicked, groups: 0, groupsOpen: null, groupsClicked: false,
    cards: 0, visible: 0, rowOpen: null, rowClicked: false, title: false, excluded: false, dataset: false,
  };
  if (foldOpen !== true) return state;
  const turn = fold.getAttribute('data-turn-process');
  const headers = [...view.querySelectorAll('[data-step-process][data-chat-turn]')]
    .filter((group) => group.getAttribute('data-chat-turn') === turn)
    .flatMap((group) => [...group.querySelectorAll('button[data-process-activity][aria-controls]')])
    .filter(live);
  const collapsed = headers.filter((header) => header.getAttribute('aria-expanded') !== 'true');
  state.groups = headers.length;
  state.groupsOpen = headers.length === 0 ? null : collapsed.length === 0;
  state.groupsClicked = ${JSON.stringify(click.groups)} && collapsed.length > 0;
  if (state.groupsClicked) for (const header of collapsed) header.click();
  if (state.groupsOpen === false) return state;
  const cards = [...view.querySelectorAll('[data-tool="${TOOL}"]')].filter(live);
  const shown = (card) => {
    card.scrollIntoView({ block: 'center' });
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && card.contains(hit);
  };
  const visible = cards.filter(shown);
  state.cards = cards.length;
  state.visible = visible.length;
  if (visible.length !== 1) return state;
  const card = visible[0];
  const row = card.querySelector('[data-disclosure-row][aria-expanded]');
  if (row === null) return state;
  state.rowOpen = row.getAttribute('aria-expanded') === 'true';
  state.rowClicked = ${JSON.stringify(click.row)} && !state.rowOpen;
  if (state.rowClicked) row.click();
  if (!state.rowOpen) return state;
  const text = card.innerText;
  state.title = text.includes(${JSON.stringify(expected.title)});
  state.excluded = text.includes(${JSON.stringify(expected.excluded)});
  state.dataset = text.includes(${JSON.stringify(expected.dataset)});
  return state;
})()`;

/** The strings the expanded search row must show; fixed texts and a library name, never an ID. */
export interface CardTexts {
  readonly title: string;
  readonly excluded: string;
  readonly dataset: string;
}

/** The expanded row's expected texts for a search whose native history holds `chunks` chunks. */
export function cardTexts(chunks: number, datasetName: string): CardTexts {
  return {
    title: `${OK_TITLE}${String(chunks)} 条结果`,
    excluded: '有 1 个已选知识库已不可用，已跳过',
    dataset: `所属知识库：${datasetName}`,
  };
}

/** What a card wait observed: the disclosures, the card counts and the matched texts. */
export interface SearchCardState {
  /** `missing`: no live fold of a Turn with tool calls carries a disclosure state. */
  readonly fold: 'missing' | 'collapsed' | 'open';
  /** `none`: the open Turn shows no step group header; `collapsed`: one of them is closed. */
  readonly group: 'none' | 'collapsed' | 'open';
  readonly cards: number;
  readonly visible: number;
  /** `none`: no single visible card, or its row is not expandable. */
  readonly row: 'none' | 'collapsed' | 'open';
  readonly title: boolean;
  readonly excluded: boolean;
  readonly dataset: boolean;
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const isState = (value: unknown) => value === null || typeof value === 'boolean';
const FLAGS = ['foldClicked', 'groupsClicked', 'rowClicked', 'title', 'excluded', 'dataset'];
const CARD_KEYS = [
  ...FLAGS,
  ...['folds', 'foldOpen', 'groups', 'groupsOpen', 'cards', 'visible', 'rowOpen'],
]
  .sort()
  .join();

/**
 * The page reads groups only under an open fold, cards only when every group is open, the row
 * only beside exactly one visible card, and texts only under an open row.
 */
function consistentCard(value: Record<string, unknown>) {
  const read = value.title === true || value.excluded === true || value.dataset === true;
  if (Number(value.visible) > Number(value.cards)) return false;
  if ((value.groups === 0) !== (value.groupsOpen === null)) return false;
  if (value.rowOpen !== null && value.visible !== 1) return false;
  if (read && value.rowOpen !== true) return false;
  if (value.foldOpen !== true) return value.groups === 0 && value.cards === 0;
  return value.groupsOpen !== false || value.cards === 0;
}

/** The in-page card state: exactly its counts and booleans, nothing else. */
export function searchCard(value: unknown): SearchCardState {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== CARD_KEYS ||
    ![value.folds, value.groups, value.cards, value.visible].every(isCount) ||
    ![value.foldOpen, value.groupsOpen, value.rowOpen].every(isState) ||
    !FLAGS.every((flag) => typeof value[flag] === 'boolean') ||
    !consistentCard(value)
  )
    throw new Error('Search card state malformed');
  const disclosure = <T extends string>(open: unknown, none: T) =>
    open === null ? none : open === true ? 'open' : 'collapsed';
  return {
    fold: disclosure(value.foldOpen, 'missing'),
    group: disclosure(value.groupsOpen, 'none'),
    cards: Number(value.cards),
    visible: Number(value.visible),
    row: disclosure(value.rowOpen, 'none'),
    title: value.title === true,
    excluded: value.excluded === true,
    dataset: value.dataset === true,
  };
}

/** Where a card wait stopped, for its failure message. */
export function searchCardPhase(state: SearchCardState | undefined): string {
  if (state === undefined) return 'card state unread';
  if (state.fold === 'missing') return 'turn fold not found';
  if (state.fold === 'collapsed') return 'turn fold still collapsed';
  if (state.group === 'collapsed') return 'step group still collapsed';
  if (state.cards === 0) return 'fold expanded but no card';
  if (state.visible === 0) return 'fold expanded but no visible card';
  if (state.visible > 1) return 'more than one visible card';
  if (state.row === 'none') return 'card row not found';
  if (state.row === 'collapsed') return 'card row still collapsed';
  const shows = state.title && state.excluded && state.dataset;
  return shows ? 'card verified' : 'card without expected content';
}

/** Everything the search step needs from the stack test; values stay in memory. */
export interface SearchScenario {
  readonly session: StackSession;
  readonly rpc: SessionRpc;
  /** The one library the root scope keeps; its ID and the fake one form the scope. */
  readonly policies: { readonly id: string; readonly name: string };
  readonly missingId: string;
  /** Every seed dataset ID and the fake one: none may reach a text or a meta. */
  readonly ids: readonly string[];
  readonly childMarker: string;
  readonly needles: () => Promise<PanelNeedles>;
}

export interface SearchEvidence {
  readonly browser: StackBrowserEvidence;
  readonly facts: SearchFacts;
  /** Wall time of each step; every wait in a step is bounded by `waitLimitMs`. */
  readonly elapsedMs: Readonly<Record<string, number>>;
  readonly waitLimitMs: number;
  readonly screenshot: string;
}

/** Opens the child's own view through the released subagent catalog of the current root. */
async function openChild(page: Page, timeout: number) {
  const triggers = page.locator('button[aria-haspopup="tree"]:not([inert] *)');
  await until(
    async () => {
      for (const trigger of await triggers.all()) {
        const label = (await trigger.getAttribute('aria-label')) ?? '';
        if (/子智能体|subagents?/i.test(label) && !/切换|Switch/.test(label)) {
          await trigger.click();
          return true;
        }
      }
      return false;
    },
    timeout,
    'subagent catalog',
  );
  await page.locator(`[role="treeitem"][aria-label^="${CHILD_TITLE} "]`).first().click({ timeout });
  const switched = [`切换子智能体：${CHILD_TITLE}`, `Switch subagent: ${CHILD_TITLE}`]
    .map((label) => `button[aria-haspopup="tree"][aria-label="${label}"]`)
    .join(',');
  await page.locator(switched).first().waitFor({ state: 'visible', timeout });
}

/** Steps 1 and 2: the root scope, the delegated child's search and the native history checks. */
async function delegatedSearch(
  scenario: SearchScenario,
  scope: ScopeDriver,
  timed: <T>(step: string, body: () => Promise<T>) => Promise<T>,
) {
  const { rpc, policies, missingId, session } = scenario;
  const selection = [policies.id, missingId];
  const root = await timed('session', () => scope.newSession(new Set()));
  await timed('scope', async () => {
    await scope.command(root, `/kb-scope ${JSON.stringify({ datasetIds: selection })}`, selection);
    const { shown, value } = await scope.expectScope(root, selection);
    expect(shown.label).toBe('知识库：2 个');
    expect(value.turn).toBeNull();
    expect(scopeCommandOutcome(await sessionEvents(rpc, root), selection)).toEqual({
      done: 'success',
      turnStarts: 0,
    });
    // The deleted library is not listed; the kept one stays checked.
    expect((await scope.open()).list?.checked).toEqual([policies.id]);
    await scope.close();
  });
  const turn = await timed('delegation', () =>
    scope.send(root, `${scenario.childMarker} 请把知识库检索委派给公文与材料写作`),
  );
  const child: { id?: string | undefined } = {};
  await timed('child', () =>
    until(
      async () => (child.id = childSessionOf(await sessionEvents(rpc, root))) !== undefined,
      session.timeout,
      'child delegation',
    ),
  );
  const childSessionId = String(child.id);
  const address: SessionAddress = {
    kind: 'subagent',
    parentSessionId: root,
    childSessionId,
    mode: 'continuable',
  };
  const found: { result?: SearchResult | undefined } = {};
  await timed('search', () =>
    until(
      async () => {
        found.result = searchResultOf(await sessionEvents(rpc, childSessionId, address));
        return found.result !== undefined;
      },
      session.timeout,
      'child search',
    ),
  );
  // What the child copied: the root's turn snapshot, unchanged since the delegating turn started.
  const rootScope: RootScope = { expected: selection, turn: (await readScope(rpc, root)).turn };
  // The settled child wakes its parent for one more turn; the root is idle after it.
  await timed('settle', () =>
    until(
      async () => settledAfter(await sessionEvents(rpc, root), turn),
      session.timeout,
      'root wake turn',
    ),
  );
  // Read again once everything settled: still exactly one search call in the child.
  const settled = searchResultOf(await sessionEvents(rpc, childSessionId, address));
  if (settled === undefined) throw new Error('Child search result missing');
  return {
    childSessionId,
    facts: searchEvidence(settled, policies.name, scenario.ids, rootScope),
  };
}

/**
 * The retrieval step (#421) on a new root Session: a two-ID scope with a deleted library, a
 * delegation to 公文与材料写作 whose child searches, the native history of both Sessions, and the
 * source card in the child's own view.
 */
export async function searchScenario(scenario: SearchScenario): Promise<SearchEvidence> {
  const elapsedMs: Record<string, number> = {};
  const timed = async <T>(step: string, body: () => Promise<T>) => {
    const started = performance.now();
    try {
      return await body();
    } finally {
      elapsedMs[step] = Math.round(performance.now() - started);
    }
  };
  const result: { facts?: SearchFacts } = {};
  const browser = await scopeSession(scenario, 'search', async (scope, page, tools) => {
    const { childSessionId, facts } = await delegatedSearch(scenario, scope, timed);
    result.facts = facts;
    const { timeout } = scenario.session;
    const shown: { state?: SearchCardState } = {};
    await timed('card', async () => {
      await openChild(page, timeout);
      // The turn fold, the Turn's step groups and the card's own row are each clicked open at
      // most once on this page, never toggled back.
      const clicked = { fold: false, groups: false, row: false };
      const expected = cardTexts(facts.chunks, scenario.policies.name);
      try {
        await until(
          async () => {
            const click = { fold: !clicked.fold, groups: !clicked.groups, row: !clicked.row };
            const state = await page.evaluate<unknown>(CARD(childSessionId, click, expected));
            if (isRecord(state) && state.foldClicked === true) clicked.fold = true;
            if (isRecord(state) && state.groupsClicked === true) clicked.groups = true;
            if (isRecord(state) && state.rowClicked === true) clicked.row = true;
            shown.state = searchCard(state);
            return searchCardPhase(shown.state) === 'card verified';
          },
          timeout,
          'search card',
        );
      } catch (error) {
        throw new Error(`Search card not reached (${searchCardPhase(shown.state)})`, {
          cause: error,
        });
      }
    });
    // The poll that ended the wait scrolled the expanded card into view and matched its texts;
    // the screenshot follows it at once, so the evidence shows the state asserted here.
    expect(shown.state).toMatchObject({
      fold: 'open',
      cards: 1,
      visible: 1,
      row: 'open',
      title: true,
      excluded: true,
      dataset: true,
    });
    expect(shown.state?.group).not.toBe('collapsed');
    await tools.shoot('search-sources');
  });
  if (result.facts === undefined) throw new Error('Search evidence missing');
  return {
    browser,
    facts: result.facts,
    elapsedMs,
    waitLimitMs: scenario.session.timeout,
    screenshot: 'search-sources.png',
  };
}

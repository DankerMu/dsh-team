import type { Page } from '@playwright/test';
import { expect } from 'vitest';
import {
  expectNoPanelSecrets,
  panelDriver,
  resourceScan,
  routeAnswer,
} from './knowledge-panel-stack-fixture.ts';
import type { PanelNeedles } from './knowledge-panel-stack-fixture.ts';
import { sessionEvents } from './owned-completion-fixture.ts';
import type { SessionRpc } from './owned-completion-fixture.ts';
import { composerState, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

/** null: every library; otherwise the selected dataset IDs. */
export type ScopeSelection = readonly string[] | null;

/** The host's `kbScope` wire view. */
export interface ScopeValue {
  readonly child: boolean;
  readonly selection: ScopeSelection;
  readonly turn: { readonly turn: number; readonly scope: ScopeSelection } | null;
}

const STATES = ['all', 'none', 'some'] as const;
const LIST_STATES = ['loading', 'not-configured', 'failed', 'empty', 'no-match', 'list'] as const;

/** What the composer control and the session tree show, read in the page. */
export interface ScopeSnapshot {
  /** The control's `data-dsh-team-kb-scope`, or null when it is not rendered. */
  readonly state: (typeof STATES)[number] | null;
  readonly label: string | null;
  /** The open popover's library list; `pending` while any checkbox is disabled. */
  readonly list: {
    readonly state: (typeof LIST_STATES)[number];
    readonly ids: readonly string[];
    readonly checked: readonly string[];
    readonly pending: boolean;
  } | null;
  readonly error: boolean;
  /** The selected session-tree row's Session ID (`aria-selected="true"`). */
  readonly current: string | null;
}

// The control and popover come from client.js; the row key and selection from the released
// 0.2.1-rc.2 workspace tree (dsh-client-ui-workspace lib/client.js, `data-row-key` session rows).
const SNAPSHOT = `(() => {
  const text = (node) => (node === null ? null : (node.textContent || '').trim());
  const live = (node) => node.closest('[inert]') === null && node.getClientRects().length > 0;
  const root = [...document.querySelectorAll('[data-dsh-team-kb-scope]')].find(live) || null;
  const list = root === null ? null : root.querySelector('[data-dsh-team-kb-scope-state]');
  const boxes = list === null ? [] : [...list.querySelectorAll('input[data-dsh-team-kb-scope-dataset]')];
  const id = (box) => box.getAttribute('data-dsh-team-kb-scope-dataset');
  const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
  return {
    state: root === null ? null : root.getAttribute('data-dsh-team-kb-scope'),
    label: root === null ? null : text(root.querySelector('button[aria-haspopup="dialog"]')),
    list: list === null ? null : {
      state: list.getAttribute('data-dsh-team-kb-scope-state'),
      ids: boxes.map(id),
      checked: boxes.filter((box) => box.checked).map(id),
      pending: boxes.some((box) => box.disabled),
    },
    error: root !== null && root.querySelector('[data-dsh-team-kb-scope-error]') !== null,
    current: row === null ? null : row.getAttribute('data-row-key').slice('session:'.length),
  };
})()`;

const MALFORMED = 'Knowledge scope snapshot malformed';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
function strings(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(message);
  return value;
}
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function scopeList(value: unknown): ScopeSnapshot['list'] {
  if (value === null) return null;
  if (!isRecord(value) || !oneOf(LIST_STATES, value.state) || typeof value.pending !== 'boolean')
    throw new Error(MALFORMED);
  const ids = strings(value.ids, MALFORMED);
  return {
    state: value.state,
    ids,
    checked: strings(value.checked, MALFORMED),
    pending: value.pending,
  };
}

/** The in-page snapshot, checked field by field; anything else fails the session. */
export function scopeSnapshot(value: unknown): ScopeSnapshot {
  if (!isRecord(value) || typeof value.error !== 'boolean') throw new Error(MALFORMED);
  const { state, label, current } = value;
  if (state !== null && !oneOf(STATES, state)) throw new Error(MALFORMED);
  if (!nullableString(label) || !nullableString(current) || current === '')
    throw new Error(MALFORMED);
  return {
    state,
    label,
    list: scopeList(value.list),
    error: value.error,
    current,
  };
}

/** The control's button text for a selection. */
export function scopeLabel(selection: ScopeSelection): string {
  if (selection === null) return '知识库：全部';
  return selection.length === 0 ? '知识库：不检索' : `知识库：${String(selection.length)} 个`;
}

const UNAVAILABLE = 'kbScope projection unavailable';
function selectionOf(value: unknown, message: string): ScopeSelection {
  return value === null ? null : strings(value, message);
}

/** The `kbScope` value of a `session/projections` answer; only an exact (sequenced) read counts. */
export function scopeValue(projections: unknown): ScopeValue {
  if (!isRecord(projections) || projections.kind !== 'sequenced' || !isRecord(projections.values))
    throw new Error(UNAVAILABLE);
  const view = projections.values.kbScope;
  if (!isRecord(view) || typeof view.child !== 'boolean') throw new Error(UNAVAILABLE);
  const selection = selectionOf(view.selection, UNAVAILABLE);
  if (view.turn === null) return { child: view.child, selection, turn: null };
  const turn = view.turn;
  if (!isRecord(turn) || !Number.isSafeInteger(turn.turn)) throw new Error(UNAVAILABLE);
  const scope = selectionOf(turn.scope, UNAVAILABLE);
  return { child: view.child, selection, turn: { turn: Number(turn.turn), scope } };
}

/** One Session's `kbScope` through the gateway; a failed or null read is the fixed failure. */
export async function readScope(rpc: SessionRpc, sessionId: string): Promise<ScopeValue> {
  let projections: unknown;
  try {
    projections = await rpc('session/projections', { request: { sessionId } });
  } catch {
    throw new Error(UNAVAILABLE);
  }
  return scopeValue(projections);
}

const HISTORY_MALFORMED = 'kb-scope command history malformed';
type HistoryEvent = Record<string, unknown>;
const dataOf = (event: HistoryEvent) => (isRecord(event.data) ? event.data : {});

/** The native `kb-scope` command runs in log order, each with the selection its line carried. */
export function scopeRuns(events: readonly HistoryEvent[]) {
  return events
    .filter((event) => event.type === 'command/run' && dataOf(event).name === 'kb-scope')
    .map((event) => {
      const { args } = dataOf(event);
      if (!Number.isSafeInteger(event.seq) || typeof args !== 'string')
        throw new Error(HISTORY_MALFORMED);
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.trim());
      } catch {
        throw new Error(HISTORY_MALFORMED);
      }
      if (!isRecord(parsed) || Object.keys(parsed).join() !== 'datasetIds')
        throw new Error(HISTORY_MALFORMED);
      return {
        seq: Number(event.seq),
        selection: selectionOf(parsed.datasetIds, HISTORY_MALFORMED),
      };
    });
}

const sameSelection = (left: ScopeSelection, right: ScopeSelection) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The one event of `type` for `turn`, or the fixed failure naming what is missing. */
function turnEvent(events: readonly HistoryEvent[], type: 'turn/start' | 'turn/end', turn: number) {
  const found = events.filter((event) => event.type === type && dataOf(event).turn === turn);
  const [event] = found;
  if (found.length !== 1 || event === undefined)
    throw new Error(`turn ${String(turn)} ${type === 'turn/start' ? 'start' : 'end'} missing`);
  return Number(event.seq);
}

/**
 * Where the last run setting `selection` falls against the one whole `turn`: before its
 * `turn/start`, between its start and `turn/end`, or after its end.
 */
export function commandSide(
  events: readonly HistoryEvent[],
  turn: number,
  selection: ScopeSelection,
): 'before' | 'during' | 'after' {
  const start = turnEvent(events, 'turn/start', turn);
  const end = turnEvent(events, 'turn/end', turn);
  const run = scopeRuns(events)
    .filter((item) => sameSelection(item.selection, selection))
    .at(-1);
  if (run === undefined) throw new Error('kb-scope command missing');
  if (run.seq < start) return 'before';
  return run.seq < end ? 'during' : 'after';
}

/**
 * The live main transcript of one Session: present, carrying the prompt just sent (the positive
 * control), and free of the control's command line and summary text.
 */
export function transcriptCheck(
  text: string | null,
  prompt: string,
): 'quiet' | 'missing' | 'prompt-missing' | 'leak' {
  if (text === null) return 'missing';
  if (!text.includes(prompt)) return 'prompt-missing';
  return text.includes('kb-scope') || text.includes('知识库范围') ? 'leak' : 'quiet';
}

/** Whether the native history holds the end of `turn`. */
export function turnEnded(events: readonly HistoryEvent[], turn: number): boolean {
  return events.some((event) => event.type === 'turn/end' && dataOf(event).turn === turn);
}

const countOf = (selection: ScopeSelection) => (selection === null ? 'all' : selection.length);

const CREATION_MALFORMED = 'Session creation answer malformed';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The Session a browser `session/create` answer names: a reused blank keeps its ID, a fresh one
 * gets a new one. The workbench selects it only afterwards, so the page is not read for it.
 */
export function createdSessionId(body: unknown): string {
  if (!isRecord(body) || body.type !== 'server-response' || !isRecord(body.result))
    throw new Error(CREATION_MALFORMED);
  const { ok, value } = body.result;
  const id = ok === true && isRecord(value) ? value.sessionId : undefined;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(CREATION_MALFORMED);
  return id;
}

/**
 * Which side of a scope step stalled, without IDs or names: the button text, whether the page
 * shows the expected Session, the popover's pending flag and list state, the host's selection.
 */
export function scopeStall(
  snapshot: ScopeSnapshot,
  id: string,
  host: ScopeValue | 'unavailable',
): string {
  const session =
    snapshot.current === null ? 'none' : snapshot.current === id ? 'expected' : 'other';
  const pending = snapshot.list === null ? 'none' : String(snapshot.list.pending);
  const list = snapshot.list === null ? 'closed' : snapshot.list.state;
  const selected = host === 'unavailable' ? host : String(countOf(host.selection));
  const turn = host === 'unavailable' ? host : String(host.turn?.turn ?? 'none');
  return `button=${snapshot.label ?? 'none'} session=${session} pending=${pending} list=${list} host=${selected} turn=${turn}`;
}

/** One step's evidence: the button text, the selected and snapshot library counts, a screenshot. */
export interface ScopeStep {
  readonly step: string;
  readonly button: string;
  readonly selected: number | 'all';
  readonly snapshot: number | 'all' | null;
  readonly screenshot?: string;
}

export function scopeStep(
  step: string,
  snapshot: ScopeSnapshot,
  value: ScopeValue,
  screenshot?: string,
): ScopeStep {
  if (snapshot.label === null) throw new Error('Knowledge scope control not rendered');
  return {
    step,
    button: snapshot.label,
    selected: countOf(value.selection),
    snapshot: value.turn === null ? null : countOf(value.turn.scope),
    ...(screenshot === undefined ? {} : { screenshot: `${screenshot}.png` }),
  };
}

/**
 * The released 0.2.1-rc.2 sidebar's always-visible top button (dsh-client-ui-sidebar lib/client.js,
 * SidebarRoot `newSession`): name 「新建会话」, text 「新会话」 while the sidebar is wide. The brand
 * button shares the name but not the text; the workspace row's 「在“<name>”中新建会话」 icon is
 * hover-only and is not used.
 */
const newSessionButton = (page: Page) =>
  page.getByRole('button', { name: '新建会话', exact: true }).filter({ hasText: '新会话' });
const TOGGLE = '[data-dsh-team-kb-scope] button[aria-haspopup="dialog"]:not([inert] *)';
const POPOVER = '[data-dsh-team-kb-scope] [role="dialog"]:not([inert] *)';

/**
 * In-page actions on the one composer card that holds the visible scope control: its editor, its
 * send button and its stop button (the released labels, as stack-browser-fixture matches them).
 * Hidden or inert composers of other Session views never count.
 */
const COMPOSER = (action: 'focus' | 'state' | 'submit') => `(() => {
  const live = (node) => node.closest('[inert]') === null && node.getClientRects().length > 0;
  const control = [...document.querySelectorAll('[data-dsh-team-kb-scope]')].find(live);
  let card = control === undefined ? null : control.parentElement;
  while (card !== null && card.querySelector('[contenteditable="true"]') === null)
    card = card.parentElement;
  if (card === null) return null;
  const editor = card.querySelector('[contenteditable="true"]');
  const labelled = (labels) =>
    [...card.querySelectorAll('button')].find((button) => labels.includes(button.getAttribute('aria-label')));
  const send = labelled(['Send message', '发送消息']);
  const stop = labelled(['Stop generating', '停止生成']);
  const action = ${JSON.stringify(action)};
  if (action === 'focus') editor.focus();
  if (action === 'submit' && send !== undefined && !send.disabled) send.click();
  return {
    draft: (editor.textContent || '').trim(),
    focused: document.activeElement === editor || editor.contains(document.activeElement),
    send: send === undefined ? 'none' : send.disabled ? 'disabled' : 'enabled',
    stop: stop !== undefined,
  };
})()`;

/** The scope composer card's state; null when no visible scope control sits in a composer. */
export interface ComposerState {
  readonly draft: string;
  readonly focused: boolean;
  readonly send: 'none' | 'disabled' | 'enabled';
  readonly stop: boolean;
}

/** The in-page composer state, checked field by field. */
export function composerCard(value: unknown): ComposerState | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.draft !== 'string' ||
    typeof value.focused !== 'boolean' ||
    typeof value.stop !== 'boolean' ||
    !oneOf(['none', 'disabled', 'enabled'] as const, value.send)
  )
    throw new Error('Knowledge scope composer state malformed');
  return { draft: value.draft, focused: value.focused, send: value.send, stop: value.stop };
}
/**
 * Whether the composer holds `shown` with its send button enabled. A composer missing for a
 * moment (it re-renders after taking a line) is simply not ready yet; waits keep polling.
 */
export function draftReady(state: ComposerState | null, shown: string): boolean {
  return state !== null && state.draft.includes(shown) && state.send === 'enabled';
}

/**
 * The live main chat column of one Session (dsh-client-ui-chat lib/client.js, ChatView's
 * `data-chat-flow` column), never a step group's nested `data-chat-flow` content.
 */
const TRANSCRIPT = (id: string) => `(() => {
  const live = (node) => node.closest('[inert]') === null && node.getClientRects().length > 0;
  const views = document.querySelectorAll('[data-conversation-session="' + ${JSON.stringify(id)} + '"]');
  for (const view of views)
    for (const flow of view.querySelectorAll('[data-chat-flow]:not([data-step-process-content])'))
      if (live(flow)) return flow.innerText;
  return null;
})()`;

/** The owned provider's hold, as the stack test reads it inside the platform container. */
interface HoldControl {
  held(): Promise<number>;
  release(): Promise<void>;
}

/** The scope actions on one observed workbench page; the search lane reuses them. */
function scopeDriver(page: Page, rpc: SessionRpc, timeout: number) {
  const snapshot = async () => scopeSnapshot(await page.evaluate<unknown>(SNAPSHOT));
  // The Session the current step is about; failure messages compare the page against it.
  const focus: { id?: string } = {};
  const wait = async (
    check: (latest: ScopeSnapshot) => Promise<boolean> | boolean,
    label: string,
  ) => {
    const seen: { latest?: ScopeSnapshot } = {};
    try {
      await until(
        async () => {
          const latest = await snapshot();
          seen.latest = latest;
          if (latest.error) throw new Error('Knowledge scope write failed');
          return check(latest);
        },
        timeout,
        label,
      );
    } catch (error) {
      const { latest } = seen;
      const { id } = focus;
      if (latest === undefined || id === undefined) throw error;
      const host = await readScope(rpc, id).catch(() => 'unavailable' as const);
      const reason = error instanceof Error ? error.message : 'unknown failure';
      throw new Error(`${reason} (${scopeStall(latest, id, host)})`, { cause: error });
    }
    if (seen.latest === undefined) throw new Error('Knowledge scope never read');
    return seen.latest;
  };
  const ready = async (latest: ScopeSnapshot, id: string) =>
    latest.current === id && latest.label !== null && (await composerState(page)) === 'ready';
  const card = async (action: 'focus' | 'state' | 'submit') => {
    const state = composerCard(await page.evaluate<unknown>(COMPOSER(action)));
    if (state === null) throw new Error('Knowledge scope composer missing');
    return state;
  };
  /** Types `text` into Session `id`'s scope composer and submits it once `shown` is drafted. */
  const submit = async (id: string, text: string, shown: string) => {
    focus.id = id;
    await wait((latest) => ready(latest, id), 'scope composer');
    if (!(await card('focus')).focused) throw new Error('Knowledge scope composer not focused');
    await page.keyboard.insertText(text);
    await wait(
      async () => draftReady(composerCard(await page.evaluate<unknown>(COMPOSER('state'))), shown),
      'scope draft',
    );
    await card('submit');
  };
  const driver = {
    snapshot,
    /** The control shows `selection` for the current Session `id`, as does the host. */
    async expectScope(id: string, selection: ScopeSelection) {
      focus.id = id;
      const shown = await wait(
        async (latest) => (await ready(latest, id)) && latest.label === scopeLabel(selection),
        'scope label',
      );
      const value = await readScope(rpc, id);
      expect(value.child).toBe(false);
      expect(value.selection).toEqual(selection);
      return { shown, value };
    },
    /**
     * 「新会话」 at the top of the sidebar. The new current Session is not one of `known` and has no
     * turn yet: a reused blank keeps its ID, and the row selected before the click is rejected.
     */
    async newSession(known: ReadonlySet<string>): Promise<string> {
      const [created] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/session/create',
          { timeout },
        ),
        newSessionButton(page).first().click(),
      ]);
      const id = createdSessionId(await created.json());
      if (known.has(id)) throw new Error('New Session reused a known Session');
      focus.id = id;
      await wait(
        async (current) => (await ready(current, id)) && (await readScope(rpc, id)).turn === null,
        'new Session',
      );
      return id;
    },
    async select(id: string) {
      focus.id = id;
      await page.locator(`[data-row-key="session:${id}"]`).first().click();
      await wait((latest) => ready(latest, id), 'Session switch');
    },
    /** Opens the popover and waits for its library list. */
    async open() {
      if ((await snapshot()).list === null)
        await Promise.all([
          page.waitForResponse(routeAnswer('datasets'), { timeout }),
          page.locator(TOGGLE).filter({ visible: true }).first().click(),
        ]);
      const latest = await wait(
        (current) => current.list !== null && current.list.state !== 'loading',
        'scope list',
      );
      expect(latest.list?.state).toBe('list');
      return latest;
    },
    async close() {
      if ((await snapshot()).list !== null)
        await page.locator(TOGGLE).filter({ visible: true }).first().click();
      await wait((latest) => latest.list === null, 'scope popover closed');
    },
    /**
     * One popover action, `all`, `none` or a dataset ID to toggle; settled once the host and the
     * control both show `expected`.
     */
    async write(id: string, action: string, expected: ScopeSelection) {
      focus.id = id;
      const popover = page.locator(POPOVER).filter({ visible: true }).first();
      if (action === 'all' || action === 'none')
        await popover
          .getByRole('button', { name: action === 'all' ? '全选' : '取消全选', exact: true })
          .click();
      else await popover.locator(`input[data-dsh-team-kb-scope-dataset="${action}"]`).click();
      const shown = await wait(async (latest) => {
        if (latest.current !== id || latest.list === null || latest.list.pending) return false;
        if (latest.label !== scopeLabel(expected)) return false;
        return sameSelection((await readScope(rpc, id)).selection, expected);
      }, 'scope saved');
      const listed = shown.list?.ids ?? [];
      const checked = expected === null ? listed : listed.filter((item) => expected.includes(item));
      expect(shown.list?.checked).toEqual(checked);
    },
    /**
     * Types `text` into the composer that holds the scope control of Session `id` and submits it;
     * resolves with the new turn number once the host has started that turn. No transient UI
     * state (a stop button that a fast turn shows only briefly) is waited for.
     */
    async send(id: string, text: string, started: () => Promise<void> = () => Promise.resolve()) {
      const before = (await readScope(rpc, id)).turn?.turn;
      await submit(id, text, text);
      await started();
      const seen: { turn: number | undefined } = { turn: undefined };
      await wait(async () => {
        seen.turn = (await readScope(rpc, id)).turn?.turn;
        return seen.turn !== undefined && seen.turn !== before;
      }, 'scope turn start');
      return Number(seen.turn);
    },
    /**
     * Types the `/<name> <arguments>` line into Session `id`'s composer and submits it on the
     * command path, which starts no turn; the composer may render the leading token as its own
     * element, so only the arguments are awaited in the draft. Settled once the host projection
     * holds `selection`; the caller checks `command/done` and the turn count.
     */
    async command(id: string, line: string, selection: ScopeSelection) {
      await submit(id, line, line.slice(line.indexOf(' ') + 1));
      await wait(
        async () => sameSelection((await readScope(rpc, id)).selection, selection),
        'command taken',
      );
    },
    /** The host's native turn end, then a composer without a stop button. */
    async turnEnd(id: string, turn: number) {
      focus.id = id;
      await wait(async () => turnEnded(await sessionEvents(rpc, id), turn), 'scope turn end');
      await wait(async () => {
        const state = composerCard(await page.evaluate<unknown>(COMPOSER('state')));
        return state !== null && !state.stop;
      }, 'scope composer idle');
    },
    /** Session `id`'s live transcript shows `prompt` and no command text of the control. */
    async expectQuietTranscript(id: string, prompt: string) {
      focus.id = id;
      const seen: { verdict?: ReturnType<typeof transcriptCheck> } = {};
      // A reopened Session loads its history first; only a rendered prompt settles the read.
      await wait(async () => {
        const text = await page.evaluate<unknown>(TRANSCRIPT(id));
        seen.verdict = transcriptCheck(typeof text === 'string' ? text : null, prompt);
        return seen.verdict === 'quiet' || seen.verdict === 'leak';
      }, 'scope transcript');
      expect(seen.verdict).toBe('quiet');
    },
    /** The composer of the current Session still shows its stop button: a turn is running. */
    async expectRunning() {
      const state = composerCard(await page.evaluate<unknown>(COMPOSER('state')));
      expect(state?.stop).toBe(true);
    },
  };
  return driver;
}
export type ScopeDriver = ReturnType<typeof scopeDriver>;

/** Everything the scope lane needs from the stack test; values stay in memory. */
export interface ScopeScenario {
  readonly session: StackSession;
  readonly rpc: SessionRpc;
  /** Two seed dataset IDs: the first selected, then the second. */
  readonly seeds: { readonly first: string; readonly second: string; readonly firstName: string };
  readonly hold: { readonly nonce: string } & HoldControl;
  readonly needles: () => Promise<PanelNeedles>;
  /** The administrator restart of this employee's instance, awaited until it runs again. */
  readonly restart: () => Promise<void>;
}

export interface ScopeEvidence {
  readonly sessions: readonly StackBrowserEvidence[];
  readonly steps: readonly ScopeStep[];
}

interface ScopeSessions {
  readonly first: string;
  readonly second: string;
}

/**
 * One observed workbench session running `script` on the scope driver; its page resources are
 * scanned for the needles as in the panel sessions (the popover's list is the route answer).
 */
export async function scopeSession(
  scenario: Pick<ScopeScenario, 'session' | 'rpc' | 'needles'>,
  label: string,
  script: (scope: ScopeDriver, page: Page, tools: SessionTools) => Promise<void>,
): Promise<StackBrowserEvidence> {
  const resources = resourceScan(scenario.session.base, await scenario.needles());
  return workbenchSession(
    scenario.session,
    { label: `knowledge scope ${label}`, failure: `scope-${label}-failure` },
    async (page, shoot, reload) => {
      const scope = scopeDriver(page, scenario.rpc, scenario.session.timeout);
      await script(scope, page, { shoot, reload });
      expectNoPanelSecrets(await resources.settle());
    },
    undefined,
    resources.onResponse,
  );
}

interface SessionTools {
  readonly shoot: (name: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

// The ordinary prompts: Session 1's turn after the held one, and Session 2's only turn.
const NEXT_PROMPT = '请再回复一次';
const SECOND_PROMPT = '第二个会话';

/** Steps 1 and 2: the default scope, then a change during a held turn. */
async function snapshotSteps(
  scenario: ScopeScenario,
  scope: ScopeDriver,
  tools: SessionTools,
  steps: ScopeStep[],
): Promise<string> {
  const { first, second } = scenario.seeds;
  const id = await scope.newSession(new Set());
  const initial = await scope.expectScope(id, null);
  expect(initial.value.turn).toBeNull();
  expect(initial.shown.state).toBe('all');
  await tools.shoot('scope-default');
  steps.push(scopeStep('default', initial.shown, initial.value, 'scope-default'));
  await scope.open();
  await scope.write(id, 'none', []);
  await scope.write(id, first, [first]);
  await scope.close();
  const heldTurn = await scope.send(id, `${scenario.hold.nonce} 请回复`, () =>
    until(async () => (await scenario.hold.held()) >= 1, scenario.session.timeout, 'held request'),
  );
  await scope.expectRunning();
  await scope.open();
  await scope.write(id, 'none', []);
  await scope.write(id, second, [second]);
  await tools.shoot('scope-running');
  await scope.close();
  await scope.expectRunning();
  await scenario.hold.release();
  await scope.turnEnd(id, heldTurn);
  const running = await scope.expectScope(id, [second]);
  expect(running.value.turn).toEqual({ turn: heldTurn, scope: [first] });
  const history = await sessionEvents(scenario.rpc, id);
  expect(commandSide(history, heldTurn, [first])).toBe('before');
  expect(commandSide(history, heldTurn, [second])).toBe('during');
  steps.push(scopeStep('running', running.shown, running.value, 'scope-running'));
  const nextTurn = await scope.send(id, NEXT_PROMPT);
  await scope.turnEnd(id, nextTurn);
  const next = await scope.expectScope(id, [second]);
  expect(next.value.turn).toEqual({ turn: nextTurn, scope: [second] });
  steps.push(scopeStep('next-turn', next.shown, next.value));
  await scope.expectQuietTranscript(id, NEXT_PROMPT);
  return id;
}

/** Step 3: a second Session keeps its own scope; a third starts on the whole scope again. */
async function independentSteps(
  scenario: ScopeScenario,
  scope: ScopeDriver,
  first: string,
  steps: ScopeStep[],
): Promise<string> {
  const { second } = scenario.seeds;
  const id = await scope.newSession(new Set([first]));
  await scope.expectScope(id, null);
  // A turn makes it an ordinary Session that stays in the tree.
  await scope.turnEnd(id, await scope.send(id, SECOND_PROMPT));
  await scope.open();
  await scope.write(id, 'none', []);
  await scope.close();
  const none = await scope.expectScope(id, []);
  await scope.expectQuietTranscript(id, SECOND_PROMPT);
  expect(none.shown.state).toBe('none');
  steps.push(scopeStep('second-session', none.shown, none.value));
  await scope.select(first);
  const back = await scope.expectScope(first, [second]);
  steps.push(scopeStep('first-session', back.shown, back.value));
  const third = await scope.newSession(new Set([first, id]));
  const fresh = await scope.expectScope(third, null);
  steps.push(scopeStep('third-session', fresh.shown, fresh.value));
  return id;
}

/** Browsing an unselected library's files in the panel leaves the scope as it was. */
async function browseStep(
  scenario: ScopeScenario,
  scope: ScopeDriver,
  page: Page,
  tools: SessionTools,
  sessions: ScopeSessions,
  steps: ScopeStep[],
) {
  await scope.select(sessions.first);
  const panel = panelDriver(page, tools.shoot, scenario.session.timeout).driver;
  await panel.open();
  const expanded = await panel.answered('documents', panel.button(scenario.seeds.firstName));
  expect(expanded.files).toHaveLength(1);
  const filtered = await panel.answered('documents', panel.filter('expense'));
  expect(filtered.files[0]?.state).toBe('list');
  await scope.select(sessions.first);
  const after = await scope.expectScope(sessions.first, [scenario.seeds.second]);
  steps.push(scopeStep('browse', after.shown, after.value));
}

/** Both Sessions show their own scope; the popover lists the libraries with them checked. */
async function restoredSteps(
  scenario: ScopeScenario,
  scope: ScopeDriver,
  sessions: ScopeSessions,
  step: string,
  steps: ScopeStep[],
  shoot?: (name: string) => Promise<void>,
) {
  await scope.select(sessions.first);
  const first = await scope.expectScope(sessions.first, [scenario.seeds.second]);
  const listed = await scope.open();
  expect(listed.list?.checked).toEqual([scenario.seeds.second]);
  await scope.close();
  await scope.expectQuietTranscript(sessions.first, NEXT_PROMPT);
  if (shoot !== undefined) await shoot('scope-restored');
  steps.push(scopeStep(`${step}-first`, first.shown, first.value, shoot && 'scope-restored'));
  await scope.select(sessions.second);
  const second = await scope.expectScope(sessions.second, []);
  await scope.expectQuietTranscript(sessions.second, SECOND_PROMPT);
  steps.push(scopeStep(`${step}-second`, second.shown, second.value));
}

/**
 * The composer scope lane (#420): new Sessions default to every library, a held turn keeps the
 * scope it started with, Sessions stay independent, browsing changes nothing, and the scope
 * survives a reload, a new browser login and an instance restart.
 */
export async function scopeScenario(scenario: ScopeScenario): Promise<ScopeEvidence> {
  const steps: ScopeStep[] = [];
  const evidence: StackBrowserEvidence[] = [];
  let sessions: ScopeSessions | undefined;
  evidence.push(
    await scopeSession(scenario, 'changes', async (scope, page, tools) => {
      const first = await snapshotSteps(scenario, scope, tools, steps);
      const second = await independentSteps(scenario, scope, first, steps);
      sessions = { first, second };
      await browseStep(scenario, scope, page, tools, sessions, steps);
      await tools.reload();
      await restoredSteps(scenario, scope, sessions, 'reload', steps);
    }),
  );
  if (sessions === undefined) throw new Error('Knowledge scope Sessions missing');
  const known = sessions;
  evidence.push(
    await scopeSession(scenario, 'relogin', (scope) =>
      restoredSteps(scenario, scope, known, 'relogin', steps),
    ),
  );
  await scenario.restart();
  evidence.push(
    await scopeSession(scenario, 'restart', (scope, _page, tools) =>
      restoredSteps(scenario, scope, known, 'restart', steps, tools.shoot),
    ),
  );
  return { sessions: evidence, steps };
}

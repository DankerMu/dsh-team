import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { SEED_DATASETS } from '../../scripts/seed-stack.mjs';
import { scopeSession } from './knowledge-scope-stack-fixture.ts';
import type { ScopeDriver } from './knowledge-scope-stack-fixture.ts';
import { callsNamed, resultOf, searchScenario } from './knowledge-search-stack-fixture.ts';
import type {
  SearchEvidence,
  SearchResult,
  SearchScenario,
} from './knowledge-search-stack-fixture.ts';
import { sessionEvents } from './owned-completion-fixture.ts';
import { POLICIES } from './ragflow-stack-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const TOOL = 'knowledge_base_list';
const PROMPT = '知识库里有哪些文件';
const SCREENSHOT = 'list-files';

/** The owned provider's list script (#763): its own marker, and the library the second call names. */
export const ownedList = () => ({ marker: `stack-list-${randomUUID()}`, library: POLICIES });
type OwnedList = ReturnType<typeof ownedList>;

type HistoryEvent = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every `knowledge_base_list` call of a history in order, each with its result once it arrived. */
export function listResultsOf(events: readonly HistoryEvent[]): (SearchResult | undefined)[] {
  return callsNamed(events, TOOL).map((call) =>
    resultOf(events, isRecord(call.data) ? call.data.callId : undefined),
  );
}

/** What one Session's two list calls showed: names and counts only, never an ID. */
export interface ListStep {
  readonly scope: 'policies' | 'whole';
  readonly libraries: readonly string[];
  readonly files: readonly string[];
  readonly total: number;
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
    ? value
    : undefined;
const sorted = (names: readonly string[]) => [...names].sort().join('\n');
const POLICY_FILES = SEED_DATASETS.find(({ name }) => name === POLICIES)?.files ?? [];

/** The libraries answer: exactly the policies library, or every seed library among the listed. */
function librariesOf(meta: Record<string, unknown>, scope: ListStep['scope']) {
  const names = strings(meta.libraries);
  if (names === undefined) return undefined;
  if (scope === 'policies') return names.join('\n') === POLICIES ? names : undefined;
  return SEED_DATASETS.every(({ name }) => names.includes(name)) ? names : undefined;
}

/** The files answer: the policies library's two seed files on its only page. */
function filesOf(meta: Record<string, unknown>) {
  const files = strings(meta.files);
  if (meta.library !== POLICIES || meta.total !== 2 || meta.page !== 1 || meta.pages !== 1)
    return undefined;
  return files !== undefined && sorted(files) === sorted(POLICY_FILES) ? files : undefined;
}

/** The meta of an `ok` result whose text opens with its meta title, when neither carries `ids`. */
function shownOk(result: SearchResult, ids: readonly string[]) {
  const { meta, text } = result;
  if (result.isError || !isRecord(meta) || meta.result !== 'ok') return undefined;
  if (typeof meta.title !== 'string' || !text.startsWith(meta.title)) return undefined;
  const shown = `${text}${JSON.stringify(meta)}`;
  return ids.some((id) => shown.includes(id)) ? undefined : meta;
}

const outcomeOf = (result: SearchResult | undefined) => {
  if (result === undefined) return 'pending';
  const named = isRecord(result.meta) ? result.meta.result : undefined;
  return `${typeof named === 'string' ? named : 'unknown'}${result.isError ? ' error' : ''}`;
};

/**
 * The two list results of one Session: the in-scope library names, then the policies library's
 * files, each `ok`, named line by line in its text, and carrying none of `ids` in text or meta.
 * Failures name the scope, the call count and each call's outcome only.
 */
export function listEvidence(
  results: readonly (SearchResult | undefined)[],
  scope: ListStep['scope'],
  ids: readonly string[],
): ListStep {
  const fail = (what: string) =>
    new Error(
      `List ${scope} ${what} (calls=${String(results.length)} ${results.map(outcomeOf).join(',')})`,
    );
  const [first, second] = results;
  if (results.length !== 2 || first === undefined || second === undefined)
    throw fail('calls unexpected');
  const [listed, paged] = [shownOk(first, ids), shownOk(second, ids)];
  if (listed === undefined || paged === undefined) throw fail('result not a clean ok');
  const libraries = librariesOf(listed, scope);
  if (libraries === undefined) throw fail('libraries unexpected');
  const files = filesOf(paged);
  if (files === undefined) throw fail('files unexpected');
  const lines = (result: SearchResult, names: readonly string[]) =>
    names.every((name) => result.text.split('\n').includes(`- ${name}`));
  if (!lines(first, libraries) || !lines(second, files)) throw fail('text without its names');
  return { scope, libraries, files, total: Number(paged.total) };
}

type ListedSearchScenario = SearchScenario & { readonly list: OwnedList };

interface ListEvidence {
  readonly browser: StackBrowserEvidence;
  readonly steps: readonly ListStep[];
}

/** One marked turn in Session `id`: the provider lists, then lists the policies library's files. */
async function listedTurn(
  scope: ScopeDriver,
  scenario: ListedSearchScenario,
  id: string,
  kind: ListStep['scope'],
) {
  const turn = await scope.send(id, `${scenario.list.marker} ${PROMPT}`);
  await scope.turnEnd(id, turn);
  return listEvidence(listResultsOf(await sessionEvents(scenario.rpc, id)), kind, scenario.ids);
}

/**
 * The list step (#763) on two new root Sessions: one scoped to the policies library, one on the
 * whole scope. Each turn calls `knowledge_base_list` without a library, then for the policies
 * library; the page shows no error and contacts no external origin.
 */
async function listScenario(scenario: ListedSearchScenario): Promise<ListEvidence> {
  const steps: ListStep[] = [];
  const selection = [scenario.policies.id];
  const browser = await scopeSession(scenario, 'list', async (scope, _page, tools) => {
    const scoped = await scope.newSession(new Set());
    await scope.command(
      scoped,
      `/kb-scope ${JSON.stringify({ datasetIds: selection })}`,
      selection,
    );
    await scope.expectScope(scoped, selection);
    steps.push(await listedTurn(scope, scenario, scoped, 'policies'));
    const whole = await scope.newSession(new Set([scoped]));
    await scope.expectScope(whole, null);
    steps.push(await listedTurn(scope, scenario, whole, 'whole'));
    await tools.shoot(SCREENSHOT);
  });
  expect({
    screenshots: browser.screenshots,
    consoleErrors: browser.consoleErrors,
    pageErrors: browser.pageErrors,
    failedRequests: browser.failedRequests,
    externalRequests: browser.externalRequests,
  }).toEqual({
    screenshots: [`${SCREENSHOT}.png`],
    ...{ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] },
  });
  return { browser, steps };
}

/**
 * The retrieval step (#421), then the list step (#763) for the same employee; the stack test's
 * provider check after it covers both lanes' model requests.
 */
export async function searchAndList(
  scenario: ListedSearchScenario,
): Promise<SearchEvidence & { readonly list: ListEvidence }> {
  const search = await searchScenario(scenario);
  return { ...search, list: await listScenario(scenario) };
}

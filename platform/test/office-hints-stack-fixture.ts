import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ConsoleMessage, Page } from '@playwright/test';
import { expect } from 'vitest';
import { previewIds, rowQuery, visible } from './better-sidebar-browser-fixture.mjs';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { record } from './docker-cleanup.ts';
import { createDockerCommands, isAbsentResource } from './docker-command.ts';
import { providerCounts, withWorkFiles, WORK } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { element, showSidebarRows, until, workbenchSession } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence, StackSession } from './stack-browser-fixture.ts';

/** The delivered Document Server container (deploy/compose.yml). */
export const DOCUMENT_SERVER = 'dsh-team-documentserver';
const NAME = '同写提示.docx';
const PARAGRAPH = '同写提示探针：只打开，不编辑。';
/** Baseline F40, verbatim: plugins/office-hints/client.js `COLLAB`. */
export const COLLAB = '请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。';
/** The Document Server startup-window note, verbatim: plugins/office-hints/client.js `RESTART`. */
export const RESTART =
  'Office 服务刚启动或重启后约 2 分钟内，编辑器可能断开；如果断开，请稍后重新打开此文件，未保存的修改可能丢失。';
const MOUNT = '/sidebar/onlyoffice/ds/';
// dsh-sidebar-onlyoffice@0.2.0 src/client/locales.ts, zh then en: `loading`; then `loadFailed`,
// `errFetch`, `errApi`, `errEditor`, `errEditorEvent`; last office-hints' own `UNAVAILABLE`.
const LOADING = ['正在打开 ONLYOFFICE …', 'Opening in ONLYOFFICE …'];
const FAILURES = [
  ...['打开失败', '无法获取编辑器配置', '无法加载 ONLYOFFICE 编辑器脚本'],
  ...['ONLYOFFICE 编辑器初始化失败', 'ONLYOFFICE 编辑器发生错误', 'Failed to open'],
  ...['Could not fetch the editor config', 'Could not load the ONLYOFFICE editor script'],
  ...['The ONLYOFFICE editor failed to initialize', 'The ONLYOFFICE editor reported an error'],
  'Office 编辑器未加载',
];

// Python in the instance as uid 1001 with python-docx from the image; every value arrives as argv.
// With a paragraph it writes the one-paragraph document first; it always reads the file back.
// With `--base64 <data>` it writes those bytes instead.
const DOCX = `import base64, hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if sys.argv[2:3] == ["--base64"]:
    path.write_bytes(base64.b64decode(sys.argv[3]))
elif len(sys.argv) > 2:
    from docx import Document
    document = Document()
    document.add_paragraph(sys.argv[2])
    document.save(path)
data = path.read_bytes()
print(json.dumps({"name": path.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))`;
export const docxCommand = (name: string, ...content: string[]) => [
  ...['python3', '-c', DOCX, `${WORK}/${name}`],
  ...content,
];

// DSH Web answers only at the instance's own bridge address, never at its loopback
// (platform/src/managed-config/README.md); the Host is the loopback the plugin's trust fence admits.
const HEALTH = `import http.client, json, socket
try:
    c = http.client.HTTPConnection(socket.gethostbyname(socket.gethostname()), 3080, timeout=5)
    c.request("GET", "/sidebar/onlyoffice/ds/healthcheck", headers={"Host": "127.0.0.1:3080"})
    r = c.getresponse()
    print(json.dumps({"status": r.status, "body": r.read(200).decode("utf-8", "replace").strip()}))
except Exception as e:
    print(json.dumps({"status": 0, "body": type(e).__name__}))`;
export const HEALTH_COMMAND = ['python3', '-c', HEALTH];

type Hint = Record<'kind' | 'text', string | null> & Record<'visible' | 'nativeHost', boolean>;
/** What the page shows of the hints and the wrapped editor; iframe paths carry no query. */
interface OfficeFacts {
  readonly hints: readonly Hint[];
  readonly frames: number;
  readonly iframes: readonly { visible: boolean; sameOrigin: boolean; path: string }[];
  readonly texts: readonly string[];
}

/** The office-hints wrapper around the editor of `name`, by its extension. */
export const hintsFrame = (name: string) =>
  `[data-dsh-team-office-hints="${extname(name).slice(1)}"]`;
export const officeFacts = (name: string) => `(() => {
  const visible = ${visible};
  const frames = [...document.querySelectorAll('${hintsFrame(name)}')];
  const text = document.body.innerText;
  return {
    hints: [...document.querySelectorAll('[data-dsh-team-office-hint]')].map((el) => ({ kind: el.getAttribute('data-dsh-team-office-hint'), text: el.textContent, visible: visible(el), nativeHost: el.closest('[data-dsh-native-tab-host]') !== null })),
    frames: frames.length,
    iframes: frames.flatMap((frame) => [...frame.querySelectorAll('iframe')]).map((el) => { const url = new URL(el.getAttribute('src') ?? '', location.href); return { visible: visible(el), sameOrigin: url.origin === location.origin, path: url.pathname }; }),
    texts: ${JSON.stringify([...LOADING, ...FAILURES])}.filter((needle) => text.includes(needle)),
  };
})()`;

/**
 * Settled once the visible collaboration hint sits over a visible Document Server proxy iframe
 * with no loading text, or as soon as a failure text or the no-Session hint shows.
 */
export const editorSettled = ({ hints, iframes, texts }: OfficeFacts) =>
  hints.some(({ kind }) => kind === 'no-session') ||
  texts.some((text) => !LOADING.includes(text)) ||
  (texts.length === 0 &&
    hints.some((hint) => hint.kind === 'collab' && hint.visible) &&
    iframes.some((frame) => frame.visible && frame.path.startsWith(MOUNT)));

// Document Server 9.4 registers a caching ServiceWorker; the gateway refuses every request with a
// `Service-Worker` header (platform/src/gateway/README.md:9). User decision 2026-11-14 (§48.1).
const SW_FETCH = 'A bad HTTP response code (403) was received when fetching the script.';

/**
 * Exactly Chromium's two console errors for that refusal, in order, on `base`'s origin: scope and
 * script share one non-empty Document Server version segment without `/`.
 */
export function serviceWorkerRefused(errors: readonly string[], base: string): boolean {
  const mount = `${new URL(base).origin}${MOUNT}`;
  const lead = `Registration failed with TypeError: Failed to register a ServiceWorker for scope ('${mount}`;
  const [first, registration = '', ...rest] = errors;
  const tail = registration.startsWith(lead) ? registration.slice(lead.length) : '';
  const segment = tail.split('/')[0] ?? '';
  const scope = `${mount}${segment}/`;
  const expected = `${lead}${segment}/') with script ('${scope}document_editor_service_worker.js'): ${SW_FETCH}`;
  return rest.length === 0 && first === SW_FETCH && segment !== '' && registration === expected;
}

export interface OfficeHintsEvidence {
  readonly browser: StackBrowserEvidence;
  readonly file: ArchiveEntry;
  readonly hint: string;
  readonly restart: string;
}

/** The stack evidence line: the file, the hint and note texts and the screenshot names. */
export function officeHintsLine(evidence: OfficeHintsEvidence | undefined) {
  if (evidence === undefined) throw new Error('Office hints evidence missing');
  const { browser, file, hint, restart } = evidence;
  return { ...file, hint, restart, screenshots: browser.screenshots };
}

/** `until`, failing with `message` and the last observation `seen()`, the wait's error as cause. */
export const untilSeen = (
  seen: () => unknown,
  ...[check, timeout, message]: Parameters<typeof until>
) =>
  until(check, timeout, message).catch((cause: unknown) => {
    throw new Error(`${message} ${JSON.stringify(seen())}`, { cause });
  });

type Shoot = (name: string) => Promise<void>;

/**
 * Opens the file from the landing session's file area, waits for the hinted editor and then for
 * the ServiceWorker refusal, which ONLYOFFICE logs after its `ready` phase, and checks the page.
 */
export async function openHinted(
  page: Page,
  shoot: Shoot,
  { base, timeout }: StackSession,
  name: string,
  screenshot: string,
  refusal = serviceWorkerRefused,
) {
  await until(() => showSidebarRows(page, [name]), timeout, `office hints ${name} row`);
  const row = await element(page, rowQuery(name));
  if (row === null) throw new Error(`Office hints ${name} row missing`);
  // The text workbenchSession records for an error-type console message.
  const errors: string[] = [];
  const record = (message: ConsoleMessage) =>
    message.type() === 'error' && errors.push(message.text());
  page.on('console', record);
  let facts: OfficeFacts | undefined;
  const settled = async () => {
    facts = await page.evaluate<OfficeFacts>(officeFacts(name));
    return editorSettled(facts);
  };
  const refused = () => Promise.resolve(refusal(errors, base));
  try {
    await row.click();
    await untilSeen(() => facts, settled, timeout, 'Office hints editor never settled, last seen');
    await untilSeen(() => errors, refused, timeout, 'ServiceWorker refusal not logged, collected');
  } finally {
    page.off('console', record);
  }
  const final = await page.evaluate<OfficeFacts>(officeFacts(name));
  await shoot(screenshot);
  const seen = JSON.stringify(final);
  const shownHint = { visible: true, nativeHost: true };
  const hints = [
    { kind: 'collab', text: COLLAB, ...shownHint },
    { kind: 'restart', text: RESTART, ...shownHint },
  ];
  expect(final.hints, `Office hints, seen ${seen}`).toEqual(hints);
  expect(final.texts, 'ONLYOFFICE loading or failure text').toEqual([]);
  // [sameOrigin, on the proxy path] of every visible iframe in the wrapper.
  const shown = final.iframes.filter((frame) => frame.visible);
  const mounted = shown.map(({ sameOrigin, path }) => [sameOrigin, path.startsWith(MOUNT)]);
  expect(mounted, `Editor iframes, seen ${seen}`).toEqual([[true, true]]);
  expect(await page.evaluate<string[]>(previewIds(name)), "DSH's preview, any id").toEqual([]);
}

/** Waits for the Document Server through the instance's proxy, so a cold 502 never reaches the browser. */
export async function documentServerReady({ exec, session }: ArchiveLane) {
  let seen = { status: 0, body: 'never polled' };
  const healthy = async () => {
    seen = JSON.parse(await exec(HEALTH_COMMAND)) as typeof seen;
    if (seen.status === 403) throw new Error('Refused by the ONLYOFFICE trust fence');
    return seen.status === 200 && seen.body === 'true';
  };
  const message = 'Document Server healthcheck not true, last';
  await untilSeen(() => seen, healthy, session.timeout, message);
}

/**
 * The delivered Document Server's anonymous volumes: after the lifecycle's own exact retirement,
 * `--volumes` must have taken each one with it.
 */
export async function expectVolumesRetired(volumes: readonly string[]): Promise<void> {
  const config = await mkdtemp(join(tmpdir(), 'dsh-team-test-docker-'));
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const { command } = createDockerCommands(root, config, true);
    for (const volume of volumes)
      expect(
        isAbsentResource(command(['volume', 'inspect', volume], 30_000), 'volume', volume),
        'Document Server anonymous volume retired',
      ).toBe(true);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}

/** How many times supervisord has spawned docservice since the Document Server started. */
export async function docserviceSpawns(run: DockerOutput): Promise<number> {
  const grep = ['grep', '-c', "spawned: 'docservice'", '/var/log/supervisor/supervisord.log'];
  const count = (await run(['exec', DOCUMENT_SERVER, ...grep])).trim();
  if (!/^\d+$/.test(count)) throw new Error(`docservice spawn count unreadable: ${count}`);
  return Number(count);
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The test's own oracle for run-document-server.sh's last step, `xargs tail -F`: `true` once it
 * runs, else why not. pgrep without a match exits 1, which `run` throws as not yet.
 */
async function finalStepRunning(run: DockerOutput): Promise<true | string> {
  try {
    await run(['exec', DOCUMENT_SERVER, 'pgrep', '-f', 'xargs tail -F']);
    return true;
  } catch (error) {
    return failure(error);
  }
}

/**
 * Waits for run-document-server.sh's last step, `xargs tail -F`, which starts only after
 * documentserver-generate-allfonts.sh has restarted docservice and converter (#622). Returns the
 * time since the container started and the docservice spawns so far.
 */
export async function documentServerStarted(run: DockerOutput, timeout: number) {
  let seen = 'never polled';
  // `until` does not catch.
  const started = async () => {
    const step = await finalStepRunning(run);
    if (step === true) return true;
    seen = step;
    return false;
  };
  const message = 'Document Server startup script not finished, last';
  await untilSeen(() => seen, started, timeout, message);
  // RFC 3339 with nine fractional digits; Date.parse keeps the milliseconds.
  const startedAt = (await run(['inspect', '-f', '{{.State.StartedAt}}', DOCUMENT_SERVER])).trim();
  const since = Date.parse(startedAt);
  if (Number.isNaN(since))
    throw new Error(`Document Server StartedAt unreadable: ${JSON.stringify(startedAt)}`);
  return { startupMs: Date.now() - since, spawns: await docserviceSpawns(run) };
}

/** One sample: Docker's health status, then the oracle, and the failed probes Docker still keeps. */
export interface HealthSample {
  readonly status: string;
  readonly finalStep: boolean;
  /** `Health.Log` entries (Docker keeps the last five) whose probe ran and exited nonzero. */
  readonly failedProbes: number;
  /** Since the container's StartedAt. */
  readonly ms: number;
  /** Why the oracle did not see the final step: a real absence or a failed exec. */
  readonly oracle?: string;
}

export interface HealthTimeline {
  readonly samples: readonly HealthSample[];
  /** docservice spawns read right after the first healthy sample. */
  readonly healthySpawns?: number;
  readonly error?: string;
}

/** One State read: the health status, the failed probes kept in its log and the time since start. */
async function healthState(run: DockerOutput) {
  const state = record(
    JSON.parse(await run(['inspect', '--format', '{{json .State}}', DOCUMENT_SERVER])),
  );
  const health: unknown = state.Health;
  const since = Date.parse(String(state.StartedAt));
  if (typeof health !== 'object' || health === null || Number.isNaN(since))
    throw new Error('Document Server health unreadable');
  const { Status: status, Log: log } = record(health);
  if (typeof status !== 'string' || !Array.isArray(log))
    throw new Error('Document Server health unreadable');
  const failedProbes = log.filter((entry) => Number(record(entry).ExitCode) > 0).length;
  return { status, failedProbes, ms: Date.now() - since };
}

/**
 * Samples the delivered Document Server from `compose up` on (#648): each sample reads Docker's
 * health first and runs the oracle second, so a healthy sample whose oracle fails is a real
 * violation, never the probe's lag. Sampling ends once settled after a healthy sample, at an
 * `unhealthy` report, when aborted, or `timeout` after it began; the result never rejects.
 * Docker probes every 5 s while starting (deploy/compose.yml); the 1 s default `interval` places
 * each status change within a second without crowding the daemon.
 */
export function sampleDocumentServerHealth(run: DockerOutput, timeout: number, interval = 1_000) {
  const deadline = performance.now() + timeout;
  const samples: HealthSample[] = [];
  let settling = false;
  let aborted = false;
  let healthySpawns: number | undefined;
  const sampling = async (): Promise<HealthTimeline> => {
    while (!aborted) {
      const { status, failedProbes, ms } = await healthState(run);
      const step = await finalStepRunning(run);
      const seen = step === true ? {} : { oracle: step };
      samples.push({ status, finalStep: step === true, failedProbes, ms, ...seen });
      if (status === 'healthy') healthySpawns ??= await docserviceSpawns(run);
      const settled = settling && healthySpawns !== undefined;
      if (settled || status === 'unhealthy' || performance.now() >= deadline) break;
      await delay(interval);
    }
    return { samples, ...(healthySpawns === undefined ? {} : { healthySpawns }) };
  };
  const timeline = sampling().catch((error: unknown): HealthTimeline => ({
    samples,
    error: failure(error),
  }));
  return {
    /** Joins the sampler once it has a healthy sample (or has ended). */
    settle: () => {
      settling = true;
      return timeline;
    },
    /** Ends it after the current sample, healthy or not: the failure path, before drainage. */
    abort: () => {
      aborted = true;
      return timeline;
    },
  };
}

/**
 * The health timeline's evidence line; throws on the first broken claim: never healthy before the
 * oracle saw the final step, a probe that ran and said no while it was missing, a healthy sample.
 */
export function healthTimelineLine({ samples, healthySpawns, error }: HealthTimeline) {
  const seen = (subset: readonly HealthSample[]) => JSON.stringify(subset.slice(-5));
  if (error !== undefined) throw new Error(`Document Server health sampling failed: ${error}`);
  const early = samples.filter(({ status, finalStep }) => status === 'healthy' && !finalStep);
  if (early.length > 0)
    throw new Error(`Document Server healthy before its final step: ${seen(early)}`);
  const before = samples.filter(({ finalStep }) => !finalStep);
  if (!before.some(({ status, failedProbes }) => status === 'starting' && failedProbes > 0))
    throw new Error(
      `No failed Document Server probe sampled before its final step: ${seen(before)}`,
    );
  const healthy = samples.filter(({ status }) => status === 'healthy');
  const [first] = healthy;
  if (first === undefined || healthySpawns === undefined)
    throw new Error(`Document Server never sampled healthy, last ${seen(samples)}`);
  // Every healthy sample saw the final step, so one exists; the first is never after `first`.
  const step = samples.find(({ finalStep }) => finalStep) ?? first;
  return {
    samples: samples.length,
    beforeFinalStep: before.length,
    healthy: healthy.length,
    finalStepMs: step.ms,
    healthyMs: first.ms,
    spawns: healthySpawns,
  };
}

/** The write, the browser session and every check of the lane; cleanup is the caller's. */
async function officeHints(lane: ArchiveLane): Promise<OfficeHintsEvidence> {
  const { exec, session } = lane;
  const before = await providerCounts(lane);
  // The instance's own size and digest of the file it has just written.
  const file = JSON.parse(await exec(docxCommand(NAME, PARAGRAPH))) as ArchiveEntry;
  expect(file.name).toBe(NAME);
  expect(file.size).toBeGreaterThan(0);
  await documentServerReady(lane);
  const names = { label: 'office hints', failure: 'office-hints-failure' };
  const browser = await workbenchSession(session, names, (page, shoot) =>
    openHinted(page, shoot, session, NAME, 'office-hints-collab'),
  );
  // Opened, never edited: the Document Server closes with status 4 and writes nothing back.
  const after: unknown = JSON.parse(await exec(docxCommand(NAME)));
  expect(after, 'Office hints file unchanged by opening it').toEqual(file);
  expect(await providerCounts(lane), 'No model request or retrieval').toEqual(before);
  // The editor iframe's own requests and console output count too.
  const { consoleErrors } = browser;
  const refusal = serviceWorkerRefused(consoleErrors, session.base);
  expect(refusal, `consoleErrors ${JSON.stringify(consoleErrors)}`).toBe(true);
  expect(browser).toMatchObject({
    screenshots: ['office-hints-collab.png'],
    pageErrors: [],
    failedRequests: [],
    externalRequests: [],
  });
  // openHinted asserted the shown hint and note verbatim.
  return { browser, file, hint: COLLAB, restart: RESTART };
}

/**
 * The collaboration hint over the ONLYOFFICE editor (#439, 18.4): 同写提示.docx opened from the
 * landing session's file area shows F40's hint inside better-sidebar's tab, above a mounted
 * Document Server proxy iframe, and leaves the instance's bytes unchanged; the file is then removed.
 */
export const officeHintsScenario = (lane: ArchiveLane): Promise<OfficeHintsEvidence> =>
  withWorkFiles(lane, [NAME], 'Office hints', () => officeHints(lane));

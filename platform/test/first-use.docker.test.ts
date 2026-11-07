import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { acceptObservation, mappedFlags, mappedRpc } from '../../scripts/probe-mapped-host.mjs';
import type { MappedHostAcceptResult } from '../../scripts/probe-mapped-host.mjs';
import { readSettings, writeSettings } from '../src/db/index.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { startBrowserPlatform, startEmployeeInstance } from './instance-browser-docker-fixture.ts';
import { MANAGED_BOOT_ROSTER } from './managed-boot-roster.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';

/** Read workspace semantics and exact fixture-owned bytes, never runtime log serialization. */
async function employeeState(lifecycle: UserImageLifecycle, id: string, writeSentinels = false) {
  const script = `import json, os, re
from pathlib import Path
home = Path('/data/home')
work = Path('/data/work')
registry = home / 'storages/workspace.json'
${
  writeSentinels
    ? `(home / 'first-use-sentinel').write_text('employee state 中文\\n', encoding='utf-8')
(work / 'first-use-sentinel').write_text('employee work 中文\\n', encoding='utf-8')`
    : ''
}
workspace = json.loads(registry.read_text(encoding='utf-8'))
def credentials(value):
  if isinstance(value, dict):
    return any(re.search(r'token|cookie|password|secret|credential|api.?key', k, re.I) or credentials(v) for k, v in value.items())
  if isinstance(value, list):
    return any(credentials(v) for v in value)
  return False
print(json.dumps({'uid': os.geteuid(), 'workspace': workspace,
  'writable': os.access(registry, os.W_OK), 'credentialFields': bool(credentials(workspace)),
  'homeSentinel': (home / 'first-use-sentinel').read_bytes().decode('utf-8') if (home / 'first-use-sentinel').exists() else None,
  'workSentinel': (work / 'first-use-sentinel').read_bytes().decode('utf-8') if (work / 'first-use-sentinel').exists() else None}, ensure_ascii=False))`;
  const result = await lifecycle.commandAsync(['exec', id, 'python3', '-c', script], 15_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Employee storage observation failed');
  return record(JSON.parse(result.stdout));
}

function requireFreshRegistry(state: Record<string, unknown>): string {
  expect(state.uid).toBe(1001);
  expect(state.writable).toBe(true);
  expect(state.credentialFields).toBe(false);
  expect(state.homeSentinel).toBeNull();
  expect(state.workSentinel).toBeNull();
  const workspace = record(state.workspace);
  expect(workspace.unit).toEqual({ name: 'workspace', version: 2 });
  const global = record(workspace.global);
  expect(global).toMatchObject({
    initialized: true,
    archivedSessionIds: [],
    pinnedSessionIds: [],
  });
  if (!Array.isArray(global.workspaceIds) || global.workspaceIds.length !== 1)
    throw new Error('Fresh image must register exactly one workspace');
  const id: unknown = global.workspaceIds[0];
  if (typeof id !== 'string') throw new Error('Missing image workspace identity');
  const workspaces = record(record(workspace.tables).workspaces);
  expect(Object.keys(workspaces)).toEqual([id]);
  expect(workspaces[id]).toMatchObject({ path: '/data/work', title: 'work', sessionIds: [] });
  return id;
}

function requireEmployeeStorage(
  state: Record<string, unknown>,
  expected: {
    workspaceId: string;
    sessionId: string;
    title: string;
    homeSentinel: string | null;
    workSentinel: string | null;
  },
): void {
  expect(state.uid).toBe(1001);
  expect(state.writable).toBe(true);
  expect(state.credentialFields).toBe(false);
  expect(state.homeSentinel).toBe(expected.homeSentinel);
  expect(state.workSentinel).toBe(expected.workSentinel);
  const workspace = record(state.workspace);
  expect(workspace.unit).toEqual({ name: 'workspace', version: 2 });
  expect(workspace.global).toMatchObject({
    initialized: true,
    workspaceIds: [expected.workspaceId],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  });
  const workspaces = record(record(workspace.tables).workspaces);
  expect(Object.keys(workspaces)).toEqual([expected.workspaceId]);
  expect(workspaces[expected.workspaceId]).toMatchObject({
    path: '/data/work',
    title: expected.title,
    sessionIds: [expected.sessionId],
  });
}

/** Employee sidebar: only 账号设置, wide and compact, and its click leaves DSH for the account page. */
function expectEmployeeNavigation(observation: MappedHostAcceptResult): void {
  const account = {
    href: '/_platform/account',
    target: null,
    visible: true,
    contained: true,
    labelFits: true,
  };
  expect(observation.platformNav?.wide).toEqual([{ ...account, text: '账号设置', label: null }]);
  expect(observation.platformNav?.rail).toEqual([{ ...account, text: '', label: '账号设置' }]);
  expect(observation.platformNav?.cordis).toBe('absent');
  expect(observation.platformNav?.destination).toEqual({
    path: '/_platform/account',
    search: '',
    heading: '修改密码',
  });
}

const OFFICE_AGENTS = '@dsh-team/office-agents';
const KNOWLEDGE_BASE = '@dsh-team/knowledge-base';
// Nonsecret test constants stored as the platform's RAGFlow settings; no instance may carry them.
const RAGFLOW_SENTINELS = {
  ragflowBaseUrl: 'http://ragflow-sentinel.invalid:9380',
  ragflowApiKey: 'ragflow-sentinel-not-a-key',
};
const KNOWLEDGE_BASE_FILES = ['client.js', 'cordis.patch.yml', 'index.js', 'package.json'];

/**
 * Every entry of the canonical knowledge-base copy and its profile registration, compared inside
 * the instance: name, kind, byte size, SHA-256 and whether each needle occurs in its bytes. The
 * output is a few hundred bytes whatever the file sizes, far below the bounded command cap.
 */
async function knowledgeBaseCopies(
  lifecycle: UserImageLifecycle,
  id: string,
  needles: readonly string[],
) {
  const script = `import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
const needles = process.argv.slice(1).map((needle) => Buffer.from(needle, 'utf8'));
const read = (root) => readdirSync(root, { withFileTypes: true })
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .map((entry) => {
    if (!entry.isFile()) return { name: entry.name, file: false };
    const bytes = readFileSync(root + '/' + entry.name);
    return {
      name: entry.name,
      file: true,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contains: needles.map((needle) => bytes.includes(needle)),
    };
  });
process.stdout.write(JSON.stringify({
  canonical: read('/opt/dsh-team/knowledge-base'),
  profile: read('/data/home/profiles/web/node_modules/${KNOWLEDGE_BASE}'),
}));`;
  const result = await lifecycle.commandAsync(
    ['exec', id, 'node', '--input-type=module', '-e', script, ...needles],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Knowledge-base copy observation failed');
  const read = record(JSON.parse(result.stdout));
  const entries = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('Knowledge-base copy observation is malformed');
    return value.map(record);
  };
  return { canonical: entries(read.canonical), profile: entries(read.profile) };
}

/**
 * The stored RAGFlow address and key reach neither the instance environment, its generated
 * overlay nor the knowledge-base plugin files; each scanned object is first proved genuine.
 */
async function requireNoRagflowSettings(
  lifecycle: UserImageLifecycle,
  containerId: string,
  userId: string,
): Promise<void> {
  const env = record((await inspectAsync(lifecycle, containerId)).Config).Env;
  if (!Array.isArray(env) || !env.every((entry) => typeof entry === 'string'))
    throw new Error('Instance environment is malformed');
  expect(env.some((entry) => entry.startsWith('DSH_TEAM_MODEL_API_KEY='))).toBe(true);
  const overlay = await readFile(join(lifecycle.overlayDirectory, `${userId}.patch.yml`), 'utf8');
  const rows: unknown = parse(overlay);
  if (!Array.isArray(rows)) throw new Error('Instance overlay is not a row list');
  expect(rows.some((row: unknown) => record(row).id === 'webserver')).toBe(true);
  const sentinels = Object.values(RAGFLOW_SENTINELS);
  // Positive control for the in-instance scan: the package name occurs in its own manifest.
  const { canonical, profile } = await knowledgeBaseCopies(lifecycle, containerId, [
    KNOWLEDGE_BASE,
    ...sentinels,
  ]);
  expect(canonical.map((entry) => entry.name)).toEqual(KNOWLEDGE_BASE_FILES);
  for (const entry of canonical) {
    expect(entry.file).toBe(true);
    if (typeof entry.size !== 'number' || entry.size <= 0)
      throw new Error('Empty knowledge-base file');
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  const content = (entries: Record<string, unknown>[]) =>
    entries.map(({ name, file, size, sha256 }) => ({ name, file, size, sha256 }));
  expect(content(profile)).toEqual(content(canonical));
  for (const entry of [...canonical, ...profile]) {
    if (!Array.isArray(entry.contains)) throw new Error('Knowledge-base scan is malformed');
    const contains: unknown[] = entry.contains;
    const [packageName, ...found] = contains;
    if (entry.name === 'package.json') expect(packageName).toBe(true);
    expect(found).toEqual(sentinels.map(() => false));
  }
  for (const sentinel of sentinels)
    for (const scanned of [env.join('\n'), overlay]) expect(scanned.includes(sentinel)).toBe(false);
}

// The catalog the image was built from: each entry is a registered card in its image default.
const CATALOG = (
  JSON.parse(
    readFileSync(new URL('../../images/dsh-user/catalog.json', import.meta.url), 'utf8'),
  ) as {
    entries: { id: string; package: string; category: string; imageDefaultEnabled: boolean }[];
  }
).entries;
// Default catalog settings: required entries are forced on, the office bundle is the employee's.
const FIRST_LOCKED = CATALOG.find((entry) => entry.category === 'required')?.package;

/**
 * The expected card states, with the office bundle switched as given: each required card shows
 * the platform lock forced on over its unselected native switch.
 */
function pluginExpectations(officeEnabled: boolean) {
  return CATALOG.map((entry) => ({
    package: entry.package,
    enabled: entry.package === OFFICE_AGENTS ? officeEnabled : entry.imageDefaultEnabled,
    ...(entry.category === 'required' ? { locked: 'forced-on' as const } : {}),
  }));
}

/** The live Web profile manifest and the image's seed copy, read inside the running instance. */
async function profileManifests(lifecycle: UserImageLifecycle, id: string) {
  const script = `import { readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({
  live: readFileSync('/data/home/profiles/web/package.json', 'utf8'),
  seed: readFileSync('/opt/dsh-team/profile-seed/web/package.json', 'utf8'),
}));`;
  const result = await lifecycle.commandAsync(
    ['exec', id, 'node', '--input-type=module', '-e', script],
    15_000,
  );
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Profile manifest observation failed');
  const read = record(JSON.parse(result.stdout));
  if (typeof read.live !== 'string' || typeof read.seed !== 'string')
    throw new Error('Profile manifest observation is malformed');
  return { live: read.live, seed: read.seed };
}

/** Every catalog entry is an installed `file:` dependency; the sidebar, the knowledge base and a switched-on office are selected. */
function requireRegistration(manifest: string, officeEnabled: boolean): void {
  const parsed = record(JSON.parse(manifest));
  expect(parsed.dependencies).toEqual(
    Object.fromEntries(CATALOG.map((entry) => [entry.package, `file:/opt/dsh-team/${entry.id}`])),
  );
  expect(record(record(parsed.dsh).profile).bundles).toEqual([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-better-sidebar',
    KNOWLEDGE_BASE,
    ...(officeEnabled ? [OFFICE_AGENTS] : []),
  ]);
}

/** One card per catalog entry, the released install and uninstall entries, and the switch legs. */
function expectPluginPage(
  observation: MappedHostAcceptResult,
  officeEnabled: boolean,
  legs: readonly ('off' | 'on')[],
): void {
  expect(observation.accepted).toBe(true);
  const status = officeEnabled ? 'running' : 'disabled';
  expect(observation.pluginPage).toMatchObject({
    list: { refresh: true, addButtons: 1, group: 'bundles', status, checked: officeEnabled },
    detail: { uninstallButtons: 1, checked: officeEnabled, disabled: false, title: null },
  });
  expect(observation.pluginPage?.off).toEqual(
    legs.includes('off') ? { checked: false, status: 'disabled' } : undefined,
  );
  expect(observation.pluginPage?.on).toEqual(
    legs.includes('on') ? { checked: true, status: 'running' } : undefined,
  );
  expect(observation.pluginPage?.cards).toEqual(
    pluginExpectations(officeEnabled).map((entry) => ({
      package: entry.package,
      status: entry.enabled ? 'running' : 'disabled',
      checked: entry.enabled,
      locked: 'locked' in entry ? entry.locked : null,
    })),
  );
  // The first required card: never focused by Tab, unchanged by pointer/Enter/Space, locked detail.
  expect(observation.pluginPage?.locked).toMatchObject({
    package: FIRST_LOCKED,
    focus: { roundTripSwitch: true },
    input: { checked: false, lock: 'forced-on' },
    detail: { lock: 'forced-on' },
  });
  // list, locked (after the input reload), locked-detail, detail, then one per leg.
  expect(observation.pluginPage?.screenshots).toHaveLength(4 + legs.length);
}

function requireAutomaticSession(observation: MappedHostAcceptResult): string {
  expect(observation.beforeSessionObservation).toMatchObject({
    sessionsAvailable: true,
    items: [],
    cookieNames: ['platform_session'],
    creationRequests: 0,
    createdSessionIds: [],
    failedCreations: 0,
    pendingCreations: 0,
    workspaceRequests: 0,
    promptRequests: 0,
  });
  for (const entry of [observation, observation.reload]) {
    expect(entry?.consoleErrors).toEqual([]);
    expect(entry?.ui).toMatchObject({
      workspaceSelected: true,
      chinese: true,
      noNotice: true,
      inputUsable: true,
      pickerOpen: false,
    });
    expect(entry?.initialized).toBe(true);
    expect(entry?.input).toMatchObject({ typed: true, cleared: true, modelSend: false });
    expect(entry?.accepted).toBe(true);
  }
  const id = observation.sessionObservation?.createdSessionIds[0];
  if (id === undefined) throw new Error('Untouched browser did not return a Session creation ID');
  for (const entry of [observation, observation.reload]) {
    const receipt = entry?.sessionObservation;
    expect(receipt).toMatchObject({
      sessionsAvailable: true,
      items: [{ sessionId: id, cwd: '/data/work' }],
      cookieNames: ['platform_session'],
      failedCreations: 0,
      pendingCreations: 0,
      workspaceRequests: 0,
      promptRequests: 0,
    });
    // Reload may repeat an idempotent create POST; every receipt must name the same Session.
    expect(receipt?.createdSessionIds.length).toBe(receipt?.creationRequests);
    expect(receipt?.createdSessionIds.every((created) => created === id)).toBe(true);
  }
  return id;
}

it('gives untouched employees automatic work Sessions and preserves employee state on volume reuse', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  isolatedBrowserRuntime();
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const host = 'dsh-team-first-use.invalid';
      const { app, database, base, origin } = await startBrowserPlatform(lifecycle, host);
      const evidence = resolve('.run/issue57', `first-use-${lifecycle.runId}`);
      try {
        await mkdir(evidence, { recursive: true });
        writeSettings(database, {
          modelBaseUrl: 'http://model.invalid/v1',
          modelApiKey: 'first-use-fixture-not-a-provider-key',
          models: [{ name: 'office-model' }],
          defaultModel: 'office-model',
        });
        writeSettings(database, RAGFLOW_SENTINELS);
        expect(readSettings(database)).toMatchObject(RAGFLOW_SENTINELS);
        const start = (user: { id: string; cookie: string }) =>
          startEmployeeInstance(lifecycle, base, origin, database, user);
        const enter = async (cookie: string, label: string, initial: Record<string, unknown>) => {
          const profile = await mkdtemp(join(tmpdir(), 'dsh-team-first-use-browser-'));
          try {
            const workspaces = record(record(record(initial.workspace).tables).workspaces);
            const paths = Object.values(workspaces).map((workspace) => record(workspace).path);
            const observation = await acceptObservation({
              origin,
              cookie,
              extraFlags: mappedFlags(host),
              expectedHost: host,
              composition: true,
              expectedRoster: MANAGED_BOOT_ROSTER,
              runtime: isolatedBrowserRuntime(lifecycle.runId),
              profile: join(profile, 'profile'),
              receiptFile: join(profile, 'chrome.receipt.json'),
              screenshot: join(evidence, `${label}.png`),
              browserMs: 30_000,
              workspace: {
                available: true,
                workBound: paths.length === 1 && paths[0] === '/data/work',
              },
              observeSessions: true,
              platformNav: 'employee',
            });
            await writeFile(
              join(evidence, `${label}.json`),
              JSON.stringify({ initial, observation }, null, 2),
            );
            expectEmployeeNavigation(observation);
            return requireAutomaticSession(observation);
          } finally {
            await rescueChrome(join(profile, 'chrome.receipt.json'));
            await rm(profile, { recursive: true, force: true });
          }
        };
        const requireSession = async (cookie: string, sessionId: string, title: string) => {
          const listed = record(await mappedRpc(origin, cookie, 'session/list', { _request: {} }));
          expect(listed.ok).toBe(true);
          const items = record(listed.value).items;
          if (!Array.isArray(items)) throw new Error('Session inventory unavailable');
          expect(
            items.map((value: unknown) => {
              const item = record(value);
              return { sessionId: item.sessionId, cwd: item.cwd };
            }),
          ).toEqual([{ sessionId, cwd: '/data/work' }]);
          const projected = record(
            await mappedRpc(origin, cookie, 'session/projections', {
              request: { sessionId },
            }),
          );
          expect(projected.ok).toBe(true);
          expect(record(record(projected.value).values).title).toBe(title);
        };

        // Exact-ID fixture retirement; a later start recreates the instance over the same volumes.
        const retire = async (id: string): Promise<void> => {
          for (const args of [
            ['stop', '--time', '10', id],
            ['rm', id],
          ]) {
            const result = await lifecycle.commandAsync(args, 30_000);
            if (result.status !== 0 || result.error !== undefined)
              throw new Error('Owned first-use container retirement failed');
          }
          expect(
            isAbsentResource(
              await lifecycle.commandAsync(['container', 'inspect', id], 15_000),
              'container',
              id,
            ),
          ).toBe(true);
        };

        const employee = await registerInstanceUser(base, origin, 'first-use@example.test');
        const firstId = await start(employee);
        const initial = await employeeState(lifecycle, firstId);
        // Capture browser evidence before the image-shape assertion so baseline RED remains observable.
        const sessionId = await enter(employee.cookie, 'employee', initial);
        const workspaceId = requireFreshRegistry(initial);
        await requireNoRagflowSettings(lifecycle, firstId, employee.id);
        const rename = record(
          await mappedRpc(origin, employee.cookie, 'workspace/rename', {
            request: { workspaceId, title: 'employee workspace 中文' },
          }),
        );
        expect(rename.ok).toBe(true);
        const renamedSession = record(
          await mappedRpc(origin, employee.cookie, 'session/rename', {
            request: { sessionId, title: 'employee Session 中文' },
          }),
        );
        expect(renamedSession.ok).toBe(true);
        expect(record(renamedSession.value).title).toBe('employee Session 中文');
        const preserved = await employeeState(lifecycle, firstId, true);
        const employeeStorage = {
          workspaceId,
          sessionId,
          title: 'employee workspace 中文',
          homeSentinel: 'employee state 中文\n',
          workSentinel: 'employee work 中文\n',
        };
        requireEmployeeStorage(preserved, employeeStorage);
        await requireSession(employee.cookie, sessionId, 'employee Session 中文');

        const sibling = await registerInstanceUser(base, origin, 'first-use-sibling@example.test');
        const siblingId = await start(sibling);
        const siblingInitial = await employeeState(lifecycle, siblingId);
        const siblingWorkspaceId = requireFreshRegistry(siblingInitial);
        const siblingSession = await enter(sibling.cookie, 'sibling', siblingInitial);
        expect(siblingSession).not.toBe(sessionId);
        const siblingRename = record(
          await mappedRpc(origin, sibling.cookie, 'session/rename', {
            request: { sessionId: siblingSession, title: 'sibling Session 中文' },
          }),
        );
        expect(siblingRename.ok).toBe(true);
        expect(record(siblingRename.value).title).toBe('sibling Session 中文');
        const siblingStorage = {
          workspaceId: siblingWorkspaceId,
          sessionId: siblingSession,
          title: 'work',
          homeSentinel: null,
          workSentinel: null,
        };
        const siblingState = await employeeState(lifecycle, siblingId);
        requireEmployeeStorage(siblingState, siblingStorage);
        await requireSession(sibling.cookie, siblingSession, 'sibling Session 中文');
        requireEmployeeStorage(await employeeState(lifecycle, firstId), employeeStorage);
        await requireSession(employee.cookie, sessionId, 'employee Session 中文');

        // Exact-ID fixture retirement exercises normal production recreation over the same volumes.
        await retire(firstId);
        const recreatedId = await start(employee);
        expect(recreatedId).not.toBe(firstId);
        requireEmployeeStorage(await employeeState(lifecycle, recreatedId), employeeStorage);
        await requireSession(employee.cookie, sessionId, 'employee Session 中文');
        requireEmployeeStorage(await employeeState(lifecycle, siblingId), siblingStorage);
        await requireSession(sibling.cookie, siblingSession, 'sibling Session 中文');
        await writeFile(
          join(evidence, 'reuse.json'),
          JSON.stringify(
            { preserved, recreated: await employeeState(lifecycle, recreatedId), siblingState },
            null,
            2,
          ),
        );

        // Dedicated employee: the plugin page lists every catalog entry from the image's registration.
        const plugins = await registerInstanceUser(base, origin, 'first-use-plugins@example.test');
        const observePlugins = async (label: string, office: boolean, leaveEnabled: boolean) => {
          const profile = await mkdtemp(join(tmpdir(), 'dsh-team-first-use-plugins-'));
          let observation: MappedHostAcceptResult;
          try {
            observation = await acceptObservation({
              origin,
              cookie: plugins.cookie,
              extraFlags: mappedFlags(host),
              expectedHost: host,
              composition: true,
              expectedRoster: MANAGED_BOOT_ROSTER,
              runtime: isolatedBrowserRuntime(lifecycle.runId),
              profile: join(profile, 'profile'),
              receiptFile: join(profile, 'chrome.receipt.json'),
              screenshot: join(evidence, `${label}.png`),
              browserMs: 30_000,
              workspace: { available: true, workBound: true },
              pluginPage: {
                expected: pluginExpectations(office),
                roundTrip: { package: OFFICE_AGENTS, leaveEnabled },
              },
            });
          } finally {
            await rescueChrome(join(profile, 'chrome.receipt.json'));
            await rm(profile, { recursive: true, force: true });
          }
          await writeFile(join(evidence, `${label}.json`), JSON.stringify(observation, null, 2));
          return observation;
        };
        let pluginsId = await start(plugins);
        const fresh = await profileManifests(lifecycle, pluginsId);
        requireRegistration(fresh.live, true);
        expect(fresh.live).toBe(fresh.seed);
        expectPluginPage(await observePlugins('plugins', true, true), true, ['off', 'on']);
        // DSH's saveManifest after switching off and on rewrites the image's exact bytes and order.
        expect((await profileManifests(lifecycle, pluginsId)).live).toBe(fresh.seed);

        // The switch state persists: off across a restart (the instance still starts), then on.
        expectPluginPage(await observePlugins('plugins-off', true, false), true, ['off']);
        await retire(pluginsId);
        pluginsId = await start(plugins);
        requireRegistration((await profileManifests(lifecycle, pluginsId)).live, false);
        expectPluginPage(await observePlugins('plugins-restarted-off', false, true), false, ['on']);
        await retire(pluginsId);
        pluginsId = await start(plugins);
        requireRegistration((await profileManifests(lifecycle, pluginsId)).live, true);
        expectPluginPage(await observePlugins('plugins-restarted-on', true, true), true, [
          'off',
          'on',
        ]);
        return JSON.stringify({
          automaticWorkSessions: true,
          isolatedEmployees: true,
          preservedEmployeeState: true,
          pluginPageWithInstallEntries: true,
          pluginSwitchPersists: true,
        });
      } finally {
        await app.close();
      }
    },
  );
});

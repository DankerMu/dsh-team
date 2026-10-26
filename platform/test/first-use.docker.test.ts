import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { acceptObservation, mappedFlags, mappedRpc } from '../../scripts/probe-mapped-host.mjs';
import type { MappedHostAcceptResult } from '../../scripts/probe-mapped-host.mjs';
import { writeSettings } from '../src/db/index.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { startBrowserPlatform } from './instance-browser-docker-fixture.ts';
import { MANAGED_BOOT_ROSTER } from './managed-policy-fixture.ts';
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
        const start = async (user: { id: string; cookie: string }): Promise<string> => {
          const ownership = { 'dsh-team.user': user.id };
          for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
            await lifecycle.registerResourceAsync('volume', name, ownership);
          await lifecycle.registerResourceAsync('container', `dsh-team-u-${user.id}`, ownership);
          const response = await fetch(`${base}/_platform/api/instance/start`, {
            method: 'POST',
            headers: { cookie: user.cookie, origin, 'content-type': 'application/json' },
            body: '{}',
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'starting', reason: 'starting' });
          const deadline = Date.now() + 90_000;
          for (;;) {
            const status = await fetch(`${base}/_platform/api/instance`, {
              headers: { cookie: user.cookie },
            });
            expect(status.status).toBe(200);
            const state = record(await status.json());
            if (state.status === 'running') {
              expect(state.reason).toBeNull();
              break;
            }
            expect(state).toEqual({ status: 'starting', reason: 'starting' });
            if (Date.now() >= deadline) throw new Error('First-use instance readiness deadline');
            await delay(100);
          }
          const row = record(
            database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(user.id),
          );
          if (typeof row.container_id !== 'string') throw new Error('Missing ready container ID');
          const container = await inspectAsync(lifecycle, row.container_id);
          expect(container.Id).toBe(row.container_id);
          expect(container.Image).toBe(lifecycle.imageId);
          expect(container.Name).toBe(`/dsh-team-u-${user.id}`);
          expect(record(container.Config).Labels).toMatchObject({
            'dsh-team.user': user.id,
            'dsh-team.test-run': lifecycle.runId,
          });
          expect(container.Mounts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                Type: 'volume',
                Name: `dsh-team-home-${user.id}`,
                Destination: '/data/home',
                RW: true,
              }),
              expect.objectContaining({
                Type: 'volume',
                Name: `dsh-team-work-${user.id}`,
                Destination: '/data/work',
                RW: true,
              }),
            ]),
          );
          return row.container_id;
        };
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

        const employee = await registerInstanceUser(base, origin, 'first-use@example.test');
        const firstId = await start(employee);
        const initial = await employeeState(lifecycle, firstId);
        // Capture browser evidence before the image-shape assertion so baseline RED remains observable.
        const sessionId = await enter(employee.cookie, 'employee', initial);
        const workspaceId = requireFreshRegistry(initial);
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
        for (const args of [
          ['stop', '--time', '10', firstId],
          ['rm', firstId],
        ]) {
          const result = await lifecycle.commandAsync(args, 30_000);
          if (result.status !== 0 || result.error !== undefined)
            throw new Error('Owned first-use container retirement failed');
        }
        expect(
          isAbsentResource(
            await lifecycle.commandAsync(['container', 'inspect', firstId], 15_000),
            'container',
            firstId,
          ),
        ).toBe(true);
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
        return JSON.stringify({
          automaticWorkSessions: true,
          isolatedEmployees: true,
          preservedEmployeeState: true,
        });
      } finally {
        await app.close();
      }
    },
  );
});

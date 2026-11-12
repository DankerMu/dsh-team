import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { MappedHostPluginPageOptions } from '../../scripts/probe-mapped-host.mjs';
import { isolatedBrowserRuntime, rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import { catalogStates, readPluginCatalog } from '../src/plugin-catalog/index.ts';
import { createManagedPolicyEvidence } from './managed-policy-evidence.ts';
import type { ManagedPolicyStage } from './managed-policy-evidence.ts';
import {
  acceptManaged,
  collectComposition,
  execScript,
  installObserverScript,
  lifecycleWebNetwork,
  MANAGED_POLICY_EXPECTED,
  publishOverlay,
} from './managed-policy-fixture.ts';
import { createProfileRecorder } from './managed-policy-profile.ts';
import { profileManifests } from './profile-manifests.ts';
import { PROBE_PLUGIN, registryStandInScript } from './registry-stand-in.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const INVALID = 'Invalid install dialog observation';
// The image's runtime user (images/dsh-user/Dockerfile:117,121), as execWebScript execs.
const RUNTIME_USER = '1001';
const PORT = 4873;
/**
 * The overlay's only package source, the 39.A stand-in on the instance's own loopback. The
 * released dialog asks `pluginRegistryProbe.fastest()` only from `readRegistries`
 * (dsh-client-ui-plugin-manager 0.2.1-rc.2 lib/client.js:1269-1282), after `eligibleMirror`
 * (:956-966) named a mirror, and that returns undefined whenever `registries.registry` is not null.
 * The overlay always writes `registry` (managed-config generate.ts:391), so with this single
 * registry the UI never calls the probe, whatever `registryMemory` holds; even on that path the host
 * service answers null while disabled (lib/index.js:93-95). The client's `fastest.ok/value`
 * (:1284) is the Remote transport's wrapping: the host binding declares the method
 * `Promise<string | null>` (lib/typert.host.js:7,49), so the observer's host call gets bare null.
 */
const REGISTRY = `http://127.0.0.1:${String(PORT)}/`;
const OVERLAY_SETTINGS = { pluginRegistries: [REGISTRY], registryProbeEnabled: false };
// The image's selection; required entries forced on, the rest the employee's (migration 5).
const CARDS = catalogStates(readPluginCatalog(), { pluginCatalog: {} }).map((entry) => ({
  package: entry.package,
  enabled: entry.imageDefaultEnabled,
  ...(entry.state === 'employee' ? {} : { locked: entry.state }),
}));
const ROUND_TRIP = { package: 'dsh-sidebar-onlyoffice', leaveEnabled: true };

/** The installed card on the restart's list: still in the 已安装 group and running. */
export const RESTART_CARDS = [...CARDS, { package: PROBE_PLUGIN, enabled: true }];

/** Runs `args` as the runtime user inside `container`; undefined when the exec failed. */
async function execAs(
  lifecycle: UserImageLifecycle,
  container: string,
  args: readonly string[],
  detach = false,
): Promise<string | undefined> {
  const result = await lifecycle.commandAsync(
    ['exec', '--user', RUNTIME_USER, ...(detach ? ['-d'] : []), container, ...args],
    15_000,
  );
  return result.error === undefined && result.status === 0 ? result.stdout : undefined;
}

/**
 * Starts the stand-in inside the running instance on the fixed port, logging to a fresh
 * `mktemp -d` directory under its /tmp, and returns that directory once the ready marker names
 * the overlay's registry. It dies with the container; nothing else is left to clean up.
 */
async function startStandIn(lifecycle: UserImageLifecycle, container: string): Promise<string> {
  const made = await execAs(lifecycle, container, ['mktemp', '-d', '/tmp/dsh-team-install-XXXXXX']);
  const directory = made?.trim() ?? '';
  if (!/^\/tmp\/dsh-team-install-\w{6}$/.test(directory)) throw new Error(`${INVALID}: tmp`);
  const script = registryStandInScript({
    port: PORT,
    requestLog: `${directory}/requests.log`,
    readyMarker: `${directory}/ready`,
  });
  const node = ['node', '--input-type=module', '-e', script];
  if ((await execAs(lifecycle, container, node, true)) === undefined) {
    throw new Error(`${INVALID}: stand-in start`);
  }
  const deadline = Date.now() + 30_000;
  while ((await execAs(lifecycle, container, ['cat', `${directory}/ready`])) !== REGISTRY) {
    if (Date.now() > deadline) throw new Error(`${INVALID}: stand-in not ready`);
    await delay(250);
  }
  return directory;
}

/** Every request line the stand-in logged, read back from the still-running instance. */
async function standInRequests(
  lifecycle: UserImageLifecycle,
  container: string,
  directory: string,
): Promise<string[]> {
  const log = await execAs(lifecycle, container, ['cat', `${directory}/requests.log`]);
  if (log === undefined) throw new Error(`${INVALID}: stand-in log`);
  return log.split('\n').filter((line) => line !== '');
}

/** Whether the live profile selects the probe plugin, and the dependency it records for it. */
async function probeSelection(lifecycle: UserImageLifecycle, container: string) {
  const { live } = await profileManifests(lifecycle, container);
  const parsed = JSON.parse(live) as {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles = parsed.dsh?.profile?.bundles;
  return {
    selected: Array.isArray(bundles) && bundles.includes(PROBE_PLUGIN),
    dependency: parsed.dependencies?.[PROBE_PLUGIN] ?? null,
  };
}

/** The observer's plugin page and plugin manager readings. */
function liveSources(observation: unknown) {
  const { pluginPage, pluginManager } = observation as Record<string, unknown>;
  return { pluginPage, pluginManager };
}

/**
 * #409 39.C1b: the overlay names only the stand-in and turns the registry probe off. The first
 * start runs the stand-in inside the instance and installs the probe plugin through the plugin page
 * dialog; the restart over the same volumes must still list it running, without the stand-in and
 * without a second install (the same profile refuses one, client.js:1476-1486).
 */
export async function runInstallDialogScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const evidence = createManagedPolicyEvidence(lifecycle);
  const prefix = `dsh-team-test-${lifecycle.runId}`;
  const profiles = createProfileRecorder(
    (phase, script) => execScript(lifecycle, `${prefix}-profile-${phase}`, script),
    evidence,
  );
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-install-dialog-'));
  let failedStage: ManagedPolicyStage | undefined;
  try {
    const runtime = isolatedBrowserRuntime(lifecycle.runId);
    const startedAt = Date.now();
    // Two plugin-page passes on top of the managed acceptance, one with a pnpm install.
    const remaining = (): number => Math.max(1, 480_000 - (Date.now() - startedAt));
    mkdirSync(lifecycle.overlayDirectory, { recursive: true });
    const plugin = readFileSync(new URL('./managed-policy-observer.js', import.meta.url), 'utf8');
    execScript(lifecycle, `${prefix}-observer`, installObserverScript(plugin));
    const composition = await collectComposition(lifecycle, `${prefix}-read`);
    const accept = async (label: 'start' | 'restart', pluginPage: MappedHostPluginPageOptions) => {
      failedStage = label;
      const network = lifecycleWebNetwork(lifecycle, label);
      const overlay = await publishOverlay(
        lifecycle.overlayDirectory,
        composition,
        true,
        network,
        OVERLAY_SETTINGS,
      );
      return acceptManaged(
        lifecycle,
        overlay,
        network,
        remaining,
        runtime,
        work,
        evidence,
        profiles,
        { ...MANAGED_POLICY_EXPECTED, registryProbeEnabled: false },
        label,
        pluginPage,
      );
    };
    const startName = `${prefix}-start`;
    let directory: string | undefined;
    const prepare = async () => {
      directory = await startStandIn(lifecycle, startName);
    };
    const install = { package: PROBE_PLUGIN, prepare };
    const started = await accept('start', { expected: CARDS, roundTrip: ROUND_TRIP, install });
    if (directory === undefined) throw new Error(`${INVALID}: stand-in never prepared`);
    const start = {
      ...liveSources(started.observation),
      requests: await standInRequests(lifecycle, startName, directory),
      install: started.browser.pluginPage?.install,
      installed: await probeSelection(lifecycle, startName),
    };
    const stopped = lifecycle.command(['stop', startName], 30_000);
    if (stopped.error !== undefined || stopped.status !== 0) throw new Error(`${INVALID}: stop`);
    profiles.capture('start-stopped');
    failedStage = 'restart';
    // Like the platform before every start: the installed empty bundle composes nothing new.
    const recomposed = await collectComposition(lifecycle, `${prefix}-reread`);
    profiles.capture('recompose-read');
    if (!isDeepStrictEqual(recomposed, composition)) throw new Error(`${INVALID}: recomposed`);
    const restarted = await accept('restart', { expected: RESTART_CARDS, roundTrip: ROUND_TRIP });
    const restart = {
      ...liveSources(restarted.observation),
      cards: restarted.browser.pluginPage?.cards,
      installed: await probeSelection(lifecycle, `${prefix}-restart`),
    };
    evidence.finish();
    return JSON.stringify({ registry: REGISTRY, start, restart, evidence: evidence.path });
  } catch (error) {
    evidence.fail(failedStage);
    throw error;
  } finally {
    await rescueChrome(join(work, 'chrome-start.receipt.json'));
    await rescueChrome(join(work, 'chrome-restart.receipt.json'));
    rmSync(work, { recursive: true, force: true });
  }
}

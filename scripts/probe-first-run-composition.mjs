/** Deployed artifact preparation and independent, read-only composition readiness. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evalPage, observeFirstRun, waitFor } from './probe-dsh-api-ui.mjs';

export const COMPOSITION_PLUGIN = '@dsh-team/zh-locale';
export const COMPOSITION_PIN = '0.2.0-rc.2';
const GENERAL = '@deepseek-ai/dsh-client-ui-settings-general';
const MODEL_SELECTION = '@deepseek-ai/dsh-client-ui-model-selection';
export const PERSONAL_MODELS = '@deepseek-ai/dsh-client-ui-settings-models';
const ARTIFACT_FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const validateCompositionPackage = async (pluginDir) => {
  const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  if (
    manifest.name !== COMPOSITION_PLUGIN ||
    manifest.peerDependencies?.['@deepseek-ai/dsh'] !== COMPOSITION_PIN ||
    manifest.dsh?.client?.platform !== 'web' ||
    manifest.exports?.['./client'] !== './client.js'
  ) {
    throw new Error('stage=composition error=package-pin-or-registration');
  }
};

export const prepareComposition = async ({ home, seed, pluginDir, overlay, fault, extraPatch }) => {
  if (!['', 'missing-plugin', 'wrong-plugin', 'reenabled-notice'].includes(fault)) {
    throw new Error('stage=composition error=invalid-fault');
  }
  await validateCompositionPackage(pluginDir);
  // Discovery's workspace Session ids are probe state, never a production seed promise.
  const workspace = await readFile(join(seed, 'storages/workspace.json'));
  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(join(home, 'storages/workspace.json'), workspace);
  const target = join(home, 'profiles/web/node_modules/@dsh-team/zh-locale');
  await mkdir(target, { recursive: true });
  const artifacts = {};
  for (const file of ARTIFACT_FILES) {
    const bytes = await readFile(join(pluginDir, file));
    artifacts[file] = digest(bytes);
    if (fault !== 'missing-plugin') {
      await writeFile(join(target, file), bytes);
      if (digest(await readFile(join(target, file))) !== artifacts[file]) {
        throw new Error('stage=composition error=artifact-copy');
      }
    }
  }
  if (fault === 'wrong-plugin') {
    // Disposable mutant only: manifest/roster still advertise the expected package.
    await writeFile(
      join(target, 'client.js'),
      "window.__ModuleLoader__.load({id:'@dsh-team/wrong-plugin',factory:()=>({})});\n",
    );
  }
  // Append the canonical YAML sequence verbatim, not a probe-only patch reimplementation.
  let patch = await readFile(join(pluginDir, 'cordis.patch.yml'), 'utf8');
  if (fault === 'reenabled-notice') patch += '\n- id: ui-settings-models\n  disabled: false\n';
  if (extraPatch) patch += `\n${await readFile(extraPatch, 'utf8')}\n`;
  await writeFile(overlay, `${await readFile(overlay, 'utf8')}\n${patch}`);
  return {
    package: COMPOSITION_PLUGIN,
    pin: COMPOSITION_PIN,
    artifacts,
    deployedClientSha256:
      fault === 'missing-plugin' ? null : digest(await readFile(join(target, 'client.js'))),
    overlaySha256: digest(await readFile(overlay)),
    fault,
    extraPatch: Boolean(extraPatch),
  };
};

export const readBootRoster = async (page) => {
  const graph = await evalPage(
    page,
    '(function(){const g=window.__DSH_BOOT__;return g?{rev:g.rev,entries:g.entries}:null;})()',
  );
  if (!graph || typeof graph.rev !== 'string' || !Array.isArray(graph.entries)) {
    throw new Error('stage=composition error=roster-unknown');
  }
  const rows = graph.entries;
  if (
    !rows.length ||
    rows.length > 256 ||
    rows.some(
      (row) =>
        typeof row?.id !== 'string' || typeof row.rev !== 'string' || typeof row.url !== 'string',
    ) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    throw new Error('stage=composition error=roster-malformed');
  }
  return { rev: graph.rev, ids: rows.map((row) => row.id).sort() };
};

export const expectedCompositionRoster = async (baselineFile) => {
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
  const ids = baseline.bootRoster?.ids;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    ![GENERAL, MODEL_SELECTION, PERSONAL_MODELS].every((id) => ids.includes(id)) ||
    ids.includes(COMPOSITION_PLUGIN)
  ) {
    throw new Error('stage=composition error=baseline-roster-unknown');
  }
  return [...ids.filter((id) => id !== PERSONAL_MODELS), COMPOSITION_PLUGIN].sort();
};

export const assertRosterObservation = (roster, expected) => {
  const ids = Array.isArray(roster?.ids) ? roster.ids : undefined;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error('stage=composition error=roster-unknown');
  }
  if (
    ![COMPOSITION_PLUGIN, GENERAL, MODEL_SELECTION].every((id) => ids.includes(id)) ||
    ids.includes(PERSONAL_MODELS) ||
    JSON.stringify(ids) !== JSON.stringify(expected)
  ) {
    throw new Error('stage=composition error=roster-mismatch');
  }
  return roster;
};

export const assertCompositionRoster = async (page, expected) => {
  return assertRosterObservation(await readBootRoster(page), expected);
};

export const waitCompositionInitialized = async (page, ms, noticeSeen, expected) => {
  const roster = await assertCompositionRoster(page, expected);
  let seen = noticeSeen;
  let last = await observeFirstRun(page);
  try {
    last = await waitFor(
      async () => {
        const state = await observeFirstRun(page);
        last = state;
        seen ||= Boolean(state.notice);
        const rendered = await evalPage(
          page,
          `(function(){
            const usable=(el)=>Boolean(el&&el.getClientRects().length&&!el.disabled&&!el.closest('[inert]'));
            const settings=document.querySelector('button[aria-label="设置"],button[aria-label="Settings"]');
            const session=document.querySelector('button[aria-label="新建会话"],button[aria-label="New session"]');
            return usable(settings)&&usable(session);
          })()`,
        );
        return rendered && state.composerPresent && state.workspaceSelected && state.editable
          ? state
          : null;
      },
      ms,
      'composition-rendered-session-settings',
    );
  } catch (error) {
    if (error?.message !== 'timed out waiting for composition-rendered-session-settings')
      throw error;
    return { initialized: false, last, noticeSeen: seen, store: null, roster };
  }
  return { initialized: true, last, noticeSeen: seen, store: null, roster };
};

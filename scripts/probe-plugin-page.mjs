/**
 * Real DSH sidebar plugin page evidence: the released install and uninstall entries are present,
 * and the office-agents bundle switch stays usable and round-trips across reloads. DOM facts only.
 */
import { captureSettledScreenshot, clickSelector, evalPage, waitFor } from './probe-dsh-api-ui.mjs';

const PACKAGE = '@dsh-team/office-agents';
// Released 0.2.1-rc.2 zh labels (`panel`, `openDetail`, `enableToggle`, `refresh`, `addPlugin`,
// `uninstall`/`uninstallLabel`); the package has no display title, so its name is the title.
const PANEL = 'button[aria-label="插件"]';
const OPEN = `[data-plugin-package="${PACKAGE}"] button[aria-label="查看 ${PACKAGE}"]`;
const SWITCH = `button[role="switch"][aria-label="启用 ${PACKAGE}"]`;
const REFRESH = ['刷新', 'Refresh'];
const ADD = ['添加插件', 'Add plugin'];
const UNINSTALL = ['卸载', 'Uninstall'];
const UNINSTALL_LABEL = ['卸载 ', 'Uninstall '];

/** Panel, toolbar, card, detail and switch state; counts of install/uninstall buttons anywhere. */
const OBSERVE = `(function(){
  const rendered=(el)=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]');
  };
  const text=(el)=>(el.textContent||'').trim();
  const label=(el)=>el.getAttribute('aria-label')||'';
  const buttons=[...document.querySelectorAll('button')];
  const panel=document.querySelector('[data-plugin-panel]');
  const refresh=panel?[...panel.querySelectorAll('button')].find((el)=>${JSON.stringify(REFRESH)}.includes(label(el))):undefined;
  const card=document.querySelector(${JSON.stringify(`[data-plugin-package="${PACKAGE}"]`)});
  const detail=document.querySelector(${JSON.stringify(`[data-plugin-detail="${PACKAGE}"]`)});
  const toggle=document.querySelector(${JSON.stringify(SWITCH)});
  const group=card&&card.closest('[data-plugin-group]');
  return {
    panel:Boolean(panel),
    busy:panel?panel.getAttribute('aria-busy'):null,
    refresh:Boolean(refresh&&rendered(refresh)),
    add:buttons.filter((el)=>${JSON.stringify(ADD)}.includes(text(el))||${JSON.stringify(ADD)}.includes(label(el))).length,
    uninstall:buttons.filter((el)=>${JSON.stringify(UNINSTALL)}.includes(text(el))||${JSON.stringify(UNINSTALL_LABEL)}.some((prefix)=>label(el).startsWith(prefix))).length,
    card:card?{group:group?group.getAttribute('data-plugin-group'):null,status:card.getAttribute('data-plugin-status')}:null,
    detail:Boolean(detail),
    toggle:toggle?{
      checked:toggle.getAttribute('aria-checked'),
      disabled:toggle.disabled,
      title:toggle.getAttribute('title'),
      inDetail:Boolean(detail&&detail.contains(toggle)),
      inCard:Boolean(card&&card.contains(toggle)),
    }:null,
  };
})()`;

const fail = (stage, error, observed) => {
  // Bounded DOM facts only; no page text, cookies or request bodies.
  throw new Error(`stage=${stage} error=${error} observed=${JSON.stringify(observed ?? null)}`);
};

/** Wait for `ready`, keeping the last observation for a bounded failure message. */
const settle = async (page, stage, ms, ready) => {
  let last;
  try {
    return await waitFor(
      async () => {
        last = await evalPage(page, OBSERVE);
        return last && ready(last) ? last : false;
      },
      ms,
      stage,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('stage=')) throw error;
    return fail(stage, 'timeout', last);
  }
};

const switchSettled = (observed, place) =>
  Boolean(observed.toggle?.[place] && !observed.toggle.disabled && observed.toggle.title === null);

/** The loaded card list: refresh visible, the bundle's card and its unlocked switch. */
const openList = async (page, stage, ms) => {
  // The panel row is a slot entry that can render after the app reports ready (and after a reload).
  await waitFor(
    () =>
      clickSelector(page, PANEL).then(
        () => true,
        () => false,
      ),
    ms,
    `${stage}-panel`,
  ).catch(() => fail(stage, 'panel'));
  const observed = await settle(
    page,
    stage,
    ms,
    (state) =>
      state.panel && state.busy === 'false' && state.refresh && switchSettled(state, 'inCard'),
  );
  if (observed.add < 1) fail(stage, 'add-plugin', observed);
  if (observed.card?.group !== 'bundles') fail(stage, 'group', observed);
  if (observed.card.status === 'problem') fail(stage, 'status', observed);
  return observed;
};

/** Click the bundle switch and wait until the page reports the requested state, unlocked. */
const setEnabled = async (page, stage, ms, place, enabled) => {
  await clickSelector(page, SWITCH);
  await settle(
    page,
    stage,
    ms,
    (state) => switchSettled(state, place) && state.toggle.checked === String(enabled),
  );
};

/** After a reload, the reopened list must show the switch exactly as last set. */
const readBack = async (page, stage, ms, reload, enabled) => {
  await reload();
  const observed = await openList(page, stage, ms);
  if (observed.toggle.checked !== String(enabled)) fail(stage, 'read-back', observed);
  return { checked: enabled, status: observed.card.status };
};

/**
 * Prove the plugin page offers its install and uninstall entries, then switch the bundle off and on
 * with a reload after each. Leaves the bundle on. `reload` re-navigates the same page.
 */
export const verifyPluginPage = async ({ page, errors, screenshot, ms, reload }) => {
  const shot = (suffix) =>
    captureSettledScreenshot(page, screenshot.replace(/\.png$/, `-plugin-page-${suffix}.png`));
  const listed = await openList(page, 'plugin-page-list', ms);
  if (listed.toggle.checked !== 'true') fail('plugin-page-list', 'initially-off', listed);
  const screenshots = [await shot('list')];
  await clickSelector(page, OPEN);
  const detail = await settle(page, 'plugin-page-detail', ms, (state) =>
    Boolean(state.detail && switchSettled(state, 'inDetail')),
  );
  if (detail.uninstall < 1) fail('plugin-page-detail', 'uninstall', detail);
  screenshots.push(await shot('detail'));
  await setEnabled(page, 'plugin-page-switch-off', ms, 'inDetail', false);
  const off = await readBack(page, 'plugin-page-off', ms, reload, false);
  screenshots.push(await shot('off'));
  await setEnabled(page, 'plugin-page-switch-on', ms, 'inCard', true);
  const on = await readBack(page, 'plugin-page-on', ms, reload, true);
  screenshots.push(await shot('on'));
  if (errors.length) throw new Error(`stage=plugin-page error=console count=${errors.length}`);
  return {
    list: {
      refresh: listed.refresh,
      addButtons: listed.add,
      group: listed.card.group,
      status: listed.card.status,
      checked: true,
    },
    detail: {
      uninstallButtons: detail.uninstall,
      checked: detail.toggle.checked === 'true',
      disabled: detail.toggle.disabled,
      title: detail.toggle.title,
    },
    off,
    on,
    screenshots,
  };
};

/**
 * Real DSH sidebar plugin page evidence: every catalog package has its card in the expected state,
 * the released install and uninstall entries are present, and one bundle switch stays usable and
 * round-trips across reloads. DOM facts only.
 */
import { captureSettledScreenshot, clickSelector, evalPage, waitFor } from './probe-dsh-api-ui.mjs';

// Released 0.2.1-rc.2 zh labels (`panel`, `openDetail`, `enableToggle`, `refresh`, `addPlugin`,
// `uninstall`/`uninstallLabel`); the packages have no display title, so the name is the title.
const PANEL = 'button[aria-label="插件"]';
const REFRESH = ['刷新', 'Refresh'];
const ADD = ['添加插件', 'Add plugin'];
const UNINSTALL = ['卸载', 'Uninstall'];
const UNINSTALL_LABEL = ['卸载 ', 'Uninstall '];

const switchSelector = (name) => `button[role="switch"][aria-label="启用 ${name}"]`;

/**
 * Panel, toolbar, every catalog card, the round-trip package's detail and switch state; counts of
 * install/uninstall buttons anywhere.
 */
const observeExpression = (packages, name) => `(function(){
  const rendered=(el)=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[inert]');
  };
  const text=(el)=>(el.textContent||'').trim();
  const label=(el)=>el.getAttribute('aria-label')||'';
  const buttons=[...document.querySelectorAll('button')];
  const panel=document.querySelector('[data-plugin-panel]');
  const refresh=panel?[...panel.querySelectorAll('button')].find((el)=>${JSON.stringify(REFRESH)}.includes(label(el))):undefined;
  const cardOf=(pkg)=>document.querySelector('[data-plugin-package="'+pkg+'"]');
  const card=cardOf(${JSON.stringify(name)});
  const detail=document.querySelector(${JSON.stringify(`[data-plugin-detail="${name}"]`)});
  const toggle=document.querySelector(${JSON.stringify(switchSelector(name))});
  return {
    panel:Boolean(panel),
    busy:panel?panel.getAttribute('aria-busy'):null,
    refresh:Boolean(refresh&&rendered(refresh)),
    add:buttons.filter((el)=>${JSON.stringify(ADD)}.includes(text(el))||${JSON.stringify(ADD)}.includes(label(el))).length,
    uninstall:buttons.filter((el)=>${JSON.stringify(UNINSTALL)}.includes(text(el))||${JSON.stringify(UNINSTALL_LABEL)}.some((prefix)=>label(el).startsWith(prefix))).length,
    cards:${JSON.stringify(packages)}.map((pkg)=>{
      const el=cardOf(pkg),group=el&&el.closest('[data-plugin-group]'),sw=el&&el.querySelector('button[role="switch"]');
      return {package:pkg,present:Boolean(el),group:group?group.getAttribute('data-plugin-group'):null,
        status:el?el.getAttribute('data-plugin-status'):null,checked:sw?sw.getAttribute('aria-checked'):null};
    }),
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

const stateName = (enabled) => (enabled ? 'on' : 'off');
const statusOf = (enabled) => (enabled ? 'running' : 'disabled');
const cardOf = (observed, name) => observed.cards.find((card) => card.package === name);

/** Wait for `ready`, keeping the last observation for a bounded failure message. */
const settle = async (page, probe, stage, ms, ready) => {
  let last;
  try {
    return await waitFor(
      async () => {
        last = await evalPage(page, probe.observe);
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

/** The loaded card list: refresh visible and the round-trip switch unlocked, unless its card is absent. */
const openList = async (page, probe, stage, ms) => {
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
    probe,
    stage,
    ms,
    (state) =>
      state.panel &&
      state.busy === 'false' &&
      state.refresh &&
      (switchSettled(state, 'inCard') || cardOf(state, probe.name)?.present === false),
  );
  if (observed.add < 1) fail(stage, 'add-plugin', observed);
  return observed;
};

/** Click the bundle switch and wait until the page reports the requested state, unlocked. */
const setEnabled = async (page, probe, stage, ms, place, enabled) => {
  await clickSelector(page, probe.toggle);
  await settle(
    page,
    probe,
    stage,
    ms,
    (state) => switchSettled(state, place) && state.toggle.checked === String(enabled),
  );
};

/** Switch the bundle, reload, and require the reopened list to show it exactly as set. */
const leg = async (page, probe, ms, reload, place, enabled) => {
  await setEnabled(page, probe, `plugin-page-switch-${stateName(enabled)}`, ms, place, enabled);
  await reload();
  const stage = `plugin-page-${stateName(enabled)}`;
  const observed = await openList(page, probe, stage, ms);
  const card = cardOf(observed, probe.name);
  if (observed.toggle.checked !== String(enabled) || card?.status !== statusOf(enabled))
    fail(stage, 'read-back', observed);
  return { checked: enabled, status: card.status };
};

/** Each catalog card listed in the 已安装 group, running and switched on exactly when expected. */
const requireCards = (observed, expected) => {
  const matches = ({ package: name, enabled }) => {
    const card = cardOf(observed, name);
    return (
      card?.present === true &&
      card.group === 'bundles' &&
      card.status === statusOf(enabled) &&
      card.checked === String(enabled)
    );
  };
  if (!expected.every(matches)) fail('plugin-page-list', 'catalog-card', observed.cards);
};

const validOptions = (expected, roundTrip) =>
  Array.isArray(expected) &&
  typeof roundTrip?.leaveEnabled === 'boolean' &&
  expected.some((entry) => entry.package === roundTrip.package);

/**
 * Prove the plugin page lists every `expected` package with its state and offers its install and
 * uninstall entries, then switch `roundTrip.package` away from its expected state with a reload,
 * and back with another reload unless `roundTrip.leaveEnabled` is that away state. `reload`
 * re-navigates the same page.
 */
export const verifyPluginPage = async ({
  page,
  errors,
  screenshot,
  ms,
  reload,
  expected,
  roundTrip,
}) => {
  if (!validOptions(expected, roundTrip)) throw new Error('stage=plugin-page error=options');
  const name = roundTrip.package;
  const initial = expected.find((entry) => entry.package === name).enabled;
  const probe = {
    name,
    observe: observeExpression(
      expected.map((entry) => entry.package),
      name,
    ),
    toggle: switchSelector(name),
  };
  const shot = (suffix) =>
    captureSettledScreenshot(page, screenshot.replace(/\.png$/, `-plugin-page-${suffix}.png`));
  const listed = await openList(page, probe, 'plugin-page-list', ms);
  requireCards(listed, expected);
  const screenshots = [await shot('list')];
  await clickSelector(page, `[data-plugin-package="${name}"] button[aria-label="查看 ${name}"]`);
  const detail = await settle(page, probe, 'plugin-page-detail', ms, (state) =>
    Boolean(state.detail && switchSettled(state, 'inDetail')),
  );
  if (detail.uninstall < 1) fail('plugin-page-detail', 'uninstall', detail);
  screenshots.push(await shot('detail'));
  const legs = { [stateName(!initial)]: await leg(page, probe, ms, reload, 'inDetail', !initial) };
  screenshots.push(await shot(stateName(!initial)));
  if (roundTrip.leaveEnabled === initial) {
    legs[stateName(initial)] = await leg(page, probe, ms, reload, 'inCard', initial);
    screenshots.push(await shot(stateName(initial)));
  }
  if (errors.length) throw new Error(`stage=plugin-page error=console count=${errors.length}`);
  const card = cardOf(listed, name);
  return {
    list: {
      refresh: listed.refresh,
      addButtons: listed.add,
      group: card.group,
      status: card.status,
      checked: initial,
    },
    detail: {
      uninstallButtons: detail.uninstall,
      checked: detail.toggle.checked === 'true',
      disabled: detail.toggle.disabled,
      title: detail.toggle.title,
    },
    ...legs,
    cards: listed.cards.map((card) => ({
      package: card.package,
      status: card.status,
      checked: card.checked === 'true',
    })),
    screenshots,
  };
};

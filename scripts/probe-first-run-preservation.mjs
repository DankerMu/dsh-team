/** Ordinary Settings/model UI exercise, only after first-entry + refresh acceptance. */
import {
  clickSelector,
  evalPage,
  remainingMs,
  waitComposer,
  waitFor,
} from './probe-dsh-api-ui.mjs';
import {
  ACCOUNT_MENU_SETTINGS_LABELS,
  ACCOUNT_MENU_TRIGGER,
  SETTINGS_BUTTON,
} from './probe-first-run-composition.mjs';

const DIALOG = '[role="dialog"][data-shortcut-modal="settings"]';
const MODEL_TRIGGER = 'button[aria-label^="选择模型"],button[aria-label="请选择模型"]';

const clickExactText = async (page, selector, text) => {
  const clicked = await evalPage(
    page,
    `(function(){
      const rows=[...document.querySelectorAll(${JSON.stringify(selector)})];
      const el=rows.find(el=>(el.textContent||'').replace(/\\s+/g,' ').trim()===${JSON.stringify(text)});
      if(!el||el.disabled||el.closest('[inert]')||!el.getClientRects().length)return false;
      el.click();return true;
    })()`,
  );
  if (!clicked) throw new Error('stage=preservation error=missing-control');
};

const openModelList = async (page, ms) => {
  await clickSelector(page, MODEL_TRIGGER);
  await waitFor(
    () =>
      evalPage(
        page,
        'Boolean(document.querySelector(\'[aria-label="模型与推理等级"] button[role="menuitem"]\'))',
      ),
    ms,
    'preservation-model-menu',
  );
  const drilled = await evalPage(
    page,
    `(function(){
    const row=[...document.querySelectorAll('[aria-label="模型与推理等级"] button[role="menuitem"]')]
      .find(el=>[...el.querySelectorAll('span')].some(s=>s.textContent.trim()==='模型'));
    if(!row||row.disabled)return false;row.click();return true;
  })()`,
  );
  if (!drilled) throw new Error('stage=preservation error=model-pane');
};

const modelOptions = (page) =>
  evalPage(
    page,
    `(function(){
  const menu=document.querySelector('[role="menu"][aria-label="模型"]');
  return menu?[...menu.querySelectorAll('button[role="menuitemradio"]')]
    .filter(el=>!el.disabled&&el.getClientRects().length)
    .map(el=>({name:el.title,selected:el.getAttribute('aria-checked')==='true'})):[];
})()`,
  );

/**
 * Open Settings through the rendered `settings.launcher` entry: the 0.2.1 account menu's `设置`
 * item, or the plain fallback button. Click-driven, no hover. The 0.2.1 open-settings shortcut has
 * no `web:linux` binding (settings-general lib/client.js:1195-1232; dsh-client-shortcuts
 * lib/client.js:874, 1342-1349), so the Linux verification browser cannot use the keyboard.
 */
const openSettings = async (page, budget) => {
  // The launcher is a slot entry and can mount after the app reports ready.
  const launcher = await waitFor(
    () =>
      evalPage(
        page,
        `(function(){
      const usable=(el)=>Boolean(el&&el.getClientRects().length&&!el.disabled&&!el.closest('[inert]'));
      const menu=[...document.querySelectorAll(${JSON.stringify(ACCOUNT_MENU_TRIGGER)})].find(usable);
      if(menu){if(menu.getAttribute('aria-expanded')!=='true')menu.click();return 'menu';}
      const direct=[...document.querySelectorAll(${JSON.stringify(SETTINGS_BUTTON)})].find(usable);
      if(direct){direct.click();return 'dialog';}
      return false;
    })()`,
      ),
    budget(),
    'preservation-settings-launcher',
  );
  if (launcher !== 'menu') return;
  // Released Menu primitive portals `[role="menu"]` to document.body only while open; each item is
  // `button[role="menuitem"]` > icon span, label span, optional aria-hidden shortcut span.
  await waitFor(
    () =>
      evalPage(
        page,
        `(function(){
      const labels=new Set(${JSON.stringify(ACCOUNT_MENU_SETTINGS_LABELS)});
      const item=[...document.querySelectorAll('[role="menu"] button[role="menuitem"]')]
        .find(el=>[...el.querySelectorAll(':scope > span')].some(s=>labels.has(s.textContent.trim())));
      if(!item||item.disabled||item.closest('[inert]')||!item.getClientRects().length)return false;
      item.click();return true;
    })()`,
      ),
    budget(),
    'preservation-settings-menu',
  );
};

export const verifyPreservation = async (
  page,
  modelNames,
  ms,
  requests,
  expectedDefault,
  sessionId,
) => {
  const until = Date.now() + ms;
  const budget = () => remainingMs(until, 'preservation');
  const names = modelNames.split(',').map((name) => name.trim());
  if (names.length < 2 || names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('stage=preservation error=distinct-models-required');
  }
  await openSettings(page, budget);
  await waitFor(
    () => evalPage(page, `Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`),
    budget(),
    'preservation-settings',
  );
  await clickExactText(page, `${DIALOG} nav button`, '通用设置');
  await waitFor(
    () =>
      evalPage(
        page,
        `(function(){
    const dialog=document.querySelector(${JSON.stringify(DIALOG)});
    const current=dialog&&[...dialog.querySelectorAll('nav button[aria-current="true"]')]
      .some(el=>el.textContent.trim()==='通用设置');
    const items=dialog&&dialog.querySelector('[data-slot="settings.general.item"]');
    const visible=(el)=>Boolean(el&&el.getClientRects().length);
    const visibleText=(el)=>(el.textContent||'').replace(/\\s+/g,' ').trim();
    const visibleRow=(root,needle)=>Boolean(root&&[...root.querySelectorAll('*')].some((el)=>visible(el)&&visibleText(el).includes(needle)));
    return Boolean(current&&visibleRow(items,'语言')&&visibleRow(items,'当前版本'));
  })()`,
      ),
    budget(),
    'preservation-general-content',
  );
  await clickExactText(page, `${DIALOG} button`, '关闭');
  await waitFor(
    () => evalPage(page, `!document.querySelector(${JSON.stringify(DIALOG)})`),
    budget(),
    'preservation-settings-closed',
  );
  if (sessionId) {
    // Reveal the native selected Session; ungrouped callers may also need their bucket expanded.
    const openSidebar = 'button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]';
    if (await evalPage(page, `Boolean(document.querySelector(${JSON.stringify(openSidebar)}))`))
      await clickSelector(page, openSidebar);
    const bucket = '[data-row-key="workspace:"][aria-expanded="false"]';
    if (await evalPage(page, `Boolean(document.querySelector(${JSON.stringify(bucket)}))`))
      await clickSelector(page, bucket);
    const selector = `[data-row-key="session:${sessionId}"]`;
    await waitFor(
      () => evalPage(page, `Boolean(document.querySelector(${JSON.stringify(selector)}))`),
      budget(),
      'preservation-session-discovery',
    );
    await clickSelector(page, selector);
    await waitFor(
      () =>
        evalPage(
          page,
          `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected')==='true'`,
        ),
      budget(),
      'preservation-session-selected',
    );
    await waitComposer(page, budget());
  }
  await openModelList(page, budget());
  await waitFor(
    async () => {
      const options = await modelOptions(page);
      const listedNames = options.map((row) => row.name);
      return (
        listedNames.length === names.length && names.every((name) => listedNames.includes(name))
      );
    },
    budget(),
    'preservation-exact-models',
  );
  const initial = await modelOptions(page);
  const listed = initial.map((row) => row.name);
  const initiallySelected = initial.filter((row) => row.selected).map((row) => row.name);
  if (
    expectedDefault &&
    (initiallySelected.length !== 1 || initiallySelected[0] !== expectedDefault)
  ) {
    throw new Error('stage=preservation error=initial-default');
  }
  for (const name of names) {
    const chosen = await evalPage(
      page,
      `(function(){
      const el=[...document.querySelectorAll('[role="menu"][aria-label="模型"] button[role="menuitemradio"]')]
        .find(el=>el.title===${JSON.stringify(name)});
      if(!el||el.disabled)return false;el.click();return true;
    })()`,
    );
    if (!chosen) throw new Error('stage=preservation error=model-choice');
    await waitFor(
      () =>
        evalPage(
          page,
          `(function(){
      const trigger=document.querySelector(${JSON.stringify(MODEL_TRIGGER)});
      return Boolean(trigger&&trigger.getAttribute('aria-expanded')==='false'&&trigger.getAttribute('aria-label').includes(${JSON.stringify(name)}));
    })()`,
        ),
      budget(),
      'preservation-selected-model',
    );
    await openModelList(page, budget());
    await waitFor(
      async () => (await modelOptions(page)).some((row) => row.name === name && row.selected),
      budget(),
      'preservation-checked-model',
    );
  }
  if (requests.some((row) => row.method === 'POST' && row.path === '/api/session/prompt')) {
    throw new Error('stage=preservation error=model-send');
  }
  return {
    general: true,
    listed: names,
    selected: names,
    exactModels: listed,
    defaultModel: initiallySelected[0],
    ...(sessionId ? { sessionId } : {}),
    modelSend: false,
  };
};

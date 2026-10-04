/** Ordinary Settings/model UI exercise, only after first-entry + refresh acceptance. */
import { clickSelector, evalPage, remainingMs, waitFor } from './probe-dsh-api-ui.mjs';

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

export const verifyPreservation = async (page, modelNames, ms, requests) => {
  const until = Date.now() + ms;
  const budget = () => remainingMs(until, 'preservation');
  const names = modelNames.split(',').map((name) => name.trim());
  if (names.length !== 2 || names.some((name) => !name) || names[0] === names[1]) {
    throw new Error('stage=preservation error=two-distinct-models-required');
  }
  await clickSelector(page, 'button[aria-label="设置"]');
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
    return Boolean(current&&items&&items.getClientRects().length&&items.textContent.includes('语言')&&items.textContent.includes('当前版本'));
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
  await openModelList(page, budget());
  await waitFor(
    async () => {
      const options = await modelOptions(page);
      return names.every((name) => options.filter((row) => row.name === name).length === 1);
    },
    budget(),
    'preservation-two-models',
  );
  for (const name of names) {
    const selected = await evalPage(
      page,
      `(function(){
      const el=[...document.querySelectorAll('[role="menu"][aria-label="模型"] button[role="menuitemradio"]')]
        .find(el=>el.title===${JSON.stringify(name)});
      if(!el||el.disabled)return false;el.click();return true;
    })()`,
    );
    if (!selected) throw new Error('stage=preservation error=model-choice');
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
  return { general: true, listed: names, selected: names, modelSend: false };
};

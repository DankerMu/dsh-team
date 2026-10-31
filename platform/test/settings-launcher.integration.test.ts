import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  COMPOSITION_PLUGIN,
  waitCompositionInitialized,
} from '../../scripts/probe-first-run-composition.mjs';
import { verifyPreservation } from '../../scripts/probe-first-run-preservation.mjs';

/*
 * DOM fixtures transcribe the released DSH 0.2.1-rc.2 markup (read-only release package):
 * - dsh-client-ui-renderer lib/client.js:1116-1128: every slot outlet is
 *   `<div data-slot="<name>" style="display:contents">`.
 * - dsh-client-ui-settings-general lib/client.js:433-461: `settings.launcher` renders first; its
 *   fallback is `button[aria-label="设置"][aria-haspopup="dialog"]` (zh `trigger` :968).
 * - dsh-client-ui-settings-account lib/client.js:1847-1856: AccountMenu trigger
 *   `button[aria-label="账号菜单"][aria-haspopup="menu"]` (:3018); items :1873-1893 (设置 :3016,
 *   意见反馈 :3017, 登录); the released Menu portals `[role="menu"]` with
 *   `button[role="menuitem"]` > icon span + label span to document.body only while open.
 * - settings-general :275-336: `[role="dialog"][data-shortcut-modal="settings"]`, nav buttons with
 *   `aria-current`, close button with hidden label 关闭 (:989); General rows 语言
 *   (dsh-client-locale :1022) and 当前版本 (:993).
 */
const GENERAL = '@deepseek-ai/dsh-client-ui-settings-general';
const MODEL_SELECTION = '@deepseek-ai/dsh-client-ui-model-selection';
const ACCOUNT = '@deepseek-ai/dsh-client-ui-settings-account';
const ROSTER = [COMPOSITION_PLUGIN, GENERAL, MODEL_SELECTION, ACCOUNT].sort();

const ACCOUNT_LAUNCHER = `<div data-slot="settings.launcher" style="display:contents"><div><span>
  <button type="button" data-collapsed="true" data-signed-out="true" aria-label="账号菜单"
    aria-haspopup="menu" aria-expanded="false"><svg></svg></button></span></div></div>`;
const FALLBACK_LAUNCHER = `<div data-slot="settings.launcher" style="display:contents">
  <button type="button" aria-label="设置" aria-haspopup="dialog" aria-expanded="false"></button>
</div>`;
const ACCOUNT_MENU = `<div role="menu"><div role="presentation">
  <div><button type="button" role="menuitem"><span><svg></svg></span><span>设置</span></button></div>
  <div><button type="button" role="menuitem"><span><svg></svg></span><span>意见反馈</span></button></div>
  <div><button type="button" role="menuitem"><span><svg></svg></span><span>登录</span></button></div>
</div></div>`;
const SETTINGS_DIALOG = `<div role="presentation" data-fixture="settings"><div aria-hidden="true"></div>
  <div tabindex="-1" data-shortcut-modal="settings" role="dialog" aria-modal="true">
    <nav><div>设置</div><div>
      <button type="button" aria-current="true"><svg></svg><span>通用设置</span></button>
    </div></nav>
    <div><div><div></div><button type="button"><svg></svg><span>关闭</span></button></div>
      <div><div data-slot="settings.section" style="display:contents"><div>
        <div data-slot="settings.general.item" style="display:contents">
          <div><span>语言</span><button type="button">简体中文</button></div>
          <div>当前版本：0.2.1-rc.2</div>
        </div>
      </div></div></div>
    </div>
  </div>
</div>`;

const app = (launcher: string): string => `<!doctype html><html lang="zh-CN"><body>
  <aside><button type="button" aria-label="新建会话"></button>${launcher}</aside>
  <main><button type="button" aria-label="选择工作区" aria-expanded="false"><span>work</span></button>
    <div contenteditable="true"></div></main>
</body></html>`;

interface FixtureWindow {
  eval: (code: string) => unknown;
}
// jsdom ships no type declarations here and the root project has no DOM lib: keep the typed
// surface to `window.eval`, and run the fixture's own DOM behaviour inside the jsdom realm.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'outside-only' }) => { window: FixtureWindow };
};

/**
 * Released interaction, reduced to its DOM effect: the menu trigger opens the portal menu, its
 * 设置 item closes it and opens the dialog, the fallback button opens the dialog directly and the
 * dialog's 关闭 button removes it. jsdom has no layout, so every connected element has one box.
 */
const BEHAVIOUR = `(function(){
  Element.prototype.getClientRects=function(){return this.isConnected?[{}]:[];};
  window.__DSH_BOOT__={rev:'r1',entries:${JSON.stringify(ROSTER)}.map((id)=>({id,rev:'r1',url:'/'+id}))};
  window.__opened=[];
  const openDialog=(via)=>{
    window.__opened.push(via);
    document.body.insertAdjacentHTML('beforeend',${JSON.stringify(SETTINGS_DIALOG)});
  };
  document.addEventListener('click',(event)=>{
    const target=event.target;
    const trigger=target.closest('button[aria-haspopup="menu"]');
    if(trigger){
      trigger.setAttribute('aria-expanded','true');
      document.body.insertAdjacentHTML('beforeend',${JSON.stringify(ACCOUNT_MENU)});
      return;
    }
    const item=target.closest('[role="menuitem"]');
    if(item){
      document.querySelector('[role="menu"]').remove();
      document.querySelector('button[aria-haspopup="menu"]').setAttribute('aria-expanded','false');
      if(item.textContent.trim()==='设置')openDialog('account-menu');
      return;
    }
    if(target.closest('button[aria-haspopup="dialog"]')){openDialog('fallback');return;}
    const close=target.closest('[role="dialog"] button');
    if(close&&close.textContent.trim()==='关闭')document.querySelector('[data-fixture="settings"]').remove();
  });
})()`;

interface FixturePage {
  page: { send: (method: string, params: { expression: string }) => Promise<unknown> };
  window: FixtureWindow;
}

/** CDP stand-in: Runtime.evaluate runs in the jsdom window and returns by value. */
function fixturePage(launcher: string): FixturePage {
  const { window } = new JSDOM(app(launcher), { runScripts: 'outside-only' });
  window.eval(BEHAVIOUR);
  const page = {
    send: (method: string, params: { expression: string }): Promise<unknown> => {
      if (method !== 'Runtime.evaluate') return Promise.reject(new Error(`unexpected ${method}`));
      const value = window.eval(params.expression);
      return Promise.resolve({
        result: {
          value: value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown),
        },
      });
    },
  };
  return { page, window };
}

it.each([
  ['the 0.2.1 account-menu launcher', ACCOUNT_LAUNCHER],
  ['the empty-slot fallback settings button', FALLBACK_LAUNCHER],
])('treats composition as rendered with %s', async (_name, launcher) => {
  const { page } = fixturePage(launcher);
  const started = await waitCompositionInitialized(page, 1_000, false, ROSTER);
  expect(started).toMatchObject({ initialized: true, noticeSeen: false });
  expect(started.last).toMatchObject({ editable: true, workspaceSelected: true });
});

it('does not treat composition as rendered without a settings entry', async () => {
  const { page } = fixturePage('');
  const started = await waitCompositionInitialized(page, 600, false, ROSTER);
  expect(started.initialized).toBe(false);
});

it.each([
  ['account-menu', ACCOUNT_LAUNCHER],
  ['fallback', FALLBACK_LAUNCHER],
])('opens and closes Settings through the %s launcher', async (via, launcher) => {
  const { page, window } = fixturePage(launcher);
  // The fixture renders no model selector: reaching it proves the Settings stage completed.
  await expect(verifyPreservation(page, 'alpha,beta', 3_000, [], 'beta')).rejects.toThrow(
    'missing button[aria-label^="选择模型"]',
  );
  expect(window.eval('JSON.stringify(window.__opened)')).toBe(JSON.stringify([via]));
  expect(window.eval('Boolean(document.querySelector(\'[role="dialog"],[role="menu"]\'))')).toBe(
    false,
  );
});

/** First-run UI drive and allowlisted failure diagnostics. */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep } from './probe-dsh-api-cdp.mjs';

export const NEW_BTN = 'button[aria-label="New session"],button[aria-label="新建会话"]';
export const SEND_BTN = 'button[aria-label="Send message"],button[aria-label="发送消息"]';
const STOP_BTN = 'button[aria-label="Stop generating"],button[aria-label="停止生成"]';
export const WORKSPACE_BTN =
  'button[aria-label="Choose workspace"],button[aria-label="选择工作区"]';
const EDIT_PATH = 'input[aria-label="Edit path"],input[aria-label="编辑路径"]';
const EDIT_ZONE = 'button[aria-label="Edit path"],button[aria-label="编辑路径"]';
export const WORKSPACE_PATH = '/data/work';
export const NOTICE_LABELS = ['Continue', '继续'];
const OPEN_LABELS = ['Open', '打开'];
export const ZH_CONTROL_LABELS = ['新建会话', '发送消息', '选择工作区', '探索未至之境'];
export const EN_CONTROL_LABELS = [
  'New session',
  'Send message',
  'Choose workspace',
  'Into the Unknown',
];
export const FIRST_RUN_MARKER = 'dsh-team-first-run';
export const FIRST_RUN_HOST = 'dsh-team-probe.invalid';
const CONTROL_LABELS = {
  'New session': 'new-session',
  新建会话: 'new-session',
  'Send message': 'send',
  发送消息: 'send',
  'Stop generating': 'stop',
  停止生成: 'stop',
  'Choose workspace': 'workspace',
  选择工作区: 'workspace',
  'Edit path': 'edit-path',
  编辑路径: 'edit-path',
  Continue: 'continue',
  继续: 'continue',
  Open: 'open',
  打开: 'open',
};

const out = (line) => process.stdout.write(`${line}\n`);

export const errorCode = (text) => {
  const raw = String(text?.message ?? text ?? 'error');
  const staged = raw.match(/^stage=([a-z0-9-]+) error=([a-z0-9._:-]+)$/i);
  if (staged) return raw;
  if (raw.startsWith('chrome-start ')) return raw;
  if (raw.startsWith('oracle-invalid-')) return raw;
  if (raw.startsWith('timed out waiting for ')) {
    return `wait-timeout:${raw.slice('timed out waiting for '.length).replace(/\s+/g, '-')}`;
  }
  if (/^(http|ws|cdp)-(timeout|error|closed)$/.test(raw)) return raw;
  if (raw.startsWith('missing ')) return 'missing-control';
  if (raw === 'composer missing' || raw === 'missing edit-path') return raw.replace(/\s+/g, '-');
  const match = raw.match(/\b(?:[A-Z][A-Za-z]+Error|HTTP[/_-]?\d{3}|E[A-Z0-9_]+|net::[A-Z_]+)\b/);
  return match?.[0] ?? 'error';
};

export const waitFor = async (fn, ms, label) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const evalJson = async (page, expression) => {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(errorCode(details.exception?.className ?? details.text));
  }
  return result.result?.value;
};

export const clickSelector = async (page, selector) => {
  const ok = await evalJson(
    page,
    `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||el.disabled||el.closest("[inert]"))return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`missing ${selector}`);
};

const clickTextButton = async (page, labels) => {
  const ok = await evalJson(
    page,
    `(function(){
      const labels=new Set(${JSON.stringify(labels)});
      const el=[...document.querySelectorAll("button")].find((node)=>{
        const text=(node.textContent||"").trim();
        return labels.has(text) && !node.disabled && !node.closest("[inert]");
      });
      if(!el)return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`missing ${labels.join('|')}`);
};

const queryPresent = (page, selector) =>
  evalJson(
    page,
    `(function(){return Boolean(document.querySelector(${JSON.stringify(selector)}));})()`,
  );

const queryEnabled = (page, selector) =>
  evalJson(
    page,
    `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      return Boolean(el&&!el.disabled&&!el.closest("[inert]"));
    })()`,
  );

export const remainingMs = (until, label) => {
  const ms = until - Date.now();
  if (ms <= 0) throw new Error(`timed out waiting for ${label}`);
  return ms;
};

const controlSnapshot = (page) =>
  evalJson(
    page,
    `(function(){
      const labels=${JSON.stringify(CONTROL_LABELS)};
      const rows={};
      for (const id of new Set(Object.values(labels))) {
        rows[id]={present:false,disabled:false,inert:false};
      }
      const record=(id,el)=>{
        if(!id||!el)return;
        const next={present:true,disabled:Boolean(el.disabled),inert:Boolean(el.closest("[inert]"))};
        const prev=rows[id];
        if(!prev.present||(!next.inert&&prev.inert)||(!next.disabled&&prev.disabled)) rows[id]=next;
      };
      for (const el of document.querySelectorAll("button,input,[contenteditable]")) {
        record(labels[(el.getAttribute("aria-label")||"").trim()], el);
        record(labels[(el.textContent||"").trim()], el);
      }
      const editor=document.querySelector('[contenteditable="true"]');
      rows.composer={
        present:Boolean(editor),
        disabled:false,
        inert:Boolean(editor&&editor.closest("[inert]")),
      };
      return {phase:document.readyState,controls:rows};
    })()`,
  );

const buttonUsable = (page, labels) =>
  evalJson(
    page,
    `(function(){
      const labels=new Set(${JSON.stringify(labels)});
      return [...document.querySelectorAll("button")].some((el)=>{
        const text=(el.textContent||"").trim();
        return labels.has(text) && !el.disabled && !el.closest("[inert]");
      });
    })()`,
  );

const composerReady = (page) =>
  evalJson(
    page,
    `(function(){
      const el=document.querySelector('[contenteditable="true"]');
      return Boolean(el&&!el.closest('[inert]'));
    })()`,
  );

export const waitComposer = async (page, ms) => {
  const until = Date.now() + ms;
  await waitFor(
    async () => {
      if (await composerReady(page)) return true;
      if (await buttonUsable(page, NOTICE_LABELS)) {
        await clickTextButton(page, NOTICE_LABELS);
      }
      return false;
    },
    remainingMs(until, 'composer'),
    'composer',
  );
};

export const typeComposer = async (page, text) => {
  const focused = await evalJson(
    page,
    `(function(){
      const el=document.querySelector('[contenteditable="true"]');
      if(!el||el.closest('[inert]'))return false;
      el.focus();
      return true;
    })()`,
  );
  if (!focused) throw new Error('composer missing');
  await page.send('Input.insertText', { text });
};

export const clickAllowOnce = async (page, marker) => {
  const script = `(function(){
    const marker=${JSON.stringify(marker)};
    const labels=new Set(["Allow once","允许一次"]);
    for (const root of document.querySelectorAll("[data-approval-key]")) {
      if (!root.innerText.includes(marker)) continue;
      const buttons=[...root.querySelectorAll("button")];
      const allow=buttons.find((el)=>
        labels.has((el.textContent||"").trim()) && !el.disabled && !el.closest("[inert]"));
      if (!allow) return "disabled";
      allow.click();
      return "clicked";
    }
    return "absent";
  })()`;
  return evalJson(page, script);
};

export const waitTurnIdle = (page, ms, label) =>
  waitFor(
    async () => !(await queryPresent(page, STOP_BTN)) && (await queryPresent(page, SEND_BTN)),
    ms,
    label,
  );

export const waitHomepage = (page, ms) =>
  waitFor(() => evalJson(page, 'document.readyState==="complete"'), ms, 'homepage');

const clickIfPresent = async (page, selector) => {
  if (await queryEnabled(page, selector)) {
    await clickSelector(page, selector);
    return true;
  }
  return false;
};

const pickerVisible = async (page) =>
  (await queryEnabled(page, EDIT_PATH)) || (await queryEnabled(page, EDIT_ZONE));

const dismissNotice = async (page, until, required) => {
  if (required) {
    await waitFor(() => buttonUsable(page, NOTICE_LABELS), remainingMs(until, 'notice'), 'notice');
  } else if (!(await buttonUsable(page, NOTICE_LABELS))) {
    return;
  }
  await clickTextButton(page, NOTICE_LABELS);
  await waitFor(
    async () =>
      !(await buttonUsable(page, NOTICE_LABELS)) &&
      ((await composerReady(page)) ||
        (await queryEnabled(page, WORKSPACE_BTN)) ||
        (await pickerVisible(page))),
    remainingMs(until, 'notice-closed'),
    'notice-closed',
  );
};

const enterWorkspacePath = async (page, until) => {
  if (!(await queryPresent(page, EDIT_PATH))) {
    if (!(await clickIfPresent(page, EDIT_ZONE))) throw new Error('missing edit-path');
    await waitFor(
      () => queryPresent(page, EDIT_PATH),
      remainingMs(until, 'edit-path'),
      'edit-path',
    );
  }
  const focused = await evalJson(
    page,
    `(function(){
      const el=document.querySelector(${JSON.stringify(EDIT_PATH)});
      if(!el||el.disabled||el.closest("[inert]"))return false;
      el.focus();
      el.select?.();
      return true;
    })()`,
  );
  if (!focused) throw new Error('missing edit-path');
  await page.send('Input.insertText', { text: WORKSPACE_PATH });
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
  }
};

const openWorkspace = async (page, until) => {
  await waitFor(
    async () => (await composerReady(page)) || (await buttonUsable(page, OPEN_LABELS)),
    remainingMs(until, 'workspace-open'),
    'workspace-open',
  );
  if (await composerReady(page)) return;
  await clickTextButton(page, OPEN_LABELS);
};

export const setupFirstRun = async (page, until) => {
  await dismissNotice(page, until, true);
  while (!(await composerReady(page))) {
    if (await buttonUsable(page, NOTICE_LABELS)) {
      await dismissNotice(page, until, false);
      continue;
    }
    if (await pickerVisible(page)) {
      await enterWorkspacePath(page, until);
      await openWorkspace(page, until);
      await dismissNotice(page, until, false);
      continue;
    }
    if (await queryEnabled(page, WORKSPACE_BTN)) {
      await clickSelector(page, WORKSPACE_BTN);
    }
    await waitFor(
      async () =>
        (await composerReady(page)) ||
        (await buttonUsable(page, NOTICE_LABELS)) ||
        (await pickerVisible(page)),
      remainingMs(until, 'workspace'),
      'workspace',
    );
  }
};

export const reportDiagnostic = async (page, screenshot, current) => {
  if (!page || current.value !== 'homepage') return;
  try {
    const snapshot = await controlSnapshot(page);
    out(`diagnostic ${JSON.stringify({ phase: current.value, controls: snapshot.controls })}`);
  } catch (error) {
    out(`diagnostic error=${errorCode(error)}`);
  }
  try {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(dirname(screenshot), { recursive: true });
    await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
    out(`diagnostic-screenshot ${screenshot} bytes=${(await stat(screenshot)).size}`);
  } catch (error) {
    out(`diagnostic-screenshot error=${errorCode(error)}`);
  }
};

export const evalPage = evalJson;

export const observeFirstRun = (page) =>
  evalJson(
    page,
    `(function(){
      const noticeLabels=new Set(${JSON.stringify(NOTICE_LABELS)});
      const zhLabels=${JSON.stringify(ZH_CONTROL_LABELS)};
      const enLabels=${JSON.stringify(EN_CONTROL_LABELS)};
      const textOf=(el)=>(el.getAttribute("aria-label")||el.textContent||"").replace(/\\s+/g," ").trim();
      const nodes=[...document.querySelectorAll("button,input,[contenteditable],[role='heading'],h1,h2,p,span,div")];
      const visible=(el)=>Boolean(el&&el.getClientRects().length);
      const notice=[...document.querySelectorAll("button")].some((el)=>{
        const text=(el.textContent||"").trim();
        return noticeLabels.has(text) && !el.disabled && !el.closest("[inert]");
      });
      const editor=document.querySelector('[contenteditable="true"]');
      const workspaceChoice=Boolean(
        document.querySelector(${JSON.stringify(WORKSPACE_BTN)}) ||
        document.querySelector(${JSON.stringify(EDIT_PATH)}) ||
        document.querySelector(${JSON.stringify(EDIT_ZONE)})
      );
      const zhVisible=zhLabels.filter((label)=>nodes.some((el)=>visible(el)&&textOf(el).includes(label)));
      const enVisible=enLabels.filter((label)=>nodes.some((el)=>visible(el)&&textOf(el).includes(label)));
      const chromeReady=Boolean(
        document.querySelector(${JSON.stringify(NEW_BTN)}) ||
        document.querySelector(${JSON.stringify(WORKSPACE_BTN)}) ||
        editor ||
        notice
      );
      return {
        hostname:location.hostname,
        languages:[...navigator.languages],
        navigatorLanguage:navigator.language,
        lang:document.documentElement.lang||"",
        notice,
        editable:Boolean(editor&&!editor.closest("[inert]")),
        composerPresent:Boolean(editor),
        workspaceChoice,
        zhVisible,
        enVisible,
        chromeReady,
        readyState:document.readyState
      };
    })()`,
  );

const observationFingerprint = (state) =>
  JSON.stringify({
    hostname: state?.hostname,
    languages: state?.languages,
    lang: state?.lang,
    notice: state?.notice,
    editable: state?.editable,
    workspaceChoice: state?.workspaceChoice,
    zhVisible: state?.zhVisible,
    enVisible: state?.enVisible,
  });

const sameObservation = (left, right) =>
  observationFingerprint(left) === observationFingerprint(right);

export const waitAppReady = async (page, ms) => {
  await waitFor(
    async () => {
      const state = await observeFirstRun(page);
      return state.chromeReady ? state : null;
    },
    ms,
    'app-ready',
  );
};

export const watchFirstRun = async (page, ms) => {
  const until = Date.now() + ms;
  let last = await observeFirstRun(page);
  let noticeSeen = Boolean(last.notice);
  while (Date.now() < until) {
    await sleep(250);
    const next = await observeFirstRun(page);
    if (next.notice) noticeSeen = true;
    last = next;
  }
  return { last, noticeSeen };
};

export const settleFirstRun = async (page, ms) => {
  await evalJson(page, 'document.fonts.ready.then(()=>true)');
  const until = Date.now() + ms;
  let previous = await observeFirstRun(page);
  let noticeSeen = Boolean(previous.notice);
  while (Date.now() < until) {
    await sleep(400);
    const next = await observeFirstRun(page);
    if (next.notice) noticeSeen = true;
    if (sameObservation(previous, next)) {
      return { last: next, noticeSeen };
    }
    previous = next;
  }
  return { last: previous, noticeSeen };
};

export const captureSettledScreenshot = async (page, screenshot) => {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
  return { screenshot, bytes: (await stat(screenshot)).size };
};

export const composerText = (page) =>
  evalJson(
    page,
    `(function(){
      const el=document.querySelector('[contenteditable="true"]');
      return el?(el.innerText||el.textContent||""):"";
    })()`,
  );

export const clearComposer = async (page) => {
  const focused = await evalJson(
    page,
    `(function(){
      const el=document.querySelector('[contenteditable="true"]');
      if(!el||el.closest("[inert]"))return false;
      el.focus();
      const range=document.createRange();
      range.selectNodeContents(el);
      const sel=window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`,
  );
  if (!focused) throw new Error('composer missing');
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  });
};

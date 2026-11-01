import assert from 'node:assert/strict';
import { captureSettledScreenshot, clickSelector, waitFor } from './probe-dsh-api-ui.mjs';

// Independent expected values: approved OpenSpec design13 table, not gate source.
export const EXPECTED = Object.freeze([
  { id: 'approval', label: '人工批准', sandbox: 'danger-full-access', approval: 'ask' },
  { id: 'auto-review', label: 'Auto', sandbox: 'danger-full-access', approval: 'ask' },
  { id: 'danger-full-access', label: 'Yolo', sandbox: 'danger-full-access', approval: 'never' },
]);
const MS = 30000;
const PERMISSION_BUTTON =
  'button[aria-label^="访问模式，当前："],button[aria-label^="Access mode, current:"]';
export const PANEL = '[data-approval-key]';
async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('oracle-browser-evaluation-failed');
  return result.result?.value;
}
async function physicalClick(page, query) {
  const point = await evaluate(
    page,
    `(() => { const el=(${query}); if(!el||el.disabled||el.closest('[inert]'))return null; const r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0)return null; el.scrollIntoView({block:'center'}); const q=el.getBoundingClientRect(); return {x:q.x+q.width/2,y:q.y+q.height/2}; })()`,
  );
  assert(point, 'oracle-visible-click-target-missing');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point,
  });
}
function exactTextQuery(text, selector = 'button,[role="button"],a,[role="menuitem"]') {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => (el.textContent||'').trim()===${JSON.stringify(text)} && el.getBoundingClientRect().width>0)`;
}
async function chosenLabel(page) {
  return evaluate(
    page,
    `document.querySelector(${JSON.stringify(PERMISSION_BUTTON)})?.textContent.trim() ?? null`,
  );
}
async function selectTier(page, label, shot, report) {
  await clickSelector(page, PERMISSION_BUTTON);
  const menu = await waitFor(
    () =>
      evaluate(
        page,
        `(() => { const labels=[...document.querySelectorAll('[role="menuitem"],[role="option"]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.textContent.trim()); return labels.length?labels:null; })()`,
      ),
    MS,
    'permission-options',
  );
  assert.deepEqual(
    [...menu].sort(),
    EXPECTED.map((row) => row.label).sort(),
    'composer must expose exactly approved three choices',
  );
  await physicalClick(page, exactTextQuery(label, '[role="menuitem"],[role="option"]'));
  if (label === 'Yolo') {
    await waitFor(
      () => evaluate(page, `Boolean(document.querySelector('[role="dialog"]'))`),
      MS,
      'risk-dialog',
    );
    await physicalClick(
      page,
      `document.querySelector('[role="dialog"] input[type="checkbox"],[role="dialog"] [role="checkbox"]')`,
    );
    await physicalClick(
      page,
      `[...document.querySelectorAll('[role="dialog"] button')].find(el=>['启用完全权限','Enable Full access'].includes(el.textContent.trim())&&!el.disabled)`,
    );
  }
  await waitFor(async () => (await chosenLabel(page)) === label, MS, 'permission-selected');
  await captureSettledScreenshot(page, shot);
  report.selections.push({ label, screenshot: shot, menu });
}
async function clickSessionTitle(page, title, evidence, expectedAddress) {
  const query =
    expectedAddress.kind === 'session'
      ? `document.querySelector(${JSON.stringify(`[data-row-key="session:${expectedAddress.sessionId}"]`)})`
      : `[...document.querySelectorAll('[role="treeitem"][aria-label]')].find(el=>el.getAttribute('aria-label').startsWith(${JSON.stringify(title + ' ')}))`;
  if (expectedAddress.kind === 'session') {
    // cwd-only RPC sessions belong to the native ungrouped bucket, collapsed by default.
    const ungrouped = `document.querySelector('[data-row-key="workspace:"][aria-expanded="false"]')`;
    if (await evaluate(page, `Boolean(${ungrouped})`)) await physicalClick(page, ungrouped);
  }
  await waitFor(() => evaluate(page, `Boolean(${query})`), MS, 'session-discovery');
  await physicalClick(page, query);
  await waitFor(
    () =>
      evaluate(
        page,
        expectedAddress.kind === 'session'
          ? `(${query})?.getAttribute('aria-selected')==='true'`
          : `Boolean([...document.querySelectorAll('button[aria-haspopup="tree"]')].find(el=>['切换子智能体：'+${JSON.stringify(title)},'Switch subagent: '+${JSON.stringify(title)}].includes(el.getAttribute('aria-label'))))`,
      ),
    MS,
    'native-selected-session-surface',
  );
  if (expectedAddress.kind === 'session') {
    // The next session switch or reload must not retire a sidebar session view whose reference is
    // still opening: the released client logs that release as a console error. Chat turns render
    // only after the session open completed.
    await waitFor(
      () =>
        evaluate(
          page,
          `Boolean(document.querySelector(${JSON.stringify(`[data-conversation-session="${expectedAddress.sessionId}"] [data-chat-flow] [data-chat-turn]`)}))`,
        ),
      MS,
      'session-open-completed',
    );
  }
  await waitFor(
    () =>
      evidence.addresses.some(
        (address) =>
          address.kind === expectedAddress.kind &&
          (address.kind === 'session'
            ? address.sessionId === expectedAddress.sessionId
            : address.childSessionId === expectedAddress.childSessionId &&
              address.parentSessionId === expectedAddress.parentSessionId),
      ),
    MS,
    'actual-session-transport-address',
  );
  evidence.selectedAddress = expectedAddress;
}

export { evaluate, physicalClick, chosenLabel, selectTier, clickSessionTitle };

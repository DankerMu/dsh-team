import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectComposition, execScript, qualifyHostSession } from './managed-policy-fixture.ts';
import { runWebStartup, execWebScript } from './web-startup-fixture.ts';
import { generateManagedConfig, writeManagedConfig } from '../src/managed-config/index.ts';
import {
  mappedFlags,
  mappedRpc,
  navigateReady,
  openMappedPage,
} from '../../scripts/probe-mapped-host.mjs';
import {
  captureSettledScreenshot,
  clickSelector,
  SEND_BTN,
  typeComposer,
  waitComposer,
  waitFor,
} from '../../scripts/probe-dsh-api-ui.mjs';

// Independent expected values: approved OpenSpec design13 table, NOT gate source.
const EXPECTED = Object.freeze([
  { id: 'approval', label: '人工批准', sandbox: 'danger-full-access', approval: 'ask' },
  { id: 'auto-review', label: 'Auto', sandbox: 'danger-full-access', approval: 'ask' },
  { id: 'danger-full-access', label: 'Yolo', sandbox: 'danger-full-access', approval: 'never' },
]);
const PLUGIN = '/opt/dsh-team/permission-tiers/index.js';
const TEXT = 'issue83 browser owned write\n审批必须先于真实工具写入。\n';
const BASE64 = Buffer.from(TEXT).toString('base64');
const HOST = 'dsh-team-managed.invalid'; // qualifyHostSession's actual mapped host contract
const MS = 30000;
const PERMISSION_BUTTON =
  'button[aria-label^="访问模式，当前："],button[aria-label^="Access mode, current:"]';
const PANEL = '[data-approval-key]';

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
function addresses(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.kind === 'session' && typeof value.sessionId === 'string')
    found.push({ kind: value.kind, sessionId: value.sessionId });
  if (value.kind === 'subagent' && typeof value.childSessionId === 'string')
    found.push({
      kind: value.kind,
      childSessionId: value.childSessionId,
      parentSessionId: value.parentSessionId,
      mode: value.mode,
    });
  for (const child of Object.values(value))
    if (child && typeof child === 'object') addresses(child, found);
  return found;
}
function attachScopeObserver(page, evidence) {
  const consume = (raw) => {
    try {
      const value = JSON.parse(raw);
      evidence.addresses.push(...addresses(value));
    } catch {
      /* Non-JSON transport has no address proof. */
    }
  };
  page.on('Network.webSocketFrameSent', (event) => consume(event.response?.payloadData ?? ''));
  // HTTP addresses are parsed in memory; headers/cookies/tokens never enter evidence.
  page.on('Network.requestWillBeSent', (event) => {
    if (event.request?.postData) consume(event.request.postData);
  });
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
function auditFor(status, call) {
  const asked = status.audit.filter(
    (event) =>
      event.sessionId === call.sessionId &&
      event.type === 'approval/asked' &&
      event.data.callId === call.callId,
  );
  assert.equal(asked.length, 1, 'exactly one native approval audit request');
  const decided = status.audit.filter(
    (event) =>
      event.sessionId === call.sessionId &&
      event.type === 'approval/decided' &&
      event.data.id === asked[0].data.id,
  );
  assert.equal(decided.length, 1, 'matching native approval decision');
  const requests = status.approvals.filter((row) => row.callId === call.callId);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, call.sessionId);
  assert.equal(requests[0].agentId, call.sessionId);
  assert.equal(requests[0].exactRegisteredAgent, true);
  assert(asked[0].seq < decided[0].seq, 'native audit order');
  const start = status.audit
    .filter(
      (event) =>
        event.sessionId === call.sessionId &&
        event.type === 'turn/start' &&
        event.seq < asked[0].seq,
    )
    .at(-1);
  assert(start, 'approval must belong to an actual loop-owned turn');
  assert(
    !status.audit.some(
      (event) =>
        event.sessionId === call.sessionId &&
        event.type === 'turn/end' &&
        event.seq > start.seq &&
        event.seq < decided[0].seq,
    ),
    'approval audit pair cannot escape its open turn',
  );
  return { asked: asked[0], decided: decided[0], request: requests[0] };
}

async function selectChild(context, call, action, nonce, label) {
  const { browser, control, roots, report, evidenceDirectory } = context;
  const facts = control({ op: 'status' });
  const child = facts.children.find((row) => row.sessionId === call.sessionId);
  assert(child, 'real native child must have been observed');
  assert.equal(child.origin, 'subagent');
  assert.equal(child.parentSessionId, roots[0].sessionId);
  assert.equal(child.tier, 'approval');
  assert.equal(child.policy, 'ask');
  assert.notEqual(call.sessionId, roots[0].sessionId);
  const delegation = facts.delegations.find((row) => row.sessionId === call.sessionId);
  assert.equal(delegation?.provider, 'spawn');
  assert.equal(delegation?.local, true, 'released in-process provider, not a fabricated child');
  const parentCall = facts.calls.find((row) => row.nonce === nonce && row.name === 'subagent');
  assert.equal(parentCall?.sessionId, roots[0].sessionId);
  assert.equal(
    facts.dispatch.filter((row) => row.callId === parentCall.callId && row.name === 'subagent')
      .length,
    1,
    'real registered delegation body must run',
  );
  assert.equal(
    facts.sessions.find((row) => row.sessionId === roots[0].sessionId).status,
    'running',
    'parent must be waiting on the real delegated call',
  );
  // The parent's composer is NOT the child's approval surface.
  assert.equal(
    await evaluate(browser.page, `document.querySelectorAll(${JSON.stringify(PANEL)}).length`),
    0,
    'child prompt may not impersonate a parent approval',
  );
  await captureSettledScreenshot(
    browser.page,
    join(evidenceDirectory, `${label}-parent-waiting.png`),
  );
  const catalogQuery = `[...document.querySelectorAll('button[aria-haspopup="tree"]')].find(el=>/子智能体|subagents?/.test(el.getAttribute('aria-label')||'')&&!/切换|Switch/.test(el.getAttribute('aria-label')||''))`;
  await waitFor(
    () => evaluate(browser.page, `Boolean(${catalogQuery})`),
    MS,
    'native-child-catalog-trigger',
  );
  await physicalClick(browser.page, catalogQuery);
  await clickSessionTitle(browser.page, `issue83 child ${action} ${nonce}`, report, {
    kind: 'subagent',
    childSessionId: call.sessionId,
    parentSessionId: roots[0].sessionId,
  });
}

async function runApprovalScenario(context, scope, action) {
  const { browser, control, rpc, roots, report, evidenceDirectory, persist } = context;
  const nonce = randomUUID();
  const label = `${scope}-${action}`;
  if (scope === 'delegate' || action !== 'reject')
    await clickSessionTitle(browser.page, roots[0].title, report, {
      kind: 'session',
      sessionId: roots[0].sessionId,
    });
  await waitComposer(browser.page, MS);
  await typeComposer(browser.page, `issue83-ui ${scope} ${action} ${nonce}`);
  await clickSelector(browser.page, SEND_BTN);
  const call = await waitFor(
    () =>
      control({ op: 'status' }).calls.find((call) => call.nonce === nonce && call.name === 'write'),
    MS,
    `${label}-real-write-call`,
  );
  if (scope === 'delegate') await selectChild(context, call, action, nonce, label);
  const { panelKey, pendingShot } = await observePendingApproval(context, call, label);
  if (action === 'cancel') {
    // Foreground native child is owned by the parent's tool-call signal.
    // Cancelling that parent propagates to the actual child; never claim a
    // continuable interrupt can cancel a one-shot foreground child.
    await rpc('session/cancel', { request: { sessionId: roots[0].sessionId } });
  } else
    await physicalClick(
      browser.page,
      `[...document.querySelectorAll(${JSON.stringify(PANEL + ' button')})].find(el=>${JSON.stringify(action === 'allow' ? ['允许一次', 'Allow once'] : ['拒绝', 'Reject'])}.includes(el.textContent.trim())&&!el.disabled)`,
    );
  await waitFor(
    () =>
      evaluate(
        browser.page,
        `![...document.querySelectorAll(${JSON.stringify(PANEL)})].some(el=>el.getAttribute('data-approval-key')===${JSON.stringify(panelKey)})`,
      ),
    MS,
    `${label}-panel-withdrawn`,
  );
  const final = await waitFor(
    () => {
      const facts = control({ op: 'status' });
      const asked = facts.audit.find(
        (event) => event.type === 'approval/asked' && event.data.callId === call.callId,
      );
      return asked &&
        facts.audit.some(
          (event) =>
            event.sessionId === call.sessionId &&
            event.type === 'approval/decided' &&
            event.data.id === asked.data.id,
        ) &&
        facts.results.some((row) => row.callId === call.callId)
        ? facts
        : null;
    },
    MS,
    `${label}-native-settlement`,
  );
  const audit = auditFor(final, call);
  assert.equal(
    audit.decided.data.outcome,
    action === 'allow' ? 'allowed-once' : action === 'reject' ? 'rejected' : 'cancelled',
  );
  const file = final.files.find((row) => row.callId === call.callId);
  const dispatch = final.dispatch.filter((row) => row.callId === call.callId);
  if (action === 'allow') {
    assert.equal(file.base64, BASE64);
    assert.equal(file.bytes, Buffer.byteLength(TEXT));
    assert.equal(dispatch.length, 1);
    assert.equal(final.results.find((row) => row.callId === call.callId).isError, false);
  } else {
    assert.equal(file.exists, false);
    assert.equal(dispatch.length, 0);
  }
  await waitFor(
    () =>
      control({ op: 'status' }).sessions.find((row) => row.sessionId === roots[0].sessionId)
        ?.status === 'idle',
    MS,
    `${label}-real-parent-turn-idle`,
  );
  const doneShot = join(evidenceDirectory, `${label}-settled.png`);
  await captureSettledScreenshot(browser.page, doneShot);
  report.scenarios.push({
    scope,
    action,
    call,
    audit,
    file,
    dispatch,
    panelKey,
    panelDisappeared: true,
    pendingScreenshot: pendingShot,
    settledScreenshot: doneShot,
  });
  report.latestFacts = final;
  await persist();
}

async function persistFailure(error, browser, web, control, report, evidenceDirectory, persist) {
  // Fixed classifications only: raw exceptions may contain transport credentials.
  report.status = 'FAIL';
  report.failure =
    error instanceof assert.AssertionError
      ? 'assertion-failed'
      : 'permission-browser-scenario-failed';
  if (browser) {
    report.consoleErrors = [...browser.errors];
    try {
      await captureSettledScreenshot(browser.page, join(evidenceDirectory, 'failure.png'));
    } catch {
      report.failureScreenshotUnavailable = true;
    }
  }
  if (web) {
    try {
      report.latestFacts = control({ op: 'status' });
    } catch {
      report.controlUnavailable = true;
    }
  }
  await persist();
}

/** Canonical lifecycle owns image, volumes, containers and mapped port. */
export async function runPermissionBrowserScenario(lifecycle, { chromeBin, evidenceDirectory }) {
  assert(chromeBin, 'CHROME_BIN is required');
  await mkdir(evidenceDirectory, { recursive: true });
  const report = {
    status: 'RUNNING',
    runId: lifecycle.runId,
    imageId: lifecycle.imageId,
    source: 'owned-protocol-not-real-model',
    selections: [],
    scenarios: [],
    addresses: [],
    consoleErrors: [],
    screenshots: [],
  };
  let browser, profile;
  const persist = () =>
    writeFile(join(evidenceDirectory, 'evidence.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  const command = (args, timeout = 30000) => {
    const result = lifecycle.command(args, timeout);
    assert.equal(result.status, 0, 'oracle-owned-docker-command-failed');
    assert(!result.error, 'oracle-owned-docker-error');
    return String(result.stdout ?? '');
  };
  const name = `dsh-team-test-${lifecycle.runId}-ui-oracle`;
  let web;
  const control = (request) => {
    const raw = execWebScript(
      lifecycle.command,
      web,
      `const response=await fetch('http://127.0.0.1:3081/control',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(request))},signal:AbortSignal.timeout(10000)}); if(!response.ok)throw new Error('owned-control-http'); const text=await response.text(); if(text.length>60000)throw new Error('owned-control-limit'); process.stdout.write(text);`,
    );
    return JSON.parse(raw);
  };
  try {
    web = await prepareWeb(lifecycle, name, report);
    lifecycle.registerContainer(name);
    const startup = JSON.parse(await runWebStartup(lifecycle.command, web));
    report.startup = startup;
    const { origin, cookie } = await qualifyHostSession(startup.hostPort, command(['logs', name]));
    const rpc = async (method, args) => {
      const result = await mappedRpc(origin, cookie, method, args);
      assert.equal(result.ok, true, `oracle-rpc-${method.replaceAll('/', '-')}`);
      return result.value;
    };
    profile = await mkdtemp(join(tmpdir(), 'issue83-ui-chrome-'));
    browser = await openMappedPage({
      origin,
      cookie,
      extraFlags: mappedFlags(HOST),
      composition: true,
      chromeBin,
      profile,
      pidFile: join(profile, 'chrome.pid'),
    });
    attachScopeObserver(browser.page, report);
    await browser.page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigateReady(browser.page, origin, MS);
    await waitComposer(browser.page, MS);
    report.baselineConsoleErrors = [...browser.errors];
    // Track from startup too: an initial error cannot be washed away by baselining it.
    assert.equal(browser.errors.length, 0, 'console error during owned startup');
    const roots = await verifySessionSelections(
      browser,
      control,
      rpc,
      origin,
      report,
      evidenceDirectory,
    );
    const context = { browser, control, rpc, roots, report, evidenceDirectory, persist };
    for (const scope of ['root', 'delegate'])
      for (const action of ['reject', 'allow', 'cancel'])
        await runApprovalScenario(context, scope, action);
    assert.equal(browser.errors.length, 0, 'zero new console errors');
    report.consoleErrors = [...browser.errors];
    report.status = 'PASS';
    report.limits = [
      'No real model calls; #84/#85 remain unproven.',
      'Auto selected only; review behavior belongs to production Docker protocol tests.',
      'No administrator-default restart/resume/PTC/unload coverage in this browser oracle.',
    ];
    await persist();
    return JSON.stringify({
      status: report.status,
      runId: lifecycle.runId,
      scenarios: report.scenarios.length,
      evidence: join(evidenceDirectory, 'evidence.json'),
    });
  } catch (error) {
    await persistFailure(error, browser, web, control, report, evidenceDirectory, persist);
    throw new Error('ui-oracle-failed-see-evidence', { cause: error });
  } finally {
    try {
      if (browser) {
        try {
          browser.page.close();
        } finally {
          await browser.chrome.stop();
        }
      }
    } finally {
      if (profile) await rm(profile, { recursive: true, force: true });
    }
  }
}

async function prepareWeb(lifecycle, name, report) {
  const providerSource = await readFile(
    new URL('./permission-browser-provider.mjs', import.meta.url),
    'utf8',
  );
  report.providerSha256 = createHash('sha256').update(providerSource).digest('hex');
  execScript(
    lifecycle,
    `${name}-install`,
    `import {writeFileSync,readFileSync,statSync} from 'node:fs'; import {createRequire} from 'node:module'; const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'); const versions=Object.fromEntries(['dsh','dsh-agent','dsh-llm','dsh-session','dsh-user-approval','dsh-subagent'].map(name=>[name,JSON.parse(readFileSync(require.resolve('@deepseek-ai/'+name+'/package.json'),'utf8')).version])); for(const version of Object.values(versions))if(version!=='0.2.0-rc.2')throw new Error('Pinned release mismatch'); const paths=['/opt','/opt/dsh-team','/opt/dsh-team/permission-tiers',${JSON.stringify(PLUGIN)}]; for(const path of paths){const stat=statSync(path);if(stat.uid!==0||(stat.mode&0o022)!==0)throw new Error('Immutable plugin ownership mismatch');} writeFileSync('/data/home/issue83-ui-owned-protocol.mjs',${JSON.stringify(providerSource)},{mode:0o400}); process.stdout.write(JSON.stringify({versions,pluginPath:${JSON.stringify(PLUGIN)},rootOwned:true}));`,
  );
  const composition = await collectComposition(lifecycle, `${name}-composition`);
  const generated = generateManagedConfig({
    ...composition,
    defaultPermissionTier: 'approval',
    modelSettings: {
      baseURL: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'ISSUE83_UI_NONSECRET',
      apiKeyConfigured: true,
      models: [{ name: 'owned', contextWindow: 500000 }],
      defaultModel: 'owned',
    },
  });
  assert.equal(generated.outcome, 'configured');
  const rows = JSON.parse(generated.content);
  assert(
    rows.some((row) =>
      row.insert?.some((plugin) => plugin.id === 'managed-permissions' && plugin.name === PLUGIN),
    ),
    'canonical production plugin row missing',
  );
  assert(
    rows.some((row) => row.id === 'agent-loop' && row.inject?.includes('managedPermissions')),
    'required production service missing',
  );
  // ONLY the model boundary is replaced by a registered owned adapter; gate rows untouched.
  rows.push(
    { id: 'llm-pi-ai', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'otel', disabled: true },
    { id: 'agent-default-model', config: { provider: 'issue83-ui-owned', model: 'owned' } },
    {
      insert: [
        { id: 'issue83-ui-owned-protocol', name: '/data/home/issue83-ui-owned-protocol.mjs' },
      ],
    },
  );
  const overlay = await writeManagedConfig(
    lifecycle.overlayDirectory,
    'uioracle0001',
    JSON.stringify(rows),
  );
  return {
    container: name,
    imageId: lifecycle.imageId,
    runId: lifecycle.runId,
    stateVolume: lifecycle.stateVolume,
    workVolume: lifecycle.workVolume,
    overlay,
    seccomp: lifecycle.seccomp,
    trustedHost: HOST,
    env: { ISSUE83_UI_NONSECRET: 'owned-not-secret', DSH_TELEMETRY_DISABLED: '1' },
  };
}

async function verifySessionSelections(browser, control, rpc, origin, report, evidenceDirectory) {
  const status = control({ op: 'status' });
  assert.equal(status.managedPermissionsPresent, true);
  assert.equal(status.catalog.defaultPreset, 'approval');
  assert.deepEqual(
    status.catalog.options
      .map((row) => ({ id: row.value, label: row.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    EXPECTED.map((row) => ({ id: row.id, label: row.label })).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  );
  const roots = [];
  for (let index = 0; index < 2; index++) {
    const { sessionId } = await rpc('session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    const title = `issue83 browser root ${index + 1}`;
    await rpc('session/rename', { request: { sessionId, title } });
    control({ op: 'adopt', sessionId });
    roots.push({ sessionId, title });
    await waitFor(
      () =>
        control({ op: 'status' }).sessions.find((row) => row.sessionId === sessionId)?.status ===
        'idle',
      MS,
      'owned-initialization-turn',
    );
    await navigateReady(browser.page, origin, MS, true);
    report.selectedAddress = null;
    await waitComposer(browser.page, MS);
    await clickSessionTitle(browser.page, title, report, { kind: 'session', sessionId });
    await selectTier(
      browser.page,
      index === 0 ? '人工批准' : 'Yolo',
      join(evidenceDirectory, `session-${index + 1}-selected.png`),
      report,
    );
  }
  await navigateReady(browser.page, origin, MS, true);
  await waitComposer(browser.page, MS);
  await clickSessionTitle(browser.page, roots[0].title, report, {
    kind: 'session',
    sessionId: roots[0].sessionId,
  });
  assert.equal(await chosenLabel(browser.page), '人工批准');
  for (const label of ['Auto', 'Yolo', '人工批准'])
    await selectTier(
      browser.page,
      label,
      join(
        evidenceDirectory,
        `composer-${label === '人工批准' ? 'approval' : label.toLowerCase()}.png`,
      ),
      report,
    );
  await clickSessionTitle(browser.page, roots[1].title, report, {
    kind: 'session',
    sessionId: roots[1].sessionId,
  });
  assert.equal(await chosenLabel(browser.page), 'Yolo');
  await clickSessionTitle(browser.page, roots[0].title, report, {
    kind: 'session',
    sessionId: roots[0].sessionId,
  });
  assert.equal(await chosenLabel(browser.page), '人工批准');
  report.twoSessionIndependence = {
    first: roots[0],
    firstTier: 'approval',
    second: roots[1],
    secondTier: 'danger-full-access',
    reopened: true,
  };
  const independent = control({ op: 'status' }).sessions;
  assert.equal(
    independent.find((row) => row.sessionId === roots[0].sessionId).identity?.preset,
    'approval',
  );
  assert.equal(independent.find((row) => row.sessionId === roots[0].sessionId).policy, 'ask');
  assert.equal(
    independent.find((row) => row.sessionId === roots[1].sessionId).identity?.preset,
    'danger-full-access',
  );
  assert.equal(independent.find((row) => row.sessionId === roots[1].sessionId).policy, 'never');
  return roots;
}

async function observePendingApproval(context, call, label) {
  const { browser, control, evidenceDirectory } = context;
  const panelKey = await waitFor(
    () =>
      evaluate(
        browser.page,
        `document.querySelector(${JSON.stringify(PANEL)})?.getAttribute('data-approval-key')`,
      ),
    MS,
    `${label}-native-approval-panel`,
  );
  assert.equal(
    await evaluate(browser.page, `document.querySelectorAll(${JSON.stringify(PANEL)}).length`),
    1,
    'one native pending approval in the selected Session',
  );
  // Released ApprovalPanel's Tool-owned detail slot is optional. The write
  // target is rendered in the actual tool timeline, not inside that panel.
  assert.equal(
    await evaluate(
      browser.page,
      `document.body.innerText.includes(${JSON.stringify(call.path.split('/').at(-1))})`,
    ),
    true,
    'native tool timeline must identify this exact pending write',
  );
  const pending = control({ op: 'status' });
  assert.equal(
    pending.files.find((file) => file.callId === call.callId)?.exists,
    false,
    'real body must not run before browser approval',
  );
  assert.equal(pending.dispatch.filter((row) => row.callId === call.callId).length, 0);
  assert.equal(
    pending.audit.filter(
      (event) =>
        event.sessionId === call.sessionId &&
        event.type === 'approval/asked' &&
        event.data.callId === call.callId,
    ).length,
    1,
  );
  const pendingShot = join(evidenceDirectory, `${label}-pending.png`);
  await captureSettledScreenshot(browser.page, pendingShot);
  return { panelKey, pendingShot };
}

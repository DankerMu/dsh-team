import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectComposition, execScript, qualifyHostSession } from './managed-policy-fixture.ts';
import { runWebStartup, execWebScript, WEB_CONTAINER_ADDRESS } from './web-startup-fixture.ts';
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
import { attachScopeObserver } from '../../scripts/probe-session-address.mjs';
import {
  disposeRequestEvidence,
  retainPageRequestFailure,
} from '../../scripts/probe-browser-evidence.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';
import {
  EXPECTED,
  PANEL,
  evaluate,
  physicalClick,
  chosenLabel,
  selectTier,
  clickSessionTitle,
} from '../../scripts/probe-permission-ui.mjs';

const PLUGIN = '/opt/dsh-team/permission-tiers/index.js';
const TEXT = 'issue83 browser owned write\n审批必须先于真实工具写入。\n';
const BASE64 = Buffer.from(TEXT).toString('base64');
const HOST = 'dsh-team-managed.invalid'; // qualifyHostSession's actual mapped host contract
const MS = 30000;
const CHILD_PANEL = '[data-approval-key][aria-label="子任务审批"]';
const PARENT_ASKED = 'a continuable child approval may not surface in its parent';

const waitStatus = (control, ready, label) =>
  waitFor(
    () => {
      const facts = control({ op: 'status' });
      return ready(facts) ? facts : null;
    },
    MS,
    label,
  );

function auditFor(status, call, continuable = false) {
  // Continuable: the one question for this call exists in no other Session.
  const asked = status.audit.filter(
    (event) =>
      (continuable || event.sessionId === call.sessionId) &&
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

async function openChild(context, call, title) {
  const { browser, roots, report } = context;
  const catalogQuery = `[...document.querySelectorAll('button[aria-haspopup="tree"]')].find(el=>/子智能体|subagents?/.test(el.getAttribute('aria-label')||'')&&!/切换|Switch/.test(el.getAttribute('aria-label')||''))`;
  await waitFor(
    () => evaluate(browser.page, `Boolean(${catalogQuery})`),
    MS,
    'native-child-catalog-trigger',
  );
  await physicalClick(browser.page, catalogQuery);
  await clickSessionTitle(browser.page, title, report, {
    kind: 'subagent',
    childSessionId: call.sessionId,
    parentSessionId: roots[0].sessionId,
  });
}

const rootStatus = (facts, root) => facts.sessions.find((row) => row.sessionId === root.sessionId);
const openRoot = ({ browser, roots, report }) =>
  clickSessionTitle(browser.page, roots[0].title, report, {
    kind: 'session',
    sessionId: roots[0].sessionId,
  });
const waitRootIdle = ({ control, roots }, label) =>
  waitStatus(control, (facts) => rootStatus(facts, roots[0])?.status === 'idle', label);

/** A composer choice is optimistic; wait for the host-committed root preset and policy. */
async function commitRootTier(context, label, step) {
  const { id, approval } = EXPECTED.find((row) => row.label === label);
  const committed = (facts) => {
    const row = rootStatus(facts, context.roots[0]);
    return row?.tier === id && row?.identity?.preset === id && row?.policy === approval;
  };
  const facts = await waitStatus(context.control, committed, `${step}-root-tier-committed`);
  assert(committed(facts), 'root tier committed before the follow-up');
}

async function selectChild(context, call, action, nonce, label, expected = {}) {
  const { browser, control, roots, report, evidenceDirectory, suite, continuable } = context;
  const facts = control({ op: 'status' });
  const child = facts.children.find((row) => row.sessionId === call.sessionId);
  assert(child, 'real native child must have been observed');
  // Recorded at agent/created: a one-shot delegation fails here, not on a later wait.
  if (continuable) {
    assert.equal(child.mode, 'continuable', 'native descriptor must declare a continuable child');
    assert.equal(child.source, 'startup');
  }
  assert.equal(child.origin, 'subagent');
  assert.equal(child.parentSessionId, roots[0].sessionId);
  assert.equal(child.tier, expected.tier ?? 'approval');
  assert.equal(child.policy, expected.policy ?? 'ask');
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
  if (!continuable)
    assert.equal(
      rootStatus(facts, roots[0]).status,
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
  await openChild(context, call, `${suite.title} child ${action} ${nonce}`);
  if (!continuable) return;
  const modes = report.addresses
    .filter((row) => row.kind === 'subagent' && row.childSessionId === call.sessionId)
    .map((row) => row.mode);
  assert(modes.length && modes.every((mode) => mode === 'continuable'), 'continuable address');
  // The background call result can trail agent/created; wait rather than assert.
  await waitStatus(
    control,
    (facts) =>
      facts.results.some(
        (row) =>
          row.callId === parentCall.callId &&
          row.kind === 'continuable' &&
          row.subagentId === call.sessionId,
      ),
    `${label}-continuable-delegation-result`,
  );
  const idle = await waitRootIdle(context, `${label}-parent-idle`);
  assertNeverAsked(idle, roots[0].sessionId, PARENT_ASKED);
}

/** No approval request or native question ever reached this Session. */
function assertNeverAsked(facts, sessionId, message) {
  assert(
    !facts.approvals.some((row) => row.sessionId === sessionId) &&
      !facts.audit.some(
        (event) => event.sessionId === sessionId && event.type === 'approval/asked',
      ),
    message,
  );
}

async function sendTurn(context, text, nonce, label) {
  const { browser, control, suite } = context;
  await typeComposer(browser.page, `${suite.prompt} ${text}`);
  await clickSelector(browser.page, SEND_BTN);
  return waitFor(
    () =>
      control({ op: 'status' }).calls.find((call) => call.nonce === nonce && call.name === 'write'),
    MS,
    `${label}-real-write-call`,
  );
}

async function answerApproval(context, call, action, label) {
  const { browser, control, rpc, roots, continuable } = context;
  const { panelKey, pendingShot } = await observePendingApproval(context, call, label);
  if (action === 'cancel' && continuable)
    // The child's own Stop remote (exact gateway argument names): a parent
    // session/cancel never reaches a continuable child's own turn.
    await rpc('subagents/interruptByParent', {
      childSessionId: call.sessionId,
      parentSessionId: roots[0].sessionId,
      mode: 'continuable',
    });
  else if (action === 'cancel')
    // Foreground native child is owned by the parent's tool-call signal.
    // Cancelling that parent propagates to the actual child; never claim a
    // continuable interrupt can cancel a one-shot foreground child.
    await rpc('session/cancel', { request: { sessionId: roots[0].sessionId } });
  else
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
  const audit = auditFor(final, call, continuable);
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
  const result = final.results.find((row) => row.callId === call.callId);
  if (continuable && action === 'reject') assert.equal(result.isError, true, 'child learns of it');
  return { final, audit, file, dispatch, panelKey, pendingShot };
}

/** Auto/Yolo: the real write runs without any native question. */
async function observeUnattended(context, call, label) {
  const { browser, control, evidenceDirectory } = context;
  const pendingShot = join(evidenceDirectory, `${label}-pending.png`);
  await captureSettledScreenshot(browser.page, pendingShot);
  const final = await waitStatus(
    control,
    (facts) => facts.results.some((row) => row.callId === call.callId),
    `${label}-unattended-result`,
  );
  const file = final.files.find((row) => row.callId === call.callId);
  const dispatch = final.dispatch.filter((row) => row.callId === call.callId);
  assert.equal(dispatch.length, 1);
  assert.equal(final.results.find((row) => row.callId === call.callId).isError, false);
  assertNeverAsked(final, call.sessionId, 'no native question under this tier');
  assert.equal(
    await evaluate(browser.page, `document.querySelectorAll(${JSON.stringify(PANEL)}).length`),
    0,
    'no approval panel under this tier',
  );
  return { final, audit: null, file, dispatch, panelKey: null, pendingShot };
}

const rootTurns = (facts, root) =>
  facts.audit.filter((event) => event.sessionId === root.sessionId && event.type === 'turn/start')
    .length;
const rootDispatch = (facts, root) =>
  facts.dispatch.filter((row) => row.sessionId === root.sessionId).length;
const rootBaseline = (control, root) => {
  const facts = control({ op: 'status' });
  return { turns: rootTurns(facts, root), dispatch: rootDispatch(facts, root) };
};

/** Child Activation release wakes the root once (subagent-settled), without tools. */
async function settleContinuable(context, call, expected, label) {
  const { control, roots } = context;
  const final = await waitStatus(
    control,
    (facts) =>
      facts.sessions.find((row) => row.sessionId === call.sessionId)?.status === 'disposed' &&
      rootStatus(facts, roots[0])?.status === 'idle' &&
      rootTurns(facts, roots[0]) >= expected.turns,
    `${label}-subagent-settled-wake-up`,
  );
  assert.equal(rootTurns(final, roots[0]), expected.turns, 'exactly one settled wake-up turn');
  assert.equal(rootDispatch(final, roots[0]), expected.dispatch, 'wake-up turn runs no tool');
  assertNeverAsked(final, roots[0].sessionId, PARENT_ASKED);
  return final;
}

function assertSettledEffects(final, call, nonce, allowed, childDispatch, reviews) {
  const file = final.files.find((row) => row.callId === call.callId);
  assert.equal(file.exists, allowed, 'file effect after the settle window');
  if (allowed) assert.deepEqual([file.base64, file.bytes], [BASE64, Buffer.byteLength(TEXT)]);
  assert.equal(
    final.dispatch.filter((row) => row.sessionId === call.sessionId).length,
    childDispatch,
    'no child tools/execute beyond the authorized writes',
  );
  assert.equal(final.reviews.filter((row) => row.nonce === nonce).length, reviews);
}

/** Follow-up in the CHILD's composer cold-resumes it under its own recorded tier. */
async function resumeChild(context, call, nonce, label) {
  const { browser, control, roots, report, evidenceDirectory } = context;
  await openRoot(context);
  await waitComposer(browser.page, MS);
  await selectTier(browser.page, 'Yolo', join(evidenceDirectory, `${label}-root-yolo.png`), report);
  await commitRootTier(context, 'Yolo', label);
  await openChild(context, call, `${context.suite.title} child allow ${nonce}`);
  await waitComposer(browser.page, MS);
  const baseline = rootBaseline(control, roots[0]);
  const next = randomUUID();
  const resumed = await sendTurn(context, `child reject ${next}`, next, `${label}-resumed`);
  assert.equal(resumed.sessionId, call.sessionId, 'the follow-up must reach the same child');
  const facts = control({ op: 'status' });
  const rows = facts.children.filter((row) => row.sessionId === call.sessionId);
  assert.equal(rows.length, 2, 'one agent/created row per residency');
  const { source, mode, tier, policy } = rows[1];
  assert.deepEqual(
    { source, mode, tier, policy },
    { source: 'resume', mode: 'continuable', tier: 'approval', policy: 'ask' },
    'resume keeps the child-recorded tier',
  );
  const delegations = facts.delegations.filter((row) => row.sessionId === call.sessionId);
  assert(
    delegations.length === 2 && delegations.every((row) => row.local && row.provider === 'spawn'),
  );
  const answered = await answerApproval(context, resumed, 'reject', `${label}-resumed`);
  const final = await settleContinuable(
    context,
    resumed,
    { turns: baseline.turns + 1, dispatch: baseline.dispatch },
    `${label}-resumed`,
  );
  assertSettledEffects(final, resumed, next, false, 1, 0);
  assert.equal(rootStatus(final, roots[0]).tier, 'danger-full-access', 'root keeps its own tier');
  return { call: resumed, children: rows, audit: answered.audit, file: answered.file, final };
}

async function runApprovalScenario(context, scenario) {
  const { browser, control, roots, report, evidenceDirectory, persist, continuable } = context;
  const { scope, action, tier } = scenario;
  const nonce = randomUUID();
  const label = continuable ? `continuable-${scenario.name}` : `${scope}-${action}`;
  if (scope === 'delegate' || action !== 'reject') await openRoot(context);
  await waitComposer(browser.page, MS);
  if (tier) {
    await selectTier(browser.page, tier, join(evidenceDirectory, `${label}-tier.png`), report);
    await commitRootTier(context, tier, label);
  }
  const baseline = continuable ? rootBaseline(control, roots[0]) : null;
  const call = await sendTurn(context, `${scope} ${action} ${nonce}`, nonce, label);
  if (scope === 'delegate') await selectChild(context, call, action, nonce, label, scenario.child);
  const settled = scenario.unattended
    ? await observeUnattended(context, call, label)
    : await answerApproval(context, call, action, label);
  let final = settled.final;
  let resumed;
  if (continuable) {
    final = await settleContinuable(
      context,
      call,
      { turns: baseline.turns + 2, dispatch: baseline.dispatch + 1 },
      label,
    );
    const allowed = action === 'allow';
    assertSettledEffects(final, call, nonce, allowed, allowed ? 1 : 0, scenario.reviews ?? 0);
    if (scenario.resume) ({ final, ...resumed } = await resumeChild(context, call, nonce, label));
  } else await waitRootIdle(context, `${label}-real-parent-turn-idle`);
  const doneShot = join(evidenceDirectory, `${label}-settled.png`);
  await captureSettledScreenshot(browser.page, doneShot);
  report.scenarios.push({
    scope,
    action,
    ...(continuable ? { name: scenario.name, tier: tier ?? '人工批准', resumed } : {}),
    call,
    audit: settled.audit,
    file: settled.file,
    dispatch: settled.dispatch,
    panelKey: settled.panelKey,
    panelDisappeared: settled.panelKey !== null,
    pendingScreenshot: settled.pendingShot,
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
export async function runPermissionBrowserScenario(
  lifecycle,
  { runtime, evidenceDirectory, suite },
) {
  assert.equal(runtime.kind, 'docker-isolated-network', 'isolated browser runtime is required');
  const { mode } = suite;
  await mkdir(evidenceDirectory, { recursive: true });
  const report = {
    status: 'RUNNING',
    runId: lifecycle.runId,
    imageId: lifecycle.imageId,
    source: 'owned-protocol-not-real-model',
    mode,
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
    web = await prepareWeb(lifecycle, name, report, suite.overlay);
    lifecycle.registerContainer(name);
    const startup = JSON.parse(await runWebStartup(lifecycle.command, web));
    report.startup = startup;
    const [logs, announced] = [command(['logs', name]), startup.announcedHost];
    const { origin, cookie } = await qualifyHostSession(startup.hostPort, logs, announced);
    const rpc = async (method, args) => {
      const result = await mappedRpc(origin, cookie, method, args);
      assert.equal(result.ok, true, `oracle-rpc-${method.replaceAll('/', '-')}`);
      return result.value;
    };
    profile = await mkdtemp(join(tmpdir(), suite.chrome));
    browser = await openMappedPage({
      origin,
      cookie,
      extraFlags: mappedFlags(HOST),
      composition: true,
      runtime,
      profile: join(profile, 'profile'),
      receiptFile: join(profile, 'chrome.receipt.json'),
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
      suite.title,
    );
    const context = {
      browser,
      control,
      rpc,
      roots,
      report,
      evidenceDirectory,
      persist,
      suite,
      continuable: mode === 'continuable',
    };
    for (const scenario of suite.scenarios) await runApprovalScenario(context, scenario);
    assert.equal(browser.errors.length, 0, 'zero new console errors');
    report.consoleErrors = [...browser.errors];
    report.status = 'PASS';
    report.limits = suite.limits;
    await persist();
    return JSON.stringify({
      status: report.status,
      runId: lifecycle.runId,
      scenarios: report.scenarios.length,
      evidence: join(evidenceDirectory, 'evidence.json'),
    });
  } catch (error) {
    await retainPageRequestFailure(browser?.page, join(evidenceDirectory, 'startup.png'));
    await persistFailure(error, browser, web, control, report, evidenceDirectory, persist);
    throw new Error('ui-oracle-failed-see-evidence', { cause: error });
  } finally {
    try {
      if (browser) {
        disposeRequestEvidence(browser.page);
        try {
          browser.page.close();
        } finally {
          await browser.chrome.stop();
        }
      }
    } finally {
      if (profile) {
        await rescueChrome(join(profile, 'chrome.receipt.json'));
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
}

async function prepareWeb(lifecycle, name, report, overlayUser) {
  const providerSource = await readFile(
    new URL('./permission-browser-provider.mjs', import.meta.url),
    'utf8',
  );
  report.providerSha256 = createHash('sha256').update(providerSource).digest('hex');
  execScript(
    lifecycle,
    `${name}-install`,
    `import {writeFileSync,readFileSync,statSync} from 'node:fs'; import {createRequire} from 'node:module'; const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'); const versions=Object.fromEntries(['dsh','dsh-agent','dsh-llm','dsh-session','dsh-user-approval','dsh-subagent'].map(name=>[name,JSON.parse(readFileSync(require.resolve('@deepseek-ai/'+name+'/package.json'),'utf8')).version])); for(const version of Object.values(versions))if(version!=='0.2.1-rc.2')throw new Error('Pinned release mismatch'); const paths=['/opt','/opt/dsh-team','/opt/dsh-team/permission-tiers',${JSON.stringify(PLUGIN)}]; for(const path of paths){const stat=statSync(path);if(stat.uid!==0||(stat.mode&0o022)!==0)throw new Error('Immutable plugin ownership mismatch');} writeFileSync('/data/home/issue83-ui-owned-protocol.mjs',${JSON.stringify(providerSource)},{mode:0o400}); process.stdout.write(JSON.stringify({versions,pluginPath:${JSON.stringify(PLUGIN)},rootOwned:true}));`,
  );
  const composition = await collectComposition(lifecycle, `${name}-composition`);
  const generated = generateManagedConfig({
    ...composition,
    admin: false,
    instanceAddress: WEB_CONTAINER_ADDRESS,
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
    overlayUser,
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

async function verifySessionSelections(
  browser,
  control,
  rpc,
  origin,
  report,
  evidenceDirectory,
  titlePrefix,
) {
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
    const title = `${titlePrefix} browser root ${index + 1}`;
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
  await openRoot({ browser, roots, report });
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
  await openRoot({ browser, roots, report });
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
  const { browser, control, evidenceDirectory, report } = context;
  const scalar = (value) =>
    typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)
      ? value
      : value === undefined
        ? 'undefined'
        : 'unsupported';
  const observeAssertion = (id, actual, expected, message) => {
    report.pendingAssertion = {
      id,
      actual: scalar(actual),
      expected: scalar(expected),
      callId: call.callId,
      sessionId: call.sessionId,
    };
    assert.equal(actual, expected, message);
    delete report.pendingAssertion;
  };
  const targetExpression = `document.body.innerText.includes(${JSON.stringify(call.path.split('/').at(-1))})`;
  // Pending interactions and selected-session history load independently.
  // Wait for both visible surfaces within the original single readiness budget.
  const panelKey = await waitFor(
    () =>
      evaluate(
        browser.page,
        `(${targetExpression}) && document.querySelector(${JSON.stringify(PANEL)})?.getAttribute('data-approval-key')`,
      ),
    MS,
    `${label}-native-approval-panel`,
  );
  observeAssertion(
    'pending-panel-count',
    await evaluate(browser.page, `document.querySelectorAll(${JSON.stringify(PANEL)}).length`),
    1,
    'one native pending approval in the selected Session',
  );
  // Released ApprovalPanel's Tool-owned detail slot is optional. The write
  // target is rendered in the actual tool timeline, not inside that panel.
  observeAssertion(
    'pending-write-target',
    await evaluate(browser.page, targetExpression),
    true,
    'native tool timeline must identify this exact pending write',
  );
  const pending = control({ op: 'status' });
  if (context.continuable) {
    // ChildApprovalPanel shares data-approval-key; only the native panel may answer.
    observeAssertion(
      'pending-child-panel-absent',
      await evaluate(
        browser.page,
        `document.querySelectorAll(${JSON.stringify(CHILD_PANEL)}).length`,
      ),
      0,
      'continuable approval is answered by the native panel, not the read-only seat',
    );
    observeAssertion(
      'pending-child-running',
      pending.sessions.find((row) => row.sessionId === call.sessionId)?.status === 'running',
      true,
      'continuable child stays running while its approval is pending',
    );
  }
  observeAssertion(
    'pending-file-absent',
    pending.files.find((file) => file.callId === call.callId)?.exists,
    false,
    'real body must not run before browser approval',
  );
  observeAssertion(
    'pending-dispatch-count',
    pending.dispatch.filter((row) => row.callId === call.callId).length,
    0,
  );
  observeAssertion(
    'pending-audit-count',
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
